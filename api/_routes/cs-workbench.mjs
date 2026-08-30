/**
 * §2.4 工作台的两个页面、§2.10 的管理员监控、§2.13 的看板，共用这一个读接口。
 *
 * 为什么合成一个：三者读的是同一批行，只是筛选条件和聚合方式不同。拆成三个接口意味着「客服能看见
 * 哪些会话」这条判断要写三遍，而三遍里有一遍写松了就是一个客服能读到别人会话的洞。
 *
 * 会话列表里带上用户的显示名。那需要读 auth.users，而浏览器读不到——这是这个接口存在的另一个理由。
 */

import { RANK, bodyOf, requireUser, send } from '../_lib/server.mjs'
import { CHANNELS, isHeartbeatStale, sessionMetrics, servesChannel } from '../../shared/cs.mjs'
import { CS_SETTING_KEYS, settingsOf } from '../_lib/cs.mjs'

const SESSION_COLUMNS = 'id,channel,user_id,order_id,agent_id,status,subject,admin_mode,admin_id,' +
  'first_response_seconds,timed_out,last_user_message_at,last_agent_message_at,last_activity_at,' +
  'reopened_count,opened_at,closed_at,close_reason,created_at'

/**
 * 给一批会话补上用户名和最后一条消息。
 *
 * 逐个会话查一次是 N+1，在忙的时候就是几十次往返。这里按 id 批量查一次，然后在内存里归位。
 * 最后一条消息只取对客服可见的那些（visible_to_user 不筛，因为看的人是客服）。
 */
async function decorate(db, sessions) {
  if (!sessions?.length) return []
  const userIds = [...new Set(sessions.flatMap(s => [s.user_id, s.agent_id]).filter(Boolean))]
  const sessionIds = sessions.map(s => s.id)

  const [{ data: profiles }, { data: messages }, { data: unread }] = await Promise.all([
    db.from('user_profiles').select('user_id,display_name,group_name').in('user_id', userIds),
    db.from('cs_messages').select('session_id,body,sender_role,recalled,created_at')
      .in('session_id', sessionIds).order('created_at', { ascending: false }).limit(sessionIds.length * 4),
    db.from('cs_messages').select('session_id')
      .in('session_id', sessionIds).eq('sender_role', 'user').is('read_by_agent_at', null)
  ])

  const nameOf = {}
  for (const p of profiles || []) nameOf[p.user_id] = p.display_name || ''
  const groupOf = {}
  for (const p of profiles || []) groupOf[p.user_id] = p.group_name || 'default'

  const last = {}
  for (const m of messages || []) if (!last[m.session_id]) last[m.session_id] = m
  const unreadCount = {}
  for (const m of unread || []) unreadCount[m.session_id] = (unreadCount[m.session_id] || 0) + 1

  return sessions.map(s => ({
    ...s,
    user_name: nameOf[s.user_id] || '',
    agent_name: s.agent_id ? (nameOf[s.agent_id] || '') : '',
    agent_group: s.agent_id ? (groupOf[s.agent_id] || '') : '',
    last_message: last[s.id]
      // 撤回的那条不该在列表预览里露出原文——那是 §2.11 最容易漏的一处。
      ? { body: last[s.id].recalled ? '[已撤回]' : String(last[s.id].body || '').slice(0, 120),
          sender_role: last[s.id].sender_role, created_at: last[s.id].created_at }
      : null,
    unread_from_user: unreadCount[s.id] || 0
  }))
}

/**
 * §2.4 第一页：待接入的队列。
 *
 * 只给自己服务的渠道。admin 看全部（他能接任何会话），presale 只看售前——否则一个售前客服会看到
 * 一堆自己点不动的会话。blind 的排除掉：那些已经由管理员接管。
 */
