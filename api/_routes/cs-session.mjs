/**
 * §2 会话的生命周期：开、接、关、重开、管理员介入。
 *
 * 为什么这些动作走接口而不是让浏览器直接写 cs_sessions：RLS 能决定「你能不能看见这一行」，
 * 不能决定「你只能改这几列」。放开 UPDATE 给客服，就等于允许一个客服把 agent_id 改成别人、
 * 把 admin_id 抹掉把管理员踢出去、把 first_response_seconds 抹掉让自己的看板变好看，
 * 或者给自己刷一个满分评价。这里由服务端决定每个动作改哪几列。
 *
 * 读取仍然走浏览器直连（cs_sessions_read 那条策略 + Realtime 订阅），因为 §7 要求实时，
 * 而会话行里没有需要脱敏的列。
 */

import { RANK, bodyOf, rankOf, requireUser, send } from '../_lib/server.mjs'
import {
  ADMIN_MODES, ADMIN_MODE_LABEL, CHANNELS, normalizeRating, RATING_RANGE, sessionCapabilities
} from '../../shared/cs.mjs'
import {
  CS_SETTING_KEYS, assignAgent, closeSessionTimedOut, decorateSession, deliverAutoReply,
  insertMessage, logEvent, settingsOf, staffMayServe
} from '../_lib/cs.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SESSION_COLUMNS = 'id,channel,user_id,order_id,agent_id,status,subject,admin_mode,admin_id,' +
  'rating,rating_comment,rated_at,' +
  'first_response_seconds,timed_out,last_user_message_at,last_agent_message_at,last_activity_at,' +
  'reopened_count,opened_at,closed_at,closed_by,close_reason,created_at,updated_at'

async function loadSession(db, id) {
  const { data, error } = await db.from('cs_sessions').select(SESSION_COLUMNS).eq('id', id).maybeSingle()
  if (error) throw new Error(`读取会话失败：${error.message}`)
  return data || null
}

/**
 * 每一条「返回一个会话」的出口都走这里。
 *
 * 两件事必须同时发生：补显示名（用户要看到接待自己的客服叫什么，客服要看到用户叫什么，而两边的浏览器
 * 都被 profiles_read 挡在外面，见 _lib/cs.mjs 的 displayNames），以及算一遍 capabilities。漏掉其中一处的
 * 表现很具体——点完「接入」之后对面的称呼忽然退回「客服」，要等下一次拉取才恢复。
 */
async function sessionReply(db, auth, session, status = 200, extra = {}) {
  return {
    status,
    body: {
      ...extra,
      session: await decorateSession(db, session, { staff: rankOf(auth.group) >= RANK.STAFF }),
      capabilities: sessionCapabilities(session, auth)
    }
  }
}

/**
 * §2.1：开一个会话，或者把已有的那个还回去。
 *
 * 「一个用户同时只能有一个会话」（§2.6）的实现是 cs_one_open_session 那个唯一索引。这里先查一次是为了
 * 让重复点击拿到同一个会话而不是一句报错——用户在结算页和商品页各点一次客服按钮，期望是回到同一个对话。
 *
 * 售后必须带订单，且订单必须属于自己：不检查的话，任何人都能对别人的订单开一个售后会话，
 * 而那个会话的标题里会带上订单号。
 */
