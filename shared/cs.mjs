/**
 * §2/§3/§4 的纯逻辑：渠道资格、分配优先级、消息清洗、超时判定。
 *
 * 放在 shared/ 是因为浏览器和 Serverless 函数都要它，而且必须是同一份。举两个会真的出事的例子：
 *
 *   - 分配优先级（§2.12）在前端和后端各写一遍的话，工作台里显示「这单该我接」，接的时候接口说不该你，
 *     而客服看到的是一个点了没反应的按钮。
 *   - HTML 清洗（§4.4）要是只做在渲染的那一端，另一端存进库的就是原始 HTML；哪天换个渲染器，
 *     或者有人直接从 Supabase 读消息，那段脚本就活了。清洗必须在入库前发生。
 *
 * 纯函数、不碰数据库、不 import 任何 Node 模块，这样浏览器直接吃。
 */

import { RANK, rankOf } from './groups.mjs'

export const CHANNELS = ['presale', 'postsale']
export const CHANNEL_LABEL = { presale: '售前咨询', postsale: '售后咨询' }
export const SESSION_STATUS = ['open', 'closed']
export const ADMIN_MODES = ['none', 'normal', 'readonly', 'blind']
export const ADMIN_MODE_LABEL = {
  none: '未介入',
  normal: '管理员一同参与',
  readonly: '客服只读',
  blind: '管理员接管（客服不可见）'
}
export const SENDER_ROLES = ['user', 'agent', 'admin', 'system', 'auto']
export const MESSAGE_FORMATS = ['plain', 'markdown', 'bbcode', 'html']
export const AUTO_REPLY_TRIGGERS = ['keyword', 'order_paid', 'session_open']
export const MATCH_MODES = ['contains', 'exact', 'starts_with', 'ends_with']

/**
 * §2.2：哪个组服务哪个渠道。必须和 SQL 的 private.serves_channel() 逐字对应——
 * tests/api-smoke.mjs 会把两边对着断言。不一致的方向决定后果：JS 松一档是「界面能点、接口报错」，
 * SQL 松一档是越权读别人的会话。
 */
export function servesChannel(group, channel) {
  if (group === 'admin' || group === 'cs') return CHANNELS.includes(channel)
  if (group === 'presale') return channel === 'presale'
  if (group === 'postsale') return channel === 'postsale'
  return false
}

/**
 * §2.12 的分配优先级：admin → cs → presale/postsale。
 *
 * 返回越小越优先。presale 和 postsale 同为 777，在各自的渠道里平级——这不是疏漏，
 * 一个售前会话本来就不该在「先给售前还是先给售后」上做选择，因为售后根本没资格接它。
 */
export function dispatchPriority(group) {
  if (group === 'admin') return 0
  if (group === 'cs') return 1
  if (group === 'presale' || group === 'postsale') return 2
  return 99
}

/**
 * 从候选客服里挑一个。candidates 是 { user_id, group, online, max_concurrent, load, last_heartbeat } 的数组。
 *
 * 规则的顺序是有意的：先按 §2.12 的组优先级，再按当前负载（同一优先级里给最闲的那个），
 * 最后按 user_id 兜底。少了最后那一档，两个负载相同的客服之间的选择依赖数组顺序，
 * 而那个顺序来自数据库，于是同一次分配在两次调用里可能给出不同答案——测试会随机地过或不过。
 *
 * 只考虑在线的人（§2.12「仅在线客服」）。离线的人不该被分到会话然后让用户等一个不会来的回复。
 */
export function pickAgent(candidates, channel, { defaultMaxConcurrent = 5 } = {}) {
  const eligible = (candidates || []).filter(c => {
    if (!c.online) return false
    if (!servesChannel(c.group, channel)) return false
    const cap = c.max_concurrent ?? defaultMaxConcurrent
    // cap 为 0 是「暂时不接新会话」的合法配置，不是「无上限」。
    return (c.load ?? 0) < cap
  })
  if (eligible.length === 0) return null
  eligible.sort((a, b) =>
    dispatchPriority(a.group) - dispatchPriority(b.group) ||
    (a.load ?? 0) - (b.load ?? 0) ||
    String(a.user_id).localeCompare(String(b.user_id)))
  return eligible[0]
}

/** §2.3：心跳断了多久算离线。 */
export function isHeartbeatStale(lastHeartbeat, timeoutSeconds, now = new Date()) {
  if (!lastHeartbeat) return true
  const at = new Date(lastHeartbeat).getTime()
  if (!Number.isFinite(at)) return true
  return now.getTime() - at > Math.max(0, Number(timeoutSeconds) || 0) * 1000
}

