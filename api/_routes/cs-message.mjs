/**
 * §2/§4 的消息：发、撤回、编辑、读。
 *
 * 为什么读也走接口，而不是让浏览器直连 cs_messages：§2.11 要求撤回和编辑对用户和客服呈现不同的内容，
 * 而「不同的内容」不能靠前端筛。Realtime 推的是原始行，所以撤回时原文必须从行里搬走（搬去
 * cs_message_revisions），否则一个订阅了自己会话的用户能在推送里读回自己撤回的文本。
 *
 * 但这也意味着 Realtime 推来的那一行是残缺的（撤回的空壳、visible_to_user=false 的行看不见），
 * 前端收到推送后仍然要用这个接口拉一次。这是取舍：让前端拿到完整数据的唯一办法是让它有权读原文，
 * 那就等于没有撤回。
 */

import { RANK, bodyOf, rankOf, requireUser, send } from '../_lib/server.mjs'
import {
  MESSAGE_MAX_CHARS, prepareMessage, presentMessage, sessionCapabilities, uploadLimits
} from '../../shared/cs.mjs'
import {
  CS_SETTING_KEYS, clientConfig, decorateSession, deliverAutoReply, insertMessage, logEvent,
  settingsOf, touchSession, verifyAttachments
} from '../_lib/cs.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// §2.11 的编辑/撤回时限。写死而不是做成配置项：这个数字的作用是「对方大概还没看到」，
// 而那取决于人的反应速度，不取决于站点配置。做成配置项只会多一个没人会调的开关。
const MUTABLE_WINDOW_MS = 2 * 60 * 1000

const MESSAGE_COLUMNS = 'id,session_id,sender_id,sender_role,body,format,attachments,auto_reply,' +
  'auto_reply_rule_id,authored_by,visible_to_user,recalled,recalled_at,edited_at,edit_count,created_at'

// rating/rated_at 在这里看着与消息无关，但 sessionCapabilities 用 rated_at 判 can_rate，
// 而这个接口的响应里带着 capabilities——不取的话，用户关掉会话后打开对话框看到的是「还能评价」，
// 点下去才被 409 顶回来。
async function loadSession(db, id) {
  const { data, error } = await db.from('cs_sessions')
    .select('id,channel,user_id,order_id,agent_id,status,admin_mode,admin_id,' +
      'rating,rating_comment,rated_at,first_response_seconds,opened_at,created_at')
    .eq('id', id).maybeSingle()
  if (error) throw new Error(`读取会话失败：${error.message}`)
  return data || null
}

/**
 * 读一段消息。
 *
 * visible_to_user=false 的行（管理员介入提示、超时给客服的那份文案）在非 staff 那一侧要过滤掉。
 * 过滤放在查询里而不是查回来再筛：查回来再筛的话，那些行已经进了这个进程的内存，而下一个改这段
 * 代码的人很容易把它们带进响应。
 */
export async function listMessages(db, auth, input) {
  const sessionId = String(input?.session_id || '')
  if (!UUID.test(sessionId)) return { status: 400, body: { error: 'session_id 必须是 UUID' } }
  const session = await loadSession(db, sessionId)
  if (!session) return { status: 404, body: { error: '会话不存在' } }
  const caps = sessionCapabilities(session, auth)
  if (!caps.can_see) return { status: 403, body: { error: '无权查看该会话' } }

  const limit = Math.min(Math.max(Math.trunc(Number(input?.limit)) || 200, 1), 500)
  if (input?.after && !Number.isFinite(Date.parse(input.after))) return { status: 400, body: { error: 'Invalid message cursor' } }
  let query = db.from('cs_messages').select(MESSAGE_COLUMNS)
    .eq('session_id', sessionId).order('created_at', { ascending: Boolean(input?.after) }).order('id', { ascending: Boolean(input?.after) }).limit(limit)
  if (!caps.can_see_revisions) query = query.eq('visible_to_user', true)
  if (input?.after) query = query.gt('created_at', String(input.after))

  const { data: rows, error } = await query
  if (error) throw new Error(`读取消息失败：${error.message}`)

  // 只有 staff 那一侧才去查修订表，而且只在真有撤回/编辑过的消息时查——没有的话这是一次白跑的查询。
  let revisions = null
  if (caps.can_see_revisions && (rows || []).some(r => r.recalled || r.edited_at)) {
    const ids = (rows || []).filter(r => r.recalled || r.edited_at).map(r => r.id)
    const { data: revRows, error: revErr } = await db.from('cs_message_revisions')
      .select('message_id,kind,body,format,revision,created_at').in('message_id', ids)
    if (revErr) console.error('读取消息修订失败', { session: sessionId, error: revErr.message })
    revisions = revRows || []
  }

  // Initial refresh must show the latest window, not permanently stop at message 200.
  const chronological = input?.after ? (rows || []) : [...(rows || [])].reverse()
  const messages = chronological.map(row => presentMessage(
    row, auth, revisions ? revisions.filter(r => r.message_id === row.id) : null))
  // 这个接口是两侧唯一每次都会拉的东西（Realtime 推送之后前端也回到这里），所以显示名挂在它的响应上：
  // 用户要看到接待自己的客服叫什么，客服要看到用户叫什么，而两边的浏览器都被 profiles_read 挡在外面。
  const decorated = await decorateSession(db, session, { staff: rankOf(auth.group) >= RANK.STAFF })
  return { status: 200, body: { session: decorated, capabilities: caps, messages } }
}