export async function listQueue(db, auth) {
  const channels = CHANNELS.filter(c => servesChannel(auth.group, c))
  if (channels.length === 0) return { status: 403, body: { error: '当前用户组不服务任何渠道' } }

  const { data, error } = await db.from('cs_sessions').select(SESSION_COLUMNS)
    .eq('status', 'open').is('agent_id', null).in('channel', channels)
    .neq('admin_mode', 'blind')
    .order('created_at', { ascending: true }).limit(100)
  if (error) throw new Error(`读取队列失败：${error.message}`)
  return { status: 200, body: { sessions: await decorate(db, data) } }
}

/** §2.4 第二页：我手上的会话。 */
export async function listMine(db, auth, input = {}) {
  const includeClosed = Boolean(input.include_closed)
  let query = db.from('cs_sessions').select(SESSION_COLUMNS).eq('agent_id', auth.userId)
  if (!includeClosed) query = query.eq('status', 'open')
  const { data, error } = await query.order('last_activity_at', { ascending: false }).limit(100)
  if (error) throw new Error(`读取我的会话失败：${error.message}`)
  return { status: 200, body: { sessions: await decorate(db, data) } }
}

/** §2.10：管理员看全部会话，可按渠道、状态、客服筛。 */
export async function listAll(db, auth, input = {}) {
  if (auth.rank < RANK.ADMIN) return { status: 403, body: { error: '只有管理员可以查看全部会话' } }
  let query = db.from('cs_sessions').select(SESSION_COLUMNS)
  if (input.channel && CHANNELS.includes(String(input.channel))) query = query.eq('channel', String(input.channel))
  if (input.status === 'open' || input.status === 'closed') query = query.eq('status', String(input.status))
  if (input.agent_id) query = query.eq('agent_id', String(input.agent_id))
  if (input.unassigned) query = query.is('agent_id', null)
  const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500)
  const { data, error } = await query.order('last_activity_at', { ascending: false }).limit(limit)
  if (error) throw new Error(`读取会话列表失败：${error.message}`)
  return { status: 200, body: { sessions: await decorate(db, data) } }
}

/**
 * §2.3 的在线名单。给管理员看谁在线、谁手上几个，也给客服自己看自己的状态。
 *
 * 心跳过期的人在这里显示为「掉线」而不是在线：online 列可能还是 true（浏览器被直接关掉，来不及发
 * 那次下线请求），而按那个值分配会话就是把会话分给一个不在的人。
 */
export async function listAgents(db, auth) {
  if (auth.rank < RANK.STAFF) return { status: 403, body: { error: '无权查看客服列表' } }
  const settings = await settingsOf(db, CS_SETTING_KEYS)
  const timeout = Number(settings.cs_heartbeat_timeout_seconds) || 90

  const [{ data: agents, error }, { data: openRows }] = await Promise.all([
    db.from('cs_agents').select('user_id,online,last_heartbeat,max_concurrent,status_note,updated_at'),
    db.from('cs_sessions').select('agent_id').eq('status', 'open')
  ])
  if (error) throw new Error(`读取客服列表失败：${error.message}`)

  const load = {}
  for (const r of openRows || []) if (r.agent_id) load[r.agent_id] = (load[r.agent_id] || 0) + 1
  const ids = (agents || []).map(a => a.user_id)
  const { data: profiles } = ids.length
    ? await db.from('user_profiles').select('user_id,display_name,group_name').in('user_id', ids)
    : { data: [] }
  const profileOf = {}
  for (const p of profiles || []) profileOf[p.user_id] = p

  const rows = (agents || []).map(a => {
    const stale = isHeartbeatStale(a.last_heartbeat, timeout)
    return {
      user_id: a.user_id,
      display_name: profileOf[a.user_id]?.display_name || '',
      group: profileOf[a.user_id]?.group_name || 'default',
      // online 是「他说自己在线」，effective_online 是「他真的在」。分配用后者。
      online: a.online, heartbeat_stale: stale, effective_online: Boolean(a.online) && !stale,
      last_heartbeat: a.last_heartbeat,
      // 括号必须有：?? 和 || 混用不加括号是 SyntaxError，而分组也只能是这一种——0 是
      // 「暂时不接新会话」，落到 || 左边会被换成 5。
      max_concurrent: a.max_concurrent ?? (Number(settings.cs_max_concurrent_default) || 5),
      max_concurrent_explicit: a.max_concurrent !== null && a.max_concurrent !== undefined,
      load: load[a.user_id] || 0, status_note: a.status_note
    }
  })
  // 客服自己只看得到在线状态汇总，看不到别人的负载和备注——那是排班信息。
  if (auth.rank < RANK.ADMIN) {
    return {
      status: 200,
      body: {
        agents: rows.filter(r => r.user_id === auth.userId),
        online_count: rows.filter(r => r.effective_online).length
      }
    }
  }
  return { status: 200, body: { agents: rows, online_count: rows.filter(r => r.effective_online).length } }
}

