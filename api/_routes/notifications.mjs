/**
 * §9 的站内信收件箱：列表、已读、归档。
 *
 * 一个接口带 action 分支，而不是四个文件。这几件事共用同一段「这条通知你看不看得见」的判定，而那段
 * 判定是唯一一处会造成隐私泄露的地方——分成四份必然有一份写得不一样，而写错的那一份不会报错，
 * 只是让某个人看到了别人的收件箱。
 *
 * 关于可见性为什么要在 JS 里再判一遍：schema.sql 里有 private.can_see_notification()，但 RLS 只在
 * 用户自己的 token 下生效，而 requireUser 交出来的是 service client（它要读 user_profiles 判组）。
 * service client 绕过所有策略。所以这里每一条路径都必须过 canSeeNotification()。
 *
 * 未读数为什么不能只查 notification_receipts：广播通知在没人碰过之前根本没有 receipt 行。
 * 「未读」的定义是「可见 且（没有 receipt 行 或 read_at 为空）」，前一半只能从 notifications 那边来。
 * 只查 receipts 的结果是未读数恒为 0——而那正好是最不容易被注意到的错误方向。
 */

import {
  broadcastScopesFor, canSeeNotification, presentationFor
} from '../../shared/notifications.mjs'
import { bodyOf, requireUser, send } from '../_lib/server.mjs'
import { isUuid } from '../_lib/refunds.mjs'
import { setting } from '../_lib/notify.mjs'

const MAX_PAGE = 100

/**
 * or 条件是拼出来的字符串，所以拼进去的东西必须先确认形状。
 *
 * caller.userId 来自 auth.getUser()，今天一定是 uuid。但 PostgREST 的 or 语法用逗号分隔条件、
 * 用括号分组，一个带逗号或右括号的值能改写整条过滤器——那是可见性判定，被改写等于泄露。
 * 这一步在正常情况下永远不会触发，它的作用是让「将来某天 userId 换成别的东西」变成一个报错而不是
 * 一次静默的越权。
 */
const filterSafe = v => /^[0-9a-fA-F-]{36}$/.test(String(v || ''))

/**
 * 列表。默认按「置顶优先、再按时间倒序」排，因为 §9.6 要求待审批的一直挡在眼前，包括已经读过的。
 *
 * 归档过的默认不出现（§9.8 的手动归档就是为了让收件箱能清空），带 archived=true 时单独看。
 */
export async function listNotifications(db, caller, query = {}) {
  if (!filterSafe(caller.userId)) return { status: 400, body: { error: '会话异常，请重新登录' } }
  const scopes = broadcastScopesFor(caller.rank)
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), MAX_PAGE)
  const before = typeof query.before === 'string' && query.before ? query.before : null

  // 一次查询取「发给我的」和「我这个 rank 能看的广播」。or 里的 scope 列表来自 broadcastScopesFor，
  // 不是手写字符串——手写的那份会在某天加一个新范围时被漏掉，而漏掉的方向是看不见（安全），
  // 多写一个的方向是泄露，所以这份列表必须只有一个来源。
  let q = db.from('notifications')
    .select('id,kind,title,body,format,scope,recipient_id,actions,state,pinned,highlighted,order_id,refund_id,session_id,attachments,created_at,updated_at')
    .or(`recipient_id.eq.${caller.userId},scope.in.(${scopes.join(',')})`)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit)
  if (before) q = q.lt('created_at', before)

  const { data: rows, error } = await q
  if (error) return { status: 500, body: { error: '读取站内信失败' } }

  const list = rows || []
  // 上面那个 or 已经把范围收窄了，但它是拼出来的字符串。再过一遍 canSeeNotification：如果哪天
  // 拼串出了错（比如 scope 列表为空导致 in.() 语法退化），这一步会把它挡住，而不是让它泄露出去。
  const visible = list.filter(n => canSeeNotification(n, caller.userId, caller.rank))

  const ids = visible.map(n => n.id)
  let receipts = []
  if (ids.length) {
    const { data, error: rErr } = await db.from('notification_receipts')
      .select('notification_id,read_at,archived_at,dwell_ms')
      .eq('user_id', caller.userId).in('notification_id', ids)
    if (rErr) return { status: 500, body: { error: '读取已读状态失败' } }
    receipts = data || []
  }
  const byId = new Map(receipts.map(r => [r.notification_id, r]))

  const wantArchived = query.archived === true || query.archived === 'true'
  const items = visible
    .map(n => {
      const r = byId.get(n.id)
      return {
        ...n,
        read: Boolean(r?.read_at),
        read_at: r?.read_at ?? null,
        archived: Boolean(r?.archived_at),
        archived_at: r?.archived_at ?? null,
        // 置顶和高亮不直接返回库里的值，而是重算一遍。库里那两列是插入时算的，而 settleApproval
        // 处理完之后会把它们收掉——重算能让一条状态已经变了但列没更新到的通知也表现正确。
        ...presentationFor(n)
      }
    })
    .filter(n => n.archived === wantArchived)

  return {
    status: 200,
    body: {
      items,
      unread: items.filter(n => !n.read).length,
      // 还有没有下一页看返回条数，而不是再查一次 count。count 在这里要多一次全表扫描，
      // 而收件箱是每次进页面都要拉的。
      has_more: list.length === limit,
      next_before: items.length ? items[items.length - 1].created_at : null
    }
  }
}