/**
 * §2/§4：发一条消息。
 *
 * 客服身份的判定要注意一处：管理员在「正常介入」（normal）下发言时，消息以接待客服的名义发出，
 * 真实作者记在 authored_by 上——用户看到的对话要从头到尾是同一个人在回。「管理员介入」（blind）
 * 下他署自己的名，因为那时介入本身就是要让用户知道换了人。
 *
 * 两种模式都不影响谁能看见这个会话（§2.10 简化之后可见性和 admin_mode 无关），所以下面只有署名一处
 * 在读 admin_mode。
 */
export async function sendMessage(db, auth, input) {
  if (input?.client_message_id && !UUID.test(input.client_message_id)) return { status: 400, body: { error: 'Invalid message ID' } }
  const sessionId = String(input?.session_id || '')
  if (!UUID.test(sessionId)) return { status: 400, body: { error: 'session_id 必须是 UUID' } }
  const session = await loadSession(db, sessionId)
  if (!session) return { status: 404, body: { error: '会话不存在' } }
  const caps = sessionCapabilities(session, auth)
  if (!caps.can_post) {
    // 分开两种理由：会话关了是用户能自己解决的（重开），没权限不是。
    return session.status !== 'open'
      ? { status: 409, body: { error: '会话已关闭，请重新发起' } }
      : { status: 403, body: { error: '无权在该会话中发言' } }
  }

  const settings = await settingsOf(db, CS_SETTING_KEYS)
  const prepared = prepareMessage(
    { body: input?.body, format: input?.format, attachments: input?.attachments },
    {
      allowHtml: settings.cs_allow_html === true, allowBbcode: settings.cs_allow_bbcode !== false,
      // 路径的前两段钉在「这个会话」和「这个人」上。少了它，知道路径的人可以把别的会话的附件
      // 引用进自己的会话——storage 的读策略按第一段判可见性，那时第一段是别人的会话 id。
      sessionId, uploaderId: auth.userId
    }
  )
  if (!prepared.ok) return { status: 400, body: { error: prepared.error } }
  // 真实大小：浏览器直传，字节没经过这里，所以要去桶里问一次。
  const sized = await verifyAttachments(db, prepared.attachments, uploadLimits(settings))
  if (!sized.ok) return { status: 400, body: { error: sized.error } }

  const staff = rankOf(auth.group) >= RANK.STAFF
  const asAdmin = caps.is_admin && !caps.is_owner
  // 「正常介入」时管理员借接待客服的身份说话；「管理员介入」（blind）时署自己的名。
  // 没有接待客服可借的时候（会话还在队列里）也只能署自己的名。
  // 写成 === 'normal' 而不是 !== 'blind'：两种模式之外的任何值（旧库里遗留的 none/readonly）
  // 都该退到「署自己的名」这一侧，而不是悄悄借用客服的身份。
  const speakAsAgent = asAdmin && Boolean(session.agent_id) && session.admin_mode === 'normal'
  const senderRole = caps.is_owner ? 'user' : (speakAsAgent ? 'agent' : (asAdmin ? 'admin' : 'agent'))
  const senderId = speakAsAgent ? session.agent_id : auth.userId

  const message = await insertMessage(db, session, {
    id: input?.client_message_id,
    senderId, senderRole,
    body: prepared.body, format: prepared.format, attachments: prepared.attachments,
    authoredBy: senderId === auth.userId ? null : auth.userId
  })
  await touchSession(db, session, message)

  // §3.1 关键词自动回复：只对用户发的消息触发。客服说了「退款」不该弹一段退款说明给用户。
  let auto = null
  if (caps.is_owner) {
    try {
      auto = await deliverAutoReply(db, { ...session, agent_id: session.agent_id }, {
        trigger: 'keyword', text: prepared.body
      })
    } catch (error) {
      // The user's message is already committed. A failed bot reply must not invite duplicate sends.
      console.error('Auto reply failed after message commit', { session: session.id, message: message.id })
    }
  }

  return {
    status: 201,
    body: {
      message: presentMessage(message, auth, null),
      auto_reply: auto ? presentMessage(auto, auth, null) : null,
      // staff 那侧回一句真实作者，方便工作台标注；用户那侧 presentMessage 已经把它删了。
      authored_by: staff ? message.authored_by : undefined
    }
  }
}