/**
 * §2.13 看板：响应率与超时率。
 *
 * 分母是「区间内建立的所有会话」，包括一直没人回的那些。用「有过回复的会话」当分母会让这个数字
 * 永远接近 100%——而这个看板的全部意义就是暴露没人回的那些。
 */
export async function dashboard(db, auth, input = {}) {
  if (auth.rank < RANK.ADMIN) return { status: 403, body: { error: '只有管理员可以查看看板' } }
  const days = Math.min(Math.max(Number(input.days) || 30, 1), 365)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  const { data: sessions, error } = await db.from('cs_sessions')
    .select('id,channel,agent_id,status,first_response_seconds,timed_out,created_at')
    .gte('created_at', since).limit(5000)
  if (error) throw new Error(`读取看板数据失败：${error.message}`)

  const all = sessions || []
  const byChannel = {}
  for (const channel of CHANNELS) {
    byChannel[channel] = sessionMetrics(all.filter(s => s.channel === channel))
  }
  // 按客服拆一份。谁的超时率高是排班问题，看总数看不出来。
  const byAgent = {}
  for (const s of all) {
    if (!s.agent_id) continue
    ;(byAgent[s.agent_id] ||= []).push(s)
  }
  const agentIds = Object.keys(byAgent)
  const { data: profiles } = agentIds.length
    ? await db.from('user_profiles').select('user_id,display_name').in('user_id', agentIds)
    : { data: [] }
  const nameOf = {}
  for (const p of profiles || []) nameOf[p.user_id] = p.display_name || ''

  return {
    status: 200,
    body: {
      since, days,
      overall: sessionMetrics(all),
      by_channel: byChannel,
      by_agent: agentIds.map(id => ({
        user_id: id, display_name: nameOf[id] || '', ...sessionMetrics(byAgent[id])
      })).sort((a, b) => b.total - a.total),
      // 排队中的会话数是「现在」的事实，不属于区间统计，但看板上要它——没人回的会话正在积压时，
      // 一个按 30 天平均的数字看起来完全正常。
      queued_now: all.filter(s => s.status === 'open' && !s.agent_id).length
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
  const auth = await requireUser(req, res, RANK.STAFF)
  if (!auth) return
  const caller = { db: auth.db, userId: auth.user.id, group: auth.group, rank: auth.rank }
  try {
    const input = req.method === 'GET' ? (req.query || {}) : await bodyOf(req)
    const actions = {
      queue: () => listQueue(auth.db, caller),
      mine: () => listMine(auth.db, caller, input),
      all: () => listAll(auth.db, caller, input),
      agents: () => listAgents(auth.db, caller),
      dashboard: () => dashboard(auth.db, caller, input)
    }
    const run = actions[String(input?.view || input?.action || 'queue')]
    if (!run) return send(res, 400, { error: `view 必须是 ${Object.keys(actions).join('/')}` })
    const { status, body } = await run()
    return send(res, status, body)
  } catch (error) {
    console.error('cs-workbench 失败', error)
    return send(res, 500, { error: error.message })
  }
}
