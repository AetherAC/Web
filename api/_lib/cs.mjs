/**
 * 会话的服务端共用逻辑：设置读取、分配、事件记录、自动回复投递。
 *
 * 为什么单独一层：这些步骤被好几个接口按不同顺序用到。开会话要「分配 + 记事件 + 发欢迎语」，
 * 发消息要「记活动 + 首响计时 + 关键词自动回复」，超时清理要「关会话 + 发两份文案 + 记事件」。
 * 每个接口各写一遍的结果是首响时间在一条路径上被记、在另一条路径上被忘，而那个看板的数字
 * 从此只能用来看趋势不能用来看真相。
 */

import { RANK, rankOf } from '../../shared/groups.mjs'
import {
  ATTACHMENT_BUCKET, MAX_ATTACHMENTS, MESSAGE_MAX_CHARS, checkAttachmentSize,
  pickAgent, pickAutoReply, servesChannel, timeoutTextKeys, uploadLimits
} from '../../shared/cs.mjs'

/** 一次取多个配置项。site_settings 的值是 { value: ... } 形状的 jsonb。 */
export async function settingsOf(db, keys) {
  const { data, error } = await db.from('site_settings').select('key,value').in('key', keys)
  if (error) throw new Error(`读取站点配置失败：${error.message}`)
  const out = {}
  for (const row of data || []) out[row.key] = row.value?.value
  return out
}

export const CS_SETTING_KEYS = [
  'cs_max_concurrent_default', 'cs_heartbeat_timeout_seconds', 'cs_activity_basis',
  'cs_typing_trigger', 'cs_timeout_presale_minutes', 'cs_timeout_postsale_minutes',
  'cs_no_agent_text', 'cs_welcome_text', 'cs_allow_html', 'cs_allow_bbcode',
  // §4.5/§4.6 的三档限额。发消息那条路径要用它们判真实大小，所以必须和其余键一起取回来——
  // 漏掉它们的表现是 schema 里写着「分类型的限额由 API 判」而 API 从没读到过那三个值。
  'cs_upload_max_image_mb', 'cs_upload_max_file_mb', 'cs_upload_max_video_mb'
]

/**
 * §4.5/§4.6 的真实大小判定。
 *
 * 为什么要单独走一趟 storage：浏览器直传到桶里，字节从不经过这个函数所在的进程，所以请求体里的
 * size 是用户自己写的数字。桶上那个 100MB 的 file_size_limit 是唯一被强制执行的东西，而需求要的是
 * 图片 10 / 文件 25 / 视频 100 三档。唯一能问到真实大小的地方就是对象自己的 metadata。
 *
 * 问不到（对象不存在、storage 出错）时拒绝而不是放行：放行意味着「让 storage 报一次错」就能绕过上限。
 * 代价是 storage 抖动时发不出带附件的消息，那时用户能重试或者先把文字发出去。
 */
export async function verifyAttachments(db, attachments, limits) {
  if (!attachments?.length) return { ok: true }
  if (!db?.storage?.from) {
    // 没有 storage 客户端就没有可信来源。这里返回 false 而不是 true：一个拼错的客户端初始化
    // 不该表现为「上限静默失效」。
    return { ok: false, error: '无法校验附件大小，请稍后重试' }
  }
  const bucket = db.storage.from(ATTACHMENT_BUCKET)
  for (const item of attachments) {
    const slash = item.path.lastIndexOf('/')
    const dir = item.path.slice(0, slash)
    const name = item.path.slice(slash + 1)
    // list 而不是 download：download 会把整个文件拉进函数内存，一个 100MB 的视频足够打爆
    // 一次 serverless 调用，而我们只要一个数字。
    const { data, error } = await bucket.list(dir, { limit: 100, search: name })
    if (error) {
      console.error('附件大小校验失败', { path: item.path, error: error.message })
      return { ok: false, error: '无法校验附件大小，请稍后重试' }
    }
    const found = (data || []).find(o => o.name === name)
    if (!found) return { ok: false, error: '附件尚未上传完成，请稍后重试' }
    const bytes = found.metadata?.size
    const verdict = checkAttachmentSize(item.kind, bytes, limits)
    if (!verdict.ok) {
      // 超限的对象留在桶里是垃圾，而且它已经占了空间。删掉再报错——删失败只记日志，
      // 因为「消息没发出去」这个结果已经正确了。
      const { error: rmErr } = await bucket.remove([item.path])
      if (rmErr) console.error('超限附件清理失败', { path: item.path, error: rmErr.message })
      return verdict
    }
    // 回写真实大小：界面上那个「12.4 MB」应该来自对象本身，而不是上传时前端报的数字。
    item.size = Number(bytes)
  }
  return { ok: true }
}

/**
 * 浏览器要用到、但读不到的那部分配置。
 *
 * site_settings 上只有一条 admin 全权策略，普通用户 select 回来是空数组——所以输入框该不该允许
 * HTML、附件多大算超限，这些必须由接口给出。前端硬编码一份的表现是管理员改了后台而输入框行为不变。
 */