/**
 * 未读数。单独一条路径是因为角标要在每一页上显示，而列表接口会拉正文和附件。
 *
 * 这里不做分页，但要有上限：一个从没清过收件箱的管理员可能有几千条，而角标显示「99+」就够了。
 */
export async function unreadCount(db, caller) {
  if (!filterSafe(caller.userId)) return { status: 400, body: { error: '会话异常，请重新登录' } }
  const scopes = broadcastScopesFor(caller.rank)
  const { data: rows, error } = await db.from('notifications')
    .select('id,scope,recipient_id,state,actions')
    .or(`recipient_id.eq.${caller.userId},scope.in.(${scopes.join(',')})`)
    .order('created_at', { ascending: false })
    .limit(500)
  if (error) return { status: 500, body: { error: '读取站内信失败' } }

  const visible = (rows || []).filter(n => canSeeNotification(n, caller.userId, caller.rank))
  const ids = visible.map(n => n.id)
  let seen = new Set()
  let archived = new Set()
  if (ids.length) {
    const { data, error: rErr } = await db.from('notification_receipts')
      .select('notification_id,read_at,archived_at')
      .eq('user_id', caller.userId).in('notification_id', ids)
    if (rErr) return { status: 500, body: { error: '读取已读状态失败' } }
    for (const r of data || []) {
      if (r.read_at) seen.add(r.notification_id)
      if (r.archived_at) archived.add(r.notification_id)
    }
  }
  const open = visible.filter(n => !archived.has(n.id))
  return {
    status: 200,
    body: {
      unread: open.filter(n => !seen.has(n.id)).length,
      // 待处理的单独给一个数：§9.6 的置顶事项和「有几条没读」是两件事，一个管理员可能全读过了
      // 但还有三条等他批。角标只显示未读数的话，那三条不会再提醒任何人。
      pending: open.filter(n => n.state === 'pending').length
    }
  }
}

/**
 * §9.7 的未读→已读。两条触发路径（点击、停留 2 秒）都落到这里，dwell_ms 记的是哪一条。
 *
 * upsert 而不是先查后插：广播通知在第一次被读之前没有 receipt 行，而「有没有行」这个判断和插入
 * 之间有一个两个请求都能穿过的缝。主键是 (notification_id, user_id)，冲突时更新即可。
 */
export async function markRead(db, caller, input) {
  const ids = Array.isArray(input?.ids) ? input.ids : [input?.id]
  const wanted = ids.filter(id => isUuid(id))
  if (!wanted.length) return { status: 400, body: { error: '请指定要标记的站内信' } }
  if (wanted.length > MAX_PAGE) return { status: 400, body: { error: `一次最多标记 ${MAX_PAGE} 条` } }

  // 先确认这些通知这个人看得见。不确认的话，任何人都能把别人收件箱里的通知标成已读——
  // 那不只是越权写入，还会让对方永远收不到那条提醒。
  const { data: rows, error } = await db.from('notifications')
    .select('id,scope,recipient_id').in('id', wanted)
  if (error) return { status: 500, body: { error: '读取站内信失败' } }
  const allowed = (rows || []).filter(n => canSeeNotification(n, caller.userId, caller.rank)).map(n => n.id)
  if (!allowed.length) return { status: 404, body: { error: '站内信不存在' } }

  const dwell = Number.isInteger(input?.dwell_ms) && input.dwell_ms >= 0 ? input.dwell_ms : 0
  const now = new Date().toISOString()
  const { error: upErr } = await db.from('notification_receipts')
    .upsert(allowed.map(id => ({
      notification_id: id, user_id: caller.userId, read_at: now, dwell_ms: dwell
    })), { onConflict: 'notification_id,user_id' })
  if (upErr) return { status: 500, body: { error: '标记已读失败' } }

  return {
    status: 200,
    body: {
      marked: allowed.length,
      // 请求里有几条是看不见的（或不存在的）如实告知，但不说是哪几条——那会变成一个探测接口。
      skipped: wanted.length - allowed.length
    }
  }
}