/**
 * §2.11 撤回。原文搬到 cs_message_revisions，行里的 body 清空。
 *
 * 顺序是先写修订、再清 body。反过来的话，中间失败就是原文彻底没了——而这条要求的全部内容是
 * 「客服仍然看得到原文」。
 */
export async function recallMessage(db, auth, input) {
  const messageId = String(input?.message_id || '')
  if (!UUID.test(messageId)) return { status: 400, body: { error: 'message_id 必须是 UUID' } }
  const { data: message, error } = await db.from('cs_messages').select(MESSAGE_COLUMNS).eq('id', messageId).maybeSingle()
  if (error) throw new Error(`读取消息失败：${error.message}`)
  if (!message) return { status: 404, body: { error: '消息不存在' } }
  if (message.recalled) return { status: 200, body: { message: presentMessage(message, auth, null) } }

  const session = await loadSession(db, message.session_id)
  if (!session) return { status: 404, body: { error: '会话不存在' } }
  const caps = sessionCapabilities(session, auth)
  if (!caps.can_see) return { status: 403, body: { error: '无权操作该会话' } }
  // 只能撤自己发的。管理员也不例外——「管理员能撤客服的话」是另一个需求，这里没有。
  if (message.sender_id !== auth.userId) return { status: 403, body: { error: '只能撤回自己发送的消息' } }
  if (message.sender_role === 'system' || message.auto_reply) {
    return { status: 400, body: { error: '系统消息与自动回复不能撤回' } }
  }
  const age = Date.now() - new Date(message.created_at).getTime()
  if (!Number.isFinite(age) || age > MUTABLE_WINDOW_MS) {
    return { status: 409, body: { error: '超过 2 分钟的消息不能撤回' } }
  }

  // 附件也要一起搬走：下面那个更新把 attachments 清空了，不存进来的话客服看到的「原文」少了图片，
  // 而用户撤回的往往正是那张图片。
  const { error: revErr } = await db.from('cs_message_revisions').insert({
    message_id: messageId, session_id: session.id, kind: 'recall',
    body: message.body, format: message.format, attachments: message.attachments || [],
    revision: (message.edit_count || 0) + 1
  })
  if (revErr) throw new Error(`保存撤回原文失败：${revErr.message}`)

  const now = new Date().toISOString()
  const { data: updated, error: updErr } = await db.from('cs_messages')
    .update({ recalled: true, recalled_at: now, body: '', attachments: [] })
    .eq('id', messageId).eq('recalled', false).select(MESSAGE_COLUMNS).maybeSingle()
  if (updErr) throw new Error(`撤回消息失败：${updErr.message}`)
  if (!updated) return { status: 409, body: { error: '消息状态已变化，请刷新后重试' } }

  await logEvent(db, session.id, 'recalled', auth, { message_id: messageId })
  return { status: 200, body: { message: presentMessage(updated, auth, null) } }
}