export async function openSession(db, auth, input) {
  const channel = String(input?.channel || '')
  if (!CHANNELS.includes(channel)) return { status: 400, body: { error: 'channel 只能是 presale 或 postsale' } }

  const orderId = input?.order_id ? String(input.order_id) : null
  if (channel === 'postsale') {
    if (!orderId || !UUID.test(orderId)) return { status: 400, body: { error: '售后会话必须带订单 ID' } }
    const { data: order, error } = await db.from('orders').select('id,user_id,sku_name,sku').eq('id', orderId).maybeSingle()
    if (error) throw new Error(`读取订单失败：${error.message}`)
    // 不区分「订单不存在」和「订单不是你的」：区分了就是一个能探测订单号是否存在的接口。
    if (!order || order.user_id !== auth.userId) return { status: 404, body: { error: '订单不存在，或不属于当前账户' } }
  } else if (orderId) {
    return { status: 400, body: { error: '售前会话不能绑定订单' } }
  }

  // 已有一个开着的就直接还回去。
  const existingQuery = db.from('cs_sessions').select(SESSION_COLUMNS)
    .eq('user_id', auth.userId).eq('channel', channel).eq('status', 'open')
  const { data: existing, error: existErr } = await (orderId
    ? existingQuery.eq('order_id', orderId) : existingQuery.is('order_id', null)).maybeSingle()
  if (existErr) throw new Error(`读取已有会话失败：${existErr.message}`)
  if (existing) {
    return sessionReply(db, auth, existing, 200, { created: false })
  }

  const settings = await settingsOf(db, CS_SETTING_KEYS)
  const agent = await assignAgent(db, channel, settings)

  const { data: session, error } = await db.from('cs_sessions').insert({
    channel, user_id: auth.userId, order_id: orderId,
    agent_id: agent?.user_id ?? null,
    subject: String(input?.subject || '').slice(0, 200)
  }).select(SESSION_COLUMNS).single()

  // 23505 只能是 cs_one_open_session：两次点击撞在一起了。输的那次把赢的那个会话读回来，
  // 答案和上面「已有一个」完全一样——用户不该看到一句「唯一约束冲突」。
  if (error?.code === '23505') {
    const retryQuery = db.from('cs_sessions').select(SESSION_COLUMNS)
      .eq('user_id', auth.userId).eq('channel', channel).eq('status', 'open')
    const { data: winner } = await (orderId ? retryQuery.eq('order_id', orderId) : retryQuery.is('order_id', null)).maybeSingle()
    if (winner) return sessionReply(db, auth, winner, 200, { created: false })
  }
  if (error) throw new Error(`创建会话失败：${error.message}`)

  await logEvent(db, session.id, agent ? 'assigned' : 'queued', auth, {
    channel, agent_id: agent?.user_id ?? null, agent_group: agent?.group ?? null
  })

  // §2.12：没有在线客服时给用户一句话，而不是让他对着空窗口等。
  if (!agent) {
    await insertMessage(db, session, {
      senderRole: 'system',
      body: String(settings.cs_no_agent_text || '当前客服均不在线，请留下您的问题。'),
      format: 'plain'
    })
  }
  // §3.3 的欢迎语。放在 no_agent 提示之后，顺序在界面上就是「客服不在线」+「请描述问题」。
  const welcome = await deliverAutoReply(db, session, { trigger: 'session_open', text: '' })
  if (!welcome && settings.cs_welcome_text) {
    await insertMessage(db, session, {
      senderId: agent?.user_id ?? null, senderRole: agent ? 'agent' : 'auto',
      body: String(settings.cs_welcome_text), format: 'plain', autoReply: true
    })
  }

  return sessionReply(db, auth, session, 201, { created: true })
}

/**
 * §2.12：客服从队列里接一个会话。
 *
 * 带 agent_id is null 的条件是这个动作的全部正确性：两个客服同时点「接入」，只有一个能拿到行。
 * 先查再更新的写法在这里会让两个人同时接到同一个会话，然后互相看着对方的回复。
 */