/**
 * §9.8 的手动归档。
 *
 * 待处理的不许归档。§9.6 要求它一直挡在眼前，而归档正好是「让它不再挡在眼前」——允许归档等于给
 * 了一个绕过强制置顶的办法，而那条通知代表的是一笔等着人批的退款。
 */
export async function archiveNotifications(db, caller, input) {
  const ids = Array.isArray(input?.ids) ? input.ids : [input?.id]
  const wanted = ids.filter(id => isUuid(id))
  if (!wanted.length) return { status: 400, body: { error: '请指定要归档的站内信' } }
  if (wanted.length > MAX_PAGE) return { status: 400, body: { error: `一次最多归档 ${MAX_PAGE} 条` } }

  const { data: rows, error } = await db.from('notifications')
    .select('id,scope,recipient_id,state').in('id', wanted)
  if (error) return { status: 500, body: { error: '读取站内信失败' } }
  const visible = (rows || []).filter(n => canSeeNotification(n, caller.userId, caller.rank))
  if (!visible.length) return { status: 404, body: { error: '站内信不存在' } }

  const undo = input?.undo === true
  const blocked = visible.filter(n => n.state === 'pending')
  if (blocked.length && !undo) {
    return {
      status: 409,
      body: {
        error: '待处理的站内信不能归档，请先处理',
        pending: blocked.length
      }
    }
  }

  const now = new Date().toISOString()
  const { error: upErr } = await db.from('notification_receipts')
    .upsert(visible.map(n => ({
      notification_id: n.id,
      user_id: caller.userId,
      archived_at: undo ? null : now
    })), { onConflict: 'notification_id,user_id' })
  if (upErr) return { status: 500, body: { error: undo ? '取消归档失败' : '归档失败' } }

  return { status: 200, body: { archived: undo ? 0 : visible.length, restored: undo ? visible.length : 0 } }
}

/**
 * §14 里和收件箱有关的几个配置。
 *
 * read_dwell_ms 必须由服务端给：§9.7 的「停留 2 秒算已读」是可配的，而那个判定发生在浏览器里。
 * 前端写死 2000 的话，管理员改了配置也不会生效，而配置项界面上却显示改成功了。
 */
export async function inboxSettings(db) {
  return {
    status: 200,
    body: {
      auto_archive_days: await setting(db, 'notification_auto_archive_days', 30),
      read_dwell_ms: await setting(db, 'notification_read_dwell_ms', 2000),
      // 两个独立开关，不是一个「方式」字段：§14 的两条 seed 是分开的，而它们可以同时开。
      notify_browser: await setting(db, 'notification_notify_browser', true),
      notify_email: await setting(db, 'notification_notify_email', false)
    }
  }
}

export default async function handler(req, res) {
  // 收件箱对任何登录用户开放，看到什么由 canSeeNotification 决定，不由 rank 门槛决定。
  const auth = await requireUser(req, res, 0)
  if (!auth) return
  const caller = { userId: auth.user.id, group: auth.group, rank: auth.rank }

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost')
    const view = url.searchParams.get('view')
    if (view === 'unread') return sendAnswer(res, await unreadCount(auth.db, caller))
    if (view === 'settings') return sendAnswer(res, await inboxSettings(auth.db))
    return sendAnswer(res, await listNotifications(auth.db, caller, {
      limit: url.searchParams.get('limit'),
      before: url.searchParams.get('before'),
      archived: url.searchParams.get('archived')
    }))
  }

  if (req.method === 'POST') {
    const input = await bodyOf(req)
    const action = String(input?.action || '')
    if (action === 'read') return sendAnswer(res, await markRead(auth.db, caller, input))
    if (action === 'archive') return sendAnswer(res, await archiveNotifications(auth.db, caller, input))
    return send(res, 400, { error: 'action 只能是 read 或 archive' })
  }

  return send(res, 405, { error: 'Method not allowed' })
}

const sendAnswer = (res, answer) => send(res, answer.status, answer.body)