/**
 * §2.11 编辑。旧版本存进修订表，客服看得到历史，用户看不到。
 *
 * revision 用 edit_count + 1 而不是查一次表里的最大值：并发编辑同一条自己的消息只会发生在同一个人
 * 开了两个标签页时，而下面那个带 edit_count 条件的更新会让输的那次拿不到行。
 */
export async function editMessage(db, auth, input) {
  const messageId = String(input?.message_id || '')
  if (!UUID.test(messageId)) return { status: 400, body: { error: 'message_id 必须是 UUID' } }
  const { data: message, error } = await db.from('cs_messages').select(MESSAGE_COLUMNS).eq('id', messageId).maybeSingle()
  if (error) throw new Error(`读取消息失败：${error.message}`)
  if (!message) return { status: 404, body: { error: '消息不存在' } }
  if (message.recalled) return { status: 409, body: { error: '已撤回的消息不能编辑' } }

  const session = await loadSession(db, message.session_id)
  if (!session) return { status: 404, body: { error: '会话不存在' } }
  const caps = sessionCapabilities(session, auth)
  if (!caps.can_post) return { status: 403, body: { error: '无权在该会话中发言' } }
  if (message.sender_id !== auth.userId) return { status: 403, body: { error: '只能编辑自己发送的消息' } }
  if (message.sender_role === 'system' || message.auto_reply) {
    return { status: 400, body: { error: '系统消息与自动回复不能编辑' } }
  }
  const age = Date.now() - new Date(message.created_at).getTime()
  if (!Number.isFinite(age) || age > MUTABLE_WINDOW_MS) {
    return { status: 409, body: { error: '超过 2 分钟的消息不能编辑' } }
  }

  const settings = await settingsOf(db, CS_SETTING_KEYS)
  // 编辑走同一套清洗。少了这一步就是一个绕过 §4.4 的洞：先发一句干净的，再编辑成带脚本的。
  const prepared = prepareMessage(
    { body: input?.body, format: input?.format || message.format, attachments: message.attachments },
    {
      allowHtml: settings.cs_allow_html === true, allowBbcode: settings.cs_allow_bbcode !== false,
      // 只钉会话，不钉上传者。附件是从行里读回来的、发送时已经校验过的那一份，而当初那次上传
      // 可能是管理员以客服名义做的（sender_id 是客服，路径上的第二段是管理员）——钉上传者的话，
      // 客服编辑那条消息会被自己的附件挡住。
      sessionId: session.id
    }
  )
  if (!prepared.ok) return { status: 400, body: { error: prepared.error } }
  // 「编辑成全空」已经被 prepareMessage 挡掉了（正文和附件都空才算空）。这里剩下的是另一种情况：
  // 还有附件、正文被改成空白。那是一次合法的编辑（把图片的说明文字删掉），但空白要归一成空串——
  // 留着 '   ' 的话，界面上是一个有高度、没内容的气泡，看起来像加载失败。
  if (!prepared.body.trim()) prepared.body = ''
  if (prepared.body === message.body) return { status: 200, body: { message: presentMessage(message, auth, null) } }

  const revision = (message.edit_count || 0) + 1
  const { error: revErr } = await db.from('cs_message_revisions').insert({
    message_id: messageId, session_id: session.id, kind: 'edit',
    body: message.body, format: message.format, attachments: message.attachments || [],
    revision
  })
  if (revErr) throw new Error(`保存编辑历史失败：${revErr.message}`)

  const now = new Date().toISOString()
  const { data: updated, error: updErr } = await db.from('cs_messages')
    .update({ body: prepared.body, format: prepared.format, edited_at: now, edit_count: revision })
    .eq('id', messageId).eq('edit_count', message.edit_count || 0).select(MESSAGE_COLUMNS).maybeSingle()
  if (updErr) throw new Error(`编辑消息失败：${updErr.message}`)
  if (!updated) return { status: 409, body: { error: '消息已被修改，请刷新后重试' } }

  await logEvent(db, session.id, 'edited', auth, { message_id: messageId, revision })
  return { status: 200, body: { message: presentMessage(updated, auth, null) } }
}