export async function claimSession(db, auth, sessionId) {
  if (!UUID.test(String(sessionId || ''))) return { status: 400, body: { error: 'session_id 必须是 UUID' } }
  const session = await loadSession(db, sessionId)
  if (!session) return { status: 404, body: { error: '会话不存在' } }
  if (!staffMayServe(auth, session.channel)) {
    return { status: 403, body: { error: '当前用户组不服务该渠道' } }
  }
  if (session.status !== 'open') return { status: 409, body: { error: '会话已关闭' } }
  // 这里曾经有一条「blind 模式下会话由管理员接管，别人不许接」。§2.10 简化成两种模式之后 blind 是默认值，
  // 那条判断会让每一个新会话都不许接——队列里看得见却点不动。介入现在只决定管理员署谁的名（见
  // shared/cs.mjs 的 ADMIN_MODES），不再是「接管」，所以接入这件事和它无关。

  // 并发上限在这里判。判在分配时（assignAgent）管的是自动分配，主动接入绕过那条路径，
  // 少了这一处，一个客服可以手动把自己接到二十个会话上。
  const settings = await settingsOf(db, CS_SETTING_KEYS)
  const [{ data: me }, { count: load }] = await Promise.all([
    db.from('cs_agents').select('max_concurrent').eq('user_id', auth.userId).maybeSingle(),
    db.from('cs_sessions').select('id', { count: 'exact', head: true }).eq('agent_id', auth.userId).eq('status', 'open')
  ])
  // 括号不是风格问题：?? 和 || 混用不加括号是 SyntaxError。而且这里的分组必须是这一种——
  // max_concurrent 为 0 的意思是「暂时不接新会话」，放到 || 的左边会被当成假值换成 5，
  // 于是一个刚点了「不再接入」的客服立刻又能被接进五个会话。
  const cap = me?.max_concurrent ?? (Number(settings.cs_max_concurrent_default) || 5)
  if ((load ?? 0) >= cap) {
    return { status: 409, body: { error: `已达到并发上限（${cap}），请先结束一个会话` } }
  }

  const { data: claimed, error } = await db.from('cs_sessions')
    .update({ agent_id: auth.userId, updated_at: new Date().toISOString() })
    .eq('id', sessionId).eq('status', 'open').is('agent_id', null)
    .select(SESSION_COLUMNS).maybeSingle()
  if (error) throw new Error(`接入会话失败：${error.message}`)
  if (!claimed) {
    const fresh = await loadSession(db, sessionId)
    // 自己已经是这个会话的客服：重复点击，当成成功。
    if (fresh?.agent_id === auth.userId) {
      return sessionReply(db, auth, fresh)
    }
    return { status: 409, body: { error: '会话已被其他客服接入' } }
  }

  await logEvent(db, sessionId, 'claimed', auth, { previous_agent: null })
  return sessionReply(db, auth, claimed)
}

/** §2.5：关闭会话。用户、接待客服、管理员都能关。 */
export async function closeSession(db, auth, sessionId, reason) {
  if (!UUID.test(String(sessionId || ''))) return { status: 400, body: { error: 'session_id 必须是 UUID' } }
  const session = await loadSession(db, sessionId)
  if (!session) return { status: 404, body: { error: '会话不存在' } }
  const caps = sessionCapabilities(session, auth)
  if (!caps.can_close) return { status: 403, body: { error: '无权关闭该会话' } }

  const now = new Date().toISOString()
  const { data: closed, error } = await db.from('cs_sessions')
    .update({
      status: 'closed', closed_at: now, closed_by: auth.userId,
      close_reason: String(reason || '').slice(0, 200), updated_at: now
    })
    .eq('id', sessionId).eq('status', 'open').select(SESSION_COLUMNS).maybeSingle()
  if (error) throw new Error(`关闭会话失败：${error.message}`)
  if (!closed) return { status: 409, body: { error: '会话已经是关闭状态' } }

  await logEvent(db, sessionId, 'closed', auth, { reason: String(reason || '') })
  // 谁关的，就署谁的身份。管理员在「管理员介入」下关会话要说「管理员已结束」——他这一路发言用的都是
  // 管理员名义，最后一句忽然变成「客服已结束」会让用户以为刚才说话的是两个人。反过来，「正常介入」
  // 下他借的是接待客服的名义，那就仍然说客服，否则介入本身在这一句里暴露了。
  const ghostWriting = session.admin_mode === 'normal' && Boolean(session.agent_id)
  const closer = caps.is_owner ? '用户'
    : (caps.is_admin && !caps.is_agent && !ghostWriting) ? '管理员' : '客服'
  await insertMessage(db, closed, {
    senderRole: 'system',
    body: `${closer}已结束本次会话。`,
    format: 'plain'
  })
  return sessionReply(db, auth, closed)
}