export function clientConfig(settings) {
  return {
    allow_html: settings.cs_allow_html === true,
    allow_bbcode: settings.cs_allow_bbcode !== false,
    typing_trigger: settings.cs_typing_trigger || 'keypress',
    upload_limit_mb: uploadLimits(settings),
    message_max_chars: MESSAGE_MAX_CHARS,
    max_attachments: MAX_ATTACHMENTS,
    // 前端拿它显示「N 分钟无消息将自动关闭」。用户看得到这个数字，就不会把自动关闭当成掉线。
    timeout_minutes: {
      presale: Number(settings.cs_timeout_presale_minutes) || 30,
      postsale: Number(settings.cs_timeout_postsale_minutes) || 60
    },
    mutable_window_ms: 2 * 60 * 1000
  }
}

/**
 * 记一条会话事件（§2.10 的介入、§2.12 的分配、§2.5 的开关）。
 *
 * 写失败只记 stderr。事件是审计，不是业务前置条件——因为写不进一条「已分配」就把分配回滚掉，
 * 意味着一个日志表的故障会让全站客服停摆。反过来的代价是审计缺一行，那是能查出来的（会话有客服
 * 但没有分配事件）。
 */
export async function logEvent(db, sessionId, kind, actor, detail = {}) {
  const { error } = await db.from('cs_session_events').insert({
    session_id: sessionId, kind,
    actor_id: actor?.userId ?? null, actor_group: actor?.group ?? '',
    detail
  })
  if (error) console.error('cs_session_events 写入失败', { session: sessionId, kind, error: error.message })
}

/**
 * 找一个能接这个会话的客服。
 *
 * 负载是「这个人手上还开着几个会话」，要现算——存一个计数列的话，它和真实会话数不一致只是时间问题
 * （关会话的路径不止一条），而不一致的后果是有人被分到第八个会话，或者有人一直分不到。
 */
export async function assignAgent(db, channel, settings) {
  const [{ data: agents, error: agentErr }, { data: openRows, error: loadErr }] = await Promise.all([
    db.from('cs_agents').select('user_id,online,max_concurrent,last_heartbeat'),
    db.from('cs_sessions').select('agent_id').eq('status', 'open')
  ])
  if (agentErr) throw new Error(`读取客服状态失败：${agentErr.message}`)
  if (loadErr) throw new Error(`读取会话负载失败：${loadErr.message}`)

  const load = {}
  for (const row of openRows || []) if (row.agent_id) load[row.agent_id] = (load[row.agent_id] || 0) + 1

  // 组名在 user_profiles 里，cs_agents 上故意没存——存两份必然有一天不一致，而不一致的方向是
  // 「一个已经被降权的人还在接会话」。
  const ids = (agents || []).map(a => a.user_id)
  if (ids.length === 0) return null
  const { data: profiles, error: profErr } = await db.from('user_profiles').select('user_id,group_name').in('user_id', ids)
  if (profErr) throw new Error(`读取客服用户组失败：${profErr.message}`)
  const groupOf = {}
  for (const p of profiles || []) groupOf[p.user_id] = p.group_name || 'default'

  const candidates = (agents || []).map(a => ({
    user_id: a.user_id, group: groupOf[a.user_id] || 'default',
    online: a.online, max_concurrent: a.max_concurrent,
    last_heartbeat: a.last_heartbeat, load: load[a.user_id] || 0
  }))
  return pickAgent(candidates, channel, {
    defaultMaxConcurrent: Number(settings.cs_max_concurrent_default) || 5
  })
}

/**
 * 插一条消息。所有消息都从这里走——用户发的、客服发的、系统提示、自动回复。
 *
 * 集中在一处的理由是 §3.3 那条要求：自动回复挂在客服名下但不计入响应时间。那意味着「写消息」和
 * 「更新会话上的响应时间」必须是同一个动作里的两步，分开写就会有一条路径忘记其中一步。
 */
export async function insertMessage(db, session, {
  senderId, senderRole, body, format = 'markdown', attachments = [],
  autoReply = false, autoReplyRuleId = null, authoredBy = null, visibleToUser = true
}) {
  const { data, error } = await db.from('cs_messages').insert({
    session_id: session.id, sender_id: senderId ?? null, sender_role: senderRole,
    body, format, attachments,
    auto_reply: autoReply, auto_reply_rule_id: autoReplyRuleId,
    authored_by: authoredBy, visible_to_user: visibleToUser
  }).select().single()
  if (error) throw new Error(`写入消息失败：${error.message}`)
  return data
}

/**
 * 一条消息发出之后要在会话行上更新的东西。
 *
 * 首响时间只在满足三个条件时记：这条是客服/管理员发的、不是自动回复、会话还没有首响记录。
 * 少了「不是自动回复」那一条，一句「您好，请稍等」会让每个会话的首响都变成零点几秒，
 * 于是 §2.13 那个看板再也测不出任何东西——这是这个函数存在的主要理由。
 */