/**
 * §2.8：会话该不该因为无活动而关闭。
 *
 * basis 决定什么算「活动」：'message' 只认发出去的消息，'typing' 连打字也算。两者的差别不是细节——
 * 按 'typing' 算的话，一个用户在输入框里犹豫十分钟不会被关掉，按 'message' 算就会。
 */
export function isSessionIdle(session, { presaleMinutes, postsaleMinutes, now = new Date() }) {
  if (!session || session.status !== 'open') return false
  const minutes = session.channel === 'postsale' ? postsaleMinutes : presaleMinutes
  const limit = Math.max(0, Number(minutes) || 0)
  if (limit === 0) return false // 0 = 不自动关闭
  const at = new Date(session.last_activity_at || session.created_at).getTime()
  if (!Number.isFinite(at)) return false
  return now.getTime() - at > limit * 60 * 1000
}

/** §2.5 超时关闭时给用户和客服的两份文案，键名和 site_settings 里的对齐。 */
export function timeoutTextKeys(channel) {
  const ch = channel === 'postsale' ? 'postsale' : 'presale'
  return { user: `cs_timeout_text_${ch}_user`, agent: `cs_timeout_text_${ch}_agent` }
}

/**
 * §4.4 的 HTML 清洗。
 *
 * 需求写的是「过滤 <script>」。只做这一件事是不够的，而且差得很远——`<img src=x onerror=...>`、
 * `<a href="javascript:...">`、`<iframe>`、`<svg><script>`、`<style>` 里的表达式，任何一个都能拿到
 * 同一个执行环境。所以这里用白名单：不在名单上的标签整个丢掉，不在名单上的属性逐个丢掉。
 *
 * 白名单的代价是管理员写的一些标签会被吃掉，而那是可以看出来的（发出去之后没生效）；黑名单的代价是
 * 漏掉一种写法，而那是看不出来的，直到有人用它偷走一个客服的 session。
 *
 * 这个函数在入库前跑，不是在渲染时跑。渲染时清洗意味着库里存着可执行的原文，那么任何一个绕过这个渲染器
 * 的读取路径（Realtime 订阅、导出、以后新写的一个页面）都是一个洞。
 */