/**
 * §2.5：重开。要求「由同一个客服接回」。
 *
 * 重开的是同一行而不是新建一行：新建的话，对话历史会分裂成两个会话，而用户点开的是最新那个，
 * 于是客服看不到他三分钟前说过什么。
 *
 * 原客服现在离线怎么办：仍然重开，并把 agent_id 保留，然后走一次分配。分配不到人就进队列。
 * 直接失败是最差的选择——用户的问题没解决，而他唯一的入口报错。
 */
export async function reopenSession(db, auth, sessionId) {
  if (!UUID.test(String(sessionId || ''))) return { status: 400, body: { error: 'session_id 必须是 UUID' } }
  const session = await loadSession(db, sessionId)
  if (!session) return { status: 404, body: { error: '会话不存在' } }
  const caps = sessionCapabilities(session, auth)
  if (!caps.can_reopen) return { status: 403, body: { error: '无权重开该会话' } }
  if (session.status === 'open') {
    return sessionReply(db, auth, session)
  }

  // 同一个用户在同一个渠道上不能有第二个开着的会话。重开之前先看有没有——有的话把那个还回去，
  // 否则唯一索引会把这次重开变成一句 23505。
  const dupQuery = db.from('cs_sessions').select(SESSION_COLUMNS)
    .eq('user_id', session.user_id).eq('channel', session.channel).eq('status', 'open')
  const { data: dup } = await (session.order_id
    ? dupQuery.eq('order_id', session.order_id) : dupQuery.is('order_id', null)).maybeSingle()
  if (dup) return { status: 409, body: { error: '该渠道已有一个进行中的会话', session: dup } }

  const now = new Date().toISOString()
  let agentId = session.agent_id
  if (agentId) {
    // 原客服还在线且没满就接回给他（§2.5「由同一客服接回」）。
    const { data: agent } = await db.from('cs_agents').select('online').eq('user_id', agentId).maybeSingle()
    if (!agent?.online) agentId = null
  }
  if (!agentId) {
    const settings = await settingsOf(db, CS_SETTING_KEYS)
    const picked = await assignAgent(db, session.channel, settings)
    agentId = picked?.user_id ?? null
  }

  const { data: reopened, error } = await db.from('cs_sessions')
    .update({
      status: 'open', closed_at: null, closed_by: null, close_reason: '',
      agent_id: agentId, reopened_count: (session.reopened_count || 0) + 1,
      // 重开等于重新开始等待，所以首响清零、超时标记清掉。留着旧值的话，§2.13 会把一个
      // 「三天前回过、今天重开又没人理」的会话算成已响应。
      first_response_seconds: null, timed_out: false,
      last_activity_at: now, opened_at: now, updated_at: now
    })
    .eq('id', sessionId).eq('status', 'closed').select(SESSION_COLUMNS).maybeSingle()
  if (error) throw new Error(`重开会话失败：${error.message}`)
  if (!reopened) return { status: 409, body: { error: '会话状态已变化，请刷新后重试' } }

  await logEvent(db, sessionId, 'reopened', auth, {
    agent_id: agentId, same_agent: agentId === session.agent_id
  })
  return sessionReply(db, auth, reopened)
}

/**
 * §2.10：管理员切换介入模式。
 *
 * 两种模式的差别只有一处：管理员发言时署谁的名（见 shared/cs.mjs 的 ADMIN_MODES 与 cs-message 的
 * speakAsAgent）。可见性不再受它影响，private.can_see_session 里已经没有 admin_mode 了。
 *
 * admin_id 一律写成切换的人，不再有「清空」的分支：blind 是默认值，把它当成「没人介入」的话，
 * 每个新会话看起来都有一个管理员在旁边。真正的「有没有人介入」由 admin_id 是否为空表达。
 */