export function sessionTouchFor(session, message, now = new Date()) {
  const patch = { last_activity_at: now.toISOString(), updated_at: now.toISOString() }
  const fromStaff = message.sender_role === 'agent' || message.sender_role === 'admin'

  if (message.sender_role === 'user') patch.last_user_message_at = now.toISOString()
  if (fromStaff) patch.last_agent_message_at = now.toISOString()

  if (fromStaff && !message.auto_reply && session.first_response_seconds === null) {
    // 从会话建立算起，不是从「用户最后一条消息」算起：用户等的是第一次有人理他。
    const opened = new Date(session.opened_at || session.created_at).getTime()
    if (Number.isFinite(opened)) {
      patch.first_response_seconds = Math.max(0, Math.round((now.getTime() - opened) / 1000))
    }
  }
  return patch
}

export async function touchSession(db, session, message, now = new Date()) {
  const patch = sessionTouchFor(session, message, now)
  const { error } = await db.from('cs_sessions').update(patch).eq('id', session.id)
  if (error) console.error('会话状态回写失败', { session: session.id, error: error.message })
  return patch
}

/**
 * §3：挑一条自动回复并发出去。返回发出的消息或 null。
 *
 * 发给谁：sender 是会话当前的客服。没有客服时（还没分配到人）仍然发，sender_id 为 null、
 * sender_role 用 'auto'——用户在等待分配时收到一句「已收到，正在为您接入客服」是这条需求的主要场景，
 * 而那时恰好没有客服可挂。
 */
export async function deliverAutoReply(db, session, { trigger, text }) {
  const { data: rules, error } = await db.from('cs_auto_replies')
    .select('id,enabled,trigger,channel,keywords,match_mode,body,format,once_per_session,priority,created_at')
    .eq('enabled', true).eq('trigger', trigger)
  if (error) {
    console.error('读取自动回复规则失败', { session: session.id, error: error.message })
    return null
  }
  if (!rules?.length) return null

  // once_per_session 要知道这个会话已经发过哪些规则。只查自动回复那几行，不是整个会话的消息。
  const { data: sentRows } = await db.from('cs_messages')
    .select('auto_reply_rule_id').eq('session_id', session.id).eq('auto_reply', true)
  const rule = pickAutoReply(rules, {
    trigger, channel: session.channel, text,
    alreadySentRuleIds: (sentRows || []).map(r => r.auto_reply_rule_id).filter(Boolean)
  })
  if (!rule) return null

  const message = await insertMessage(db, session, {
    senderId: session.agent_id ?? null,
    // 挂在客服名下（§3.3），所以有客服时用 'agent'。没有客服时用 'auto'，因为 sender_role='agent'
    // 加 sender_id=null 在界面上会显示成一个没有名字的客服。
    senderRole: session.agent_id ? 'agent' : 'auto',
    body: rule.body, format: rule.format,
    autoReply: true, autoReplyRuleId: rule.id
  })
  // 自动回复也算活动（它确实让会话动了一下），但不记首响——sessionTouchFor 靠 auto_reply 标记区分。
  await touchSession(db, session, message)
  return message
}

/**
 * §2.5 超时关闭。给用户和客服各发一份文案（§2.9），并把 timed_out 标上供 §2.13 统计。
 *
 * 两条消息而不是一条：用户看到的那句是「已自动关闭，可以重新发起」，客服看到的那句还带着
 * 「已计入超时率」。合成一条就得二选一，而两边需要的信息不同。
 */
export async function closeSessionTimedOut(db, session, settings) {
  const keys = timeoutTextKeys(session.channel)
  const texts = await settingsOf(db, [keys.user, keys.agent])
  const now = new Date().toISOString()

  // 带 status='open' 的条件：同一时刻用户可能正在手动关闭，或另一个定时任务实例在做同样的事。
  // 拿不到行就说明别人赢了，那时不该再发一遍文案。
  const { data: closed, error } = await db.from('cs_sessions')
    .update({ status: 'closed', closed_at: now, close_reason: 'timeout', timed_out: true, updated_at: now })
    .eq('id', session.id).eq('status', 'open').select().maybeSingle()
  if (error) throw new Error(`关闭会话失败：${error.message}`)
  if (!closed) return null

  await insertMessage(db, session, {
    senderRole: 'system', body: String(texts[keys.user] || '会话已自动关闭。'), format: 'plain'
  })
  await insertMessage(db, session, {
    senderRole: 'system', body: String(texts[keys.agent] || '该会话因超时自动关闭。'), format: 'plain',
    // 客服那份对用户不可见——否则用户会看到「已计入超时率」这种内部口径。
    visibleToUser: false
  })
  await logEvent(db, session.id, 'timeout_closed', null, { channel: session.channel })
  return closed
}

/** 请求者能不能对这个会话行动。集中一处，免得每个接口各写一遍 rank 比较。 */
export function staffMayServe(auth, channel) {
  if (rankOf(auth.group) >= RANK.ADMIN) return true
  return rankOf(auth.group) >= RANK.STAFF && servesChannel(auth.group, channel)
}