const HTML_ALLOWED = {
  p: [], br: [], b: [], strong: [], i: [], em: [], u: [], s: [], code: [], pre: [],
  ul: [], ol: [], li: [], blockquote: [], h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  hr: [], span: [], div: [], table: [], thead: [], tbody: [], tr: [], th: [], td: [],
  a: ['href', 'title'], img: ['src', 'alt', 'title', 'width', 'height']
}
// 整块丢掉的标签：内容本身就是可执行的，只去掉标签会把脚本正文留在页面上。
const HTML_STRIP_BLOCK = /<(script|style|iframe|object|embed|noscript|template)\b[\s\S]*?<\/\1\s*>/gi
const HTML_URL_OK = /^(https?:\/\/|mailto:|\/|#)/i

export function sanitizeHtml(input) {
  let html = String(input ?? '')
  // 先删成对的危险块，再删没有闭合的开标签（`<script src=x>` 没有 </script> 也一样执行）。
  html = html.replace(HTML_STRIP_BLOCK, '')
  html = html.replace(/<\/?(script|style|iframe|object|embed|noscript|template)\b[^>]*>/gi, '')
  // 注释里可以藏条件注释和未闭合的标签，一并去掉。
  html = html.replace(/<!--[\s\S]*?-->/g, '')

  return html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (whole, slash, rawTag, rawAttrs) => {
    const tag = rawTag.toLowerCase()
    const allowed = HTML_ALLOWED[tag]
    if (!allowed) return ''
    if (slash) return `</${tag}>`

    const kept = []
    // 属性名只认字母和横线：`on error=` 这种带空格的写法在这里匹配不上，于是整个属性被丢掉。
    const attrRe = /([a-zA-Z][a-zA-Z0-9-]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g
    let m
    while ((m = attrRe.exec(rawAttrs)) !== null) {
      const name = m[1].toLowerCase()
      if (!allowed.includes(name)) continue
      const value = (m[2] ?? '').replace(/^["']|["']$/g, '')
      if ((name === 'href' || name === 'src') && !HTML_URL_OK.test(value.trim())) continue
      kept.push(`${name}="${value.replace(/"/g, '&quot;')}"`)
    }
    const selfClose = tag === 'br' || tag === 'hr' || tag === 'img' ? ' /' : ''
    return `<${tag}${kept.length ? ' ' + kept.join(' ') : ''}${selfClose}>`
  })
}

/**
 * §4 的消息校验与清洗。返回 { ok, body, format, attachments } 或 { ok:false, error }。
 *
 * allowHtml / allowBbcode 是站点配置。关掉 html 时收到 format:'html' 的消息不是静默降级成纯文本，
 * 而是拒绝：降级的话，管理员关掉这个开关之后仍然会收到一堆看起来乱码的消息，而他以为自己关掉了。
 */
export const MESSAGE_MAX_CHARS = 8000
export const MAX_ATTACHMENTS = 10

export function prepareMessage(input, { allowHtml = false, allowBbcode = true } = {}) {
  const format = String(input?.format || 'markdown')
  if (!MESSAGE_FORMATS.includes(format)) return { ok: false, error: 'format 不是支持的消息格式' }
  if (format === 'html' && !allowHtml) return { ok: false, error: '站点当前不允许发送 HTML 消息' }
  if (format === 'bbcode' && !allowBbcode) return { ok: false, error: '站点当前不允许发送 BBCode 消息' }

  const attachments = normalizeAttachments(input?.attachments)
  if (!attachments.ok) return attachments

  let body = String(input?.body ?? '')
  // 只有附件、没有正文是合法的（发一张图）。两者都空才是空消息。
  if (!body.trim() && attachments.value.length === 0) return { ok: false, error: '消息内容不能为空' }
  if (body.length > MESSAGE_MAX_CHARS) return { ok: false, error: `消息长度不能超过 ${MESSAGE_MAX_CHARS} 字` }
  if (format === 'html') body = sanitizeHtml(body)

  return { ok: true, body, format, attachments: attachments.value }
}

/**
 * 附件只存引用（bucket 里的路径 + 元信息），不存内容。
 *
 * 大小上限在这里不判：真实大小由 storage 的策略决定，请求体里报的那个数字是用户写的。这里只把它当
 * 展示用的元信息收下来，用来在下载前显示「12.4 MB」。信它来做准入判断等于没有上限。
 */
export function normalizeAttachments(input) {
  if (input === undefined || input === null) return { ok: true, value: [] }
  if (!Array.isArray(input)) return { ok: false, error: 'attachments 必须是数组' }
  if (input.length > MAX_ATTACHMENTS) return { ok: false, error: `一条消息最多 ${MAX_ATTACHMENTS} 个附件` }
  const value = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: '附件必须是对象' }
    const path = String(raw.path || '').trim()
    // 路径必须落在 cs-attachments 桶的会话目录下。存储策略也会校验一遍，这里挡住的是「把消息里的
    // 附件路径指向别人会话的文件」——那样一条消息就能把别的会话的附件展示出来。
    if (!/^[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,120}$/i.test(path)) {
      return { ok: false, error: '附件路径不合法' }
    }
    const kind = String(raw.kind || 'file')
    if (!['image', 'file', 'video'].includes(kind)) return { ok: false, error: '附件类型只能是 image/file/video' }
    value.push({
      path, kind,
      name: String(raw.name || '').slice(0, 200),
      size: Number.isFinite(Number(raw.size)) ? Math.max(0, Math.trunc(Number(raw.size))) : 0,
      mime: String(raw.mime || '').slice(0, 100)
    })
  }
  return { ok: true, value }
}

/** §3.1 的关键词匹配。大小写不敏感——用户不会照着配置里的大小写打字。 */
export function matchesKeyword(text, keywords, mode = 'contains') {
  const haystack = String(text || '').toLowerCase().trim()
  if (!haystack) return false
  for (const raw of keywords || []) {
    const needle = String(raw || '').toLowerCase().trim()
    if (!needle) continue
    if (mode === 'exact' && haystack === needle) return true
    if (mode === 'starts_with' && haystack.startsWith(needle)) return true
    if (mode === 'ends_with' && haystack.endsWith(needle)) return true
    if (mode === 'contains' && haystack.includes(needle)) return true
  }
  return false
}

/**
 * 从规则里挑出该发的那一条。同一条消息命中多条规则时只发优先级最高的一条——
 * 全发的话，用户提一句「我要退款，能退多少」会同时收到三段话。
 *
 * priority 大的优先（后台按「越大越靠前」填），同优先级按创建时间取早的那条，让结果稳定。
 */
export function pickAutoReply(rules, { trigger, channel, text, alreadySentRuleIds = [] }) {
  const sent = new Set(alreadySentRuleIds.map(String))
  const hit = (rules || []).filter(r => {
    if (!r.enabled) return false
    if (r.trigger !== trigger) return false
    if (r.channel !== 'both' && r.channel !== channel) return false
    if (r.once_per_session && sent.has(String(r.id))) return false
    if (trigger !== 'keyword') return true
    return matchesKeyword(text, r.keywords, r.match_mode)
  })
  if (hit.length === 0) return null
  hit.sort((a, b) =>
    (b.priority ?? 0) - (a.priority ?? 0) ||
    String(a.created_at || '').localeCompare(String(b.created_at || '')) ||
    String(a.id).localeCompare(String(b.id)))
  return hit[0]
}

/**
 * §2.13 的两个率。会话行上已经存了 first_response_seconds 和 timed_out，这里只做聚合，
 * 所以看板不需要扫消息表。
 */
export function sessionMetrics(sessions) {
  const rows = sessions || []
  // null 要先挡掉再转数字：Number(null) 是 0，而 0 是有限的，于是「没人回」会被算成
  // 「零秒就回了」——响应率变成 100%，均值趋近 0，恰好把这个看板要暴露的东西盖掉。
  const answered = rows.filter(s =>
    s.first_response_seconds !== null && s.first_response_seconds !== undefined &&
    Number.isFinite(Number(s.first_response_seconds)))
  const total = rows.length
  const timedOut = rows.filter(s => s.timed_out).length
  const sum = answered.reduce((acc, s) => acc + Number(s.first_response_seconds), 0)
  return {
    total,
    answered: answered.length,
    // 回复率的分母是全部会话，不是「有客服接的会话」：没人接的会话正是这个指标要暴露的东西。
    reply_rate: total ? answered.length / total : 0,
    timeout_rate: total ? timedOut / total : 0,
    avg_first_response_seconds: answered.length ? Math.round(sum / answered.length) : null,
    // 中位数一起给：平均值会被一个隔夜才回的会话彻底带偏，而那种会话恰好每天都有一两个。
    median_first_response_seconds: median(answered.map(s => Number(s.first_response_seconds)))
  }
}

function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/**
 * 会话对某个人该以什么形态呈现。前端和后端都要这个判断：前端用它决定画不画输入框，
 * 后端用它决定收不收这条消息。
 */
export function sessionCapabilities(session, viewer) {
  const rank = rankOf(viewer?.group)
  const isOwner = session?.user_id === viewer?.userId
  const isAgent = session?.agent_id === viewer?.userId
  const isAdmin = rank >= RANK.ADMIN
  const blind = session?.admin_mode === 'blind'
  const readonly = session?.admin_mode === 'readonly'
  const open = session?.status === 'open'

  const canSee = isOwner || isAdmin ||
    (isAgent && !blind) ||
    (!session?.agent_id && !blind && rank >= RANK.STAFF && servesChannel(viewer?.group, session?.channel))
  const canPost = open && (isOwner || isAdmin || (isAgent && !blind && !readonly))

  return {
    can_see: Boolean(canSee),
    can_post: Boolean(canPost),
    // 撤回和编辑只对自己发的消息开放，具体到消息还要看时限，那部分在 api 层判。
    can_claim: open && !session?.agent_id && !blind && rank >= RANK.STAFF && servesChannel(viewer?.group, session?.channel),
    can_close: open && (isOwner || isAdmin || (isAgent && !blind)),
    // §2.5：重开由用户或客服发起，但必须是同一个客服接回去，所以这里只说能不能点。
    can_reopen: !open && (isOwner || isAdmin || isAgent),
    can_monitor: isAdmin,
    // 客服看得见撤回原文和编辑历史，用户看不见（§2.11）。
    can_see_revisions: rank >= RANK.STAFF && Boolean(canSee),
    is_owner: isOwner, is_agent: isAgent, is_admin: isAdmin
  }
}

/**
 * §2.11 的撤回：给不同的人看不同的东西。
 *
 * 用户看到一条空壳（「已撤回」），客服看到「已撤回」加原文。原文不在 cs_messages 行里——撤回时它被搬去
 * cs_message_revisions 了，所以这个函数拿到的 revisions 参数只有客服那条路径会传。
 */
export function presentMessage(message, viewer, revisions = null) {
  const staff = rankOf(viewer?.group) >= RANK.STAFF
  const base = { ...message }
  if (message.recalled) {
    base.body = ''
    base.recalled = true
    // 客服那一侧把原文挂在单独的字段上，而不是塞回 body：前端要能画出「已撤回」的样式，
    // 塞回 body 的话它和一条正常消息就没有区别了。
    if (staff && revisions) {
      const recall = revisions.find(r => r.kind === 'recall')
      if (recall) base.recalled_body = recall.body
    }
  }
  if (message.edited_at && staff && revisions) {
    base.edit_history = revisions.filter(r => r.kind === 'edit')
      .sort((a, b) => (a.revision ?? 0) - (b.revision ?? 0))
      .map(r => ({ body: r.body, format: r.format, revision: r.revision, created_at: r.created_at }))
  }
  if (!staff) {
    // 用户看不到编辑历史，也看不到 blind 模式下的真作者——后者等于把介入告诉了用户。
    delete base.edit_history
    delete base.recalled_body
    delete base.authored_by
    delete base.auto_reply_rule_id
  }
  return base
}