export async function setAdminMode(db, auth, sessionId, mode) {
  if (!UUID.test(String(sessionId || ''))) return { status: 400, body: { error: 'session_id 必须是 UUID' } }
  if (!ADMIN_MODES.includes(String(mode))) {
    return { status: 400, body: { error: `admin_mode 只能是 ${ADMIN_MODES.join('/')}` } }
  }
  if (rankOf(auth.group) < RANK.ADMIN) return { status: 403, body: { error: '只有管理员可以介入会话' } }

  const session = await loadSession(db, sessionId)
  if (!session) return { status: 404, body: { error: '会话不存在' } }

  const now = new Date().toISOString()
  const { data: updated, error } = await db.from('cs_sessions')
    .update({ admin_mode: mode, admin_id: auth.userId, updated_at: now })
    .eq('id', sessionId).select(SESSION_COLUMNS).maybeSingle()
  if (error) throw new Error(`切换介入模式失败：${error.message}`)

  await logEvent(db, sessionId, 'admin_mode', auth, { from: session.admin_mode, to: mode })
  // 介入本身对用户不可见（§2.10）：用户不该知道现在是管理员在替客服说话。留痕给客服和审计看。
  //
  // senderRole 是 'system' 而不是 'admin'：这条留痕不是谁「说」的话，它是会话状态的一次变更。写成 admin
  // 加上 sender_id=管理员自己的话，管理员自己打开这个会话时会看到一条署名「我」的气泡——而那句话的内容
  // 是在讲他自己刚做的操作。系统提示这一栏才是它该在的位置。
  await insertMessage(db, session, {
    senderRole: 'system',
    body: `管理员将介入模式切换为「${ADMIN_MODE_LABEL[mode] || mode}」。`,
    format: 'plain', visibleToUser: false
  })
  return sessionReply(db, auth, updated)
}

/**
 * §2.14：会话结束后用户给这次服务打分（0~5）和留一句话。
 *
 * 三条限制，每条都在 update 的 where 里而不是只在前面判一次：只有会话本人（eq user_id）、只有已关闭的
 * 会话（eq status）、只能打一次（is rated_at null）。前面那三个 if 只是为了给出人话的错误信息；真正
 * 拦住并发重复提交的是那三个条件——两次点击撞在一起时，第二次拿不到行。
 *
 * 为什么允许 0 分：0 和「没评价」是两件事，前者是一个明确的差评。rated_at 才是「评过没有」的判据，
 * 用 rating 是否为空来判会让 0 分永远可以被覆盖掉。
 *
 * 分数不进 cs_session_events 的 detail 之外的任何统计表：§2.13 的看板要按客服聚合平均分时直接读
 * cs_sessions.rating，多存一份就多一处会和它对不上的地方。
 */
export async function rateSession(db, auth, input) {
  const sessionId = String(input?.session_id || '')
  if (!UUID.test(sessionId)) return { status: 400, body: { error: 'session_id 必须是 UUID' } }
  const rating = normalizeRating(input?.rating)
  if (rating === null) {
    return { status: 400, body: { error: `评分必须是 ${RATING_RANGE[0]}~${RATING_RANGE[1]} 的整数` } }
  }
  const comment = String(input?.comment ?? '').slice(0, 500)

  const session = await loadSession(db, sessionId)
  if (!session) return { status: 404, body: { error: '会话不存在' } }
  if (session.user_id !== auth.userId) return { status: 403, body: { error: '只有会话本人可以评价' } }
  if (session.status !== 'closed') return { status: 409, body: { error: '会话结束后才能评价' } }
  if (session.rated_at) return { status: 409, body: { error: '这次会话已经评价过了' } }

  const now = new Date().toISOString()
  const { data: rated, error } = await db.from('cs_sessions')
    .update({ rating, rating_comment: comment, rated_at: now, updated_at: now })
    .eq('id', sessionId).eq('user_id', auth.userId).eq('status', 'closed').is('rated_at', null)
    .select(SESSION_COLUMNS).maybeSingle()
  if (error) throw new Error(`提交评价失败：${error.message}`)
  if (!rated) return { status: 409, body: { error: '会话状态已变化，请刷新后重试' } }

  await logEvent(db, sessionId, 'rated', auth, { rating, has_comment: Boolean(comment) })
  // 评价写成对用户不可见的一条记录：客服该知道自己被打了几分，但用户不需要在自己的聊天记录里
  // 再看到一遍刚填的东西——那条消息在他眼里只会像一次莫名的回声。
  await insertMessage(db, rated, {
    senderRole: 'system', visibleToUser: false, format: 'plain',
    body: `用户对本次会话评分 ${rating} 分${comment ? `，留言：${comment}` : ''}。`
  })
  return sessionReply(db, auth, rated)
}

