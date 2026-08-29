import { bodyOf, RANK, requireUser, send } from './_lib/server.mjs'

// Ordered by §6's priority, lowest first, because the admin UI renders this array as-is.
const GROUPS = ['default', 'read', 'coworker', 'presale', 'postsale', 'cs', 'admin']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EVIDENCE_BUCKET = 'refund-evidence'
const PERMANENT_BAN = '876000h'

export const isBanned = (until) => Boolean(until) && (String(until).startsWith('infinity') || Date.parse(until) > Date.now())
const unwrap = ({ data, error }) => { if (error) throw new Error(error.message); return data }

async function listAuthUsers(db) {
  const users = []
  for (let page = 1; page <= 50; page += 1) {
    const { users: batch } = unwrap(await db.auth.admin.listUsers({ page, perPage: 200 }))
    users.push(...batch)
    if (batch.length < 200) break
  }
  return users
}
async function countByUser(db, table) {
  const counts = new Map()
  for (const { user_id } of unwrap(await db.from(table).select('user_id'))) counts.set(user_id, (counts.get(user_id) ?? 0) + 1)
  return counts
}
const adminIds = async (db) => unwrap(await db.from('user_profiles').select('user_id').eq('group_name', 'admin')).map((row) => row.user_id)

// Refuse any change that could leave /admin with no way back in, self-inflicted lockouts included.
async function lockoutGuard(db, actorId, targetId) {
  if (targetId === actorId) return '不能对当前登录的管理员账号执行该操作'
  const admins = await adminIds(db)
  if (admins.includes(targetId) && admins.length <= 1) return '这是唯一的管理员账号，移除后将无人能进入后台'
  return null
}
async function purgeEvidence(db, userId) {
  const listed = await db.storage.from(EVIDENCE_BUCKET).list(userId, { limit: 1000 })
  const paths = (listed.data ?? []).map((file) => `${userId}/${file.name}`)
  if (!paths.length) return 0
  const removed = await db.storage.from(EVIDENCE_BUCKET).remove(paths)
  return removed.error ? 0 : paths.length
}

async function overview(db, actorId) {
  const [authUsers, profileResult, orders, refunds] = await Promise.all([
    listAuthUsers(db),
    db.from('user_profiles').select('user_id,email,display_name,group_name,github_login,github_synced_at'),
    countByUser(db, 'orders'),
    countByUser(db, 'refund_requests')
  ])
  const profileOf = new Map(unwrap(profileResult).map((row) => [row.user_id, row]))
  const users = authUsers.map((user) => {
    const profile = profileOf.get(user.id)
    return {
      user_id: user.id,
      email: user.email ?? profile?.email ?? '',
      display_name: profile?.display_name ?? '',
      github_login: profile?.github_login || user.user_metadata?.user_name || user.user_metadata?.preferred_username || '',
      github_synced_at: profile?.github_synced_at ?? null,
      group_name: profile?.group_name ?? 'default',
      profile_missing: !profile,
      providers: user.app_metadata?.providers ?? (user.app_metadata?.provider ? [user.app_metadata.provider] : []),
      email_confirmed: Boolean(user.email_confirmed_at ?? user.confirmed_at),
      banned: isBanned(user.banned_until),
      created_at: user.created_at,
      last_sign_in_at: user.last_sign_in_at ?? null,
      orders: orders.get(user.id) ?? 0,
      refunds: refunds.get(user.id) ?? 0,
      self: user.id === actorId
    }
  })
  users.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  return { users, admins: users.filter((user) => user.group_name === 'admin').length }
}

export default async function handler(req, res) {
  const session = await requireUser(req, res, RANK.ADMIN)
  if (!session) return
  const { user: actor, db } = session
  try {
    if (req.method === 'GET') return send(res, 200, await overview(db, actor.id))
    const body = await bodyOf(req)
    const target = String(body.user_id ?? '')
    if (!UUID.test(target)) return send(res, 400, { error: '缺少合法的 user_id' })

    if (req.method === 'PATCH') {
      if (!GROUPS.includes(body.group_name)) return send(res, 400, { error: `用户组必须是 ${GROUPS.join(' / ')}` })
      if (body.group_name !== 'admin') {
        const blocked = await lockoutGuard(db, actor.id, target)
        if (blocked) return send(res, 409, { error: blocked })
      }
      unwrap(await db.from('user_profiles').upsert({ user_id: target, group_name: body.group_name }, { onConflict: 'user_id' }))
      return send(res, 200, { ok: true, group_name: body.group_name })
    }
    if (req.method === 'POST') {
      if (body.action !== 'ban' && body.action !== 'unban') return send(res, 400, { error: 'action 必须是 ban 或 unban' })
      if (body.action === 'ban') {
        const blocked = await lockoutGuard(db, actor.id, target)
        if (blocked) return send(res, 409, { error: blocked })
      }
      unwrap(await db.auth.admin.updateUserById(target, { ban_duration: body.action === 'ban' ? PERMANENT_BAN : 'none' }))
      return send(res, 200, { ok: true, banned: body.action === 'ban' })
    }
    if (req.method === 'DELETE') {
      const blocked = await lockoutGuard(db, actor.id, target)
      if (blocked) return send(res, 409, { error: blocked })
      const [orderResult, refundResult] = await Promise.all([
        db.from('orders').select('id', { count: 'exact', head: true }).eq('user_id', target),
        db.from('refund_requests').select('id', { count: 'exact', head: true }).eq('user_id', target)
      ])
      unwrap(orderResult)
      unwrap(refundResult)
      const orders = orderResult.count ?? 0
      const refunds = refundResult.count ?? 0
      if ((orders || refunds) && body.cascade !== true)
        return send(res, 409, { error: `该账号有 ${orders} 条订单、${refunds} 条退款记录，orders 与 refund_requests 是 on delete restrict；勾选“连带删除交易记录”后再试`, orders, refunds })
      if (refunds) unwrap(await db.from('refund_requests').delete().eq('user_id', target))
      if (orders) unwrap(await db.from('orders').delete().eq('user_id', target))
      const files = await purgeEvidence(db, target)
      unwrap(await db.auth.admin.deleteUser(target))
      return send(res, 200, { ok: true, deleted: { orders, refunds, files } })
    }
    return send(res, 405, { error: 'Method not allowed' })
  } catch (error) { return send(res, 500, { error: error.message }) }
}