/**
 * 标记已读。工作台的未读数（cs-workbench 的 unread_from_user）靠这个归零。
 *
 * 两侧各一列而不是一列布尔：用户读到哪儿和客服读到哪儿是两件独立的事，共用一列的话，客服打开会话
 * 会把用户那侧也标成已读，于是用户的红点在他没看的时候消失了。
 *
 * 只往前推，不回退：传一个比已有值更早的时间戳不该把已读改回未读。用 is(null) 的条件实现——
 * 已经有值的行不再更新。
 */
export async function markRead(db, auth, input) {
  const sessionId = String(input?.session_id || '')
  if (!UUID.test(sessionId)) return { status: 400, body: { error: 'session_id 必须是 UUID' } }
  const session = await loadSession(db, sessionId)
  if (!session) return { status: 404, body: { error: '会话不存在' } }
  const caps = sessionCapabilities(session, auth)
  if (!caps.can_see) return { status: 403, body: { error: '无权查看该会话' } }

  const now = new Date().toISOString()
  // 用户标的是客服发的消息，客服标的是用户发的消息。标自己发的没有意义。
  const asUser = caps.is_owner
  const column = asUser ? 'read_by_user_at' : 'read_by_agent_at'
  const senderRoles = asUser ? ['agent', 'admin', 'system', 'auto'] : ['user']

  const { data, error } = await db.from('cs_messages')
    .update({ [column]: now })
    .eq('session_id', sessionId).in('sender_role', senderRoles).is(column, null)
    .select('id')
  if (error) throw new Error(`标记已读失败：${error.message}`)
  return { status: 200, body: { marked: (data || []).length, at: now } }
}

/**
 * §7 打字状态。不落库——存一张表意味着每次按键一次写入，而这个信号的寿命是两秒。
 * 走 Realtime 的 broadcast 通道（前端直接 send），这里只回一次能不能发的判定，
 * 免得前端自己去算一遍「谁在这个会话里能说话」。
 */
export async function typingGate(db, auth, input) {
  const sessionId = String(input?.session_id || '')
  if (!UUID.test(sessionId)) return { status: 400, body: { error: 'session_id 必须是 UUID' } }
  const session = await loadSession(db, sessionId)
  if (!session) return { status: 404, body: { error: '会话不存在' } }
  const caps = sessionCapabilities(session, auth)
  if (!caps.can_post) return { status: 403, body: { error: '无权在该会话中发言' } }
  const settings = await settingsOf(db, ['cs_typing_trigger'])
  return {
    status: 200,
    body: {
      channel: `cs:${sessionId}`,
      trigger: settings.cs_typing_trigger || 'keypress',
      as_role: caps.is_owner ? 'user' : 'agent'
    }
  }
}

/**
 * 输入框需要、但浏览器读不到的配置。任何登录用户都能取——里面没有秘密，只有「允许什么格式、
 * 多大算超限」这类前端必须知道才能给出体面提示的东西。
 */
export async function composerConfig(db) {
  const settings = await settingsOf(db, CS_SETTING_KEYS)
  return { status: 200, body: clientConfig(settings) }
}

export default async function handler(req, res) {
  const auth = await requireUser(req, res)
  if (!auth) return
  const caller = { db: auth.db, userId: auth.user.id, group: auth.group }
  try {
    if (req.method === 'GET') {
      if (String(req.query?.view || '') === 'config') {
        const { status, body } = await composerConfig(auth.db)
        return send(res, status, body)
      }
      const { status, body } = await listMessages(auth.db, caller, {
        session_id: req.query?.session_id, limit: req.query?.limit, after: req.query?.after
      })
      return send(res, status, body)
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
    const input = await bodyOf(req)
    const actions = {
      list: () => listMessages(auth.db, caller, input),
      send: () => sendMessage(auth.db, caller, input),
      recall: () => recallMessage(auth.db, caller, input),
      edit: () => editMessage(auth.db, caller, input),
      read: () => markRead(auth.db, caller, input),
      typing: () => typingGate(auth.db, caller, input),
      config: () => composerConfig(auth.db)
    }
    const run = actions[String(input?.action || 'send')]
    if (!run) return send(res, 400, { error: `action 必须是 ${Object.keys(actions).join('/')}` })
    const { status, body } = await run()
    return send(res, status, body)
  } catch (error) {
    console.error('cs-message 失败', error)
    return send(res, 500, { error: error.message })
  }
}

export { MESSAGE_MAX_CHARS, MUTABLE_WINDOW_MS }