/** §2.3：客服上下线与心跳。手动切换和自动离线走同一个入口。 */
export async function setPresence(db, auth, input) {
  if (rankOf(auth.group) < RANK.STAFF) return { status: 403, body: { error: '只有客服可以设置在线状态' } }
  const now = new Date().toISOString()
  const patch = { user_id: auth.userId, updated_at: now }
  // online 缺省时只更新心跳（前端定时器打的那种），不改在线状态——把心跳和手动开关混成一个字段的话，
  // 一次心跳会把手动设为离线的客服拉回在线。
  if (input?.online !== undefined) patch.online = Boolean(input.online)
  if (input?.status_note !== undefined) patch.status_note = String(input.status_note).slice(0, 200)
  if (input?.max_concurrent !== undefined) {
    const n = Number(input.max_concurrent)
    if (input.max_concurrent !== null && (!Number.isInteger(n) || n < 0)) {
      return { status: 400, body: { error: 'max_concurrent 必须是非负整数或 null' } }
    }
    patch.max_concurrent = input.max_concurrent === null ? null : n
  }
  if (patch.online !== false) patch.last_heartbeat = now

  const { data, error } = await db.from('cs_agents')
    .upsert(patch, { onConflict: 'user_id' }).select().single()
  if (error) throw new Error(`更新客服状态失败：${error.message}`)
  return { status: 200, body: { agent: data } }
}

/**
 * §2.5 的超时清理。给定时任务用，也允许管理员手动触发一次。
 *
 * 一次处理一批，扫的是「开着且最后活动早于阈值」的会话。两个渠道的阈值不同，所以分两次查——
 * 一次查回来在 JS 里筛的话，得把所有开着的会话都拉回来，而那在忙的时候是几千行。
 */
export async function sweepIdleSessions(db, auth, { now = new Date(), limit = 200 } = {}) {
  if (rankOf(auth.group) < RANK.ADMIN) return { status: 403, body: { error: '只有管理员可以触发超时清理' } }
  const settings = await settingsOf(db, CS_SETTING_KEYS)
  const closed = []

  for (const channel of CHANNELS) {
    const minutes = Number(channel === 'postsale'
      ? settings.cs_timeout_postsale_minutes : settings.cs_timeout_presale_minutes) || 0
    if (minutes <= 0) continue
    const cutoff = new Date(now.getTime() - minutes * 60 * 1000).toISOString()
    const { data: stale, error } = await db.from('cs_sessions').select(SESSION_COLUMNS)
      .eq('status', 'open').eq('channel', channel).lt('last_activity_at', cutoff).limit(limit)
    if (error) throw new Error(`读取超时会话失败：${error.message}`)
    for (const session of stale || []) {
      const done = await closeSessionTimedOut(db, session, settings)
      if (done) closed.push(done.id)
    }
  }
  return { status: 200, body: { closed_count: closed.length, closed } }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return
  const caller = { db: auth.db, userId: auth.user.id, group: auth.group }
  try {
    const input = await bodyOf(req)
    const actions = {
      open: () => openSession(auth.db, caller, input),
      claim: () => claimSession(auth.db, caller, input.session_id),
      close: () => closeSession(auth.db, caller, input.session_id, input.reason),
      reopen: () => reopenSession(auth.db, caller, input.session_id),
      admin_mode: () => setAdminMode(auth.db, caller, input.session_id, input.admin_mode),
      rate: () => rateSession(auth.db, caller, input),
      presence: () => setPresence(auth.db, caller, input),
      sweep: () => sweepIdleSessions(auth.db, caller, {})
    }
    const run = actions[String(input?.action || '')]
    if (!run) return send(res, 400, { error: `action 必须是 ${Object.keys(actions).join('/')}` })
    const { status, body } = await run()
    return send(res, status, body)
  } catch (error) {
    console.error('cs-session 失败', error)
    return send(res, 500, { error: error.message })
  }
}
