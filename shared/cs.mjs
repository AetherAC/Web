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
/** 自动回复可以配「两个渠道都发」，而一个会话只能属于一个渠道，所以这里比 CHANNELS 多一项。 */
export const AUTO_REPLY_CHANNELS = ['presale', 'postsale', 'both']
export const AUTO_REPLY_KEYWORD_MAX = 50
export const AUTO_REPLY_KEYWORD_CHARS = 100
export const AUTO_REPLY_BODY_MAX = 4000
export const AUTO_REPLY_PRIORITY_RANGE = [-1000, 1000]

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

export function prepareMessage(input, {
  allowHtml = false, allowBbcode = true, sessionId = null, uploaderId = null
} = {}) {
  const format = String(input?.format || 'markdown')
  if (!MESSAGE_FORMATS.includes(format)) return { ok: false, error: 'format 不是支持的消息格式' }
  if (format === 'html' && !allowHtml) return { ok: false, error: '站点当前不允许发送 HTML 消息' }
  if (format === 'bbcode' && !allowBbcode) return { ok: false, error: '站点当前不允许发送 BBCode 消息' }

  const attachments = normalizeAttachments(input?.attachments, { sessionId, uploaderId })
  if (!attachments.ok) return attachments

  let body = String(input?.body ?? '')
  // 只有附件、没有正文是合法的（发一张图）。两者都空才是空消息。
  if (!body.trim() && attachments.value.length === 0) return { ok: false, error: '消息内容不能为空' }
  if (body.length > MESSAGE_MAX_CHARS) return { ok: false, error: `消息长度不能超过 ${MESSAGE_MAX_CHARS} 字` }
  if (format === 'html') body = sanitizeHtml(body)

  return { ok: true, body, format, attachments: attachments.value }
}

/** §4.2/§4.5/§4.6 的三类附件，以及每一类的限额配置项。 */
export const ATTACHMENT_KINDS = ['image', 'file', 'video']
export const UPLOAD_LIMIT_KEY = {
  image: 'cs_upload_max_image_mb',
  file: 'cs_upload_max_file_mb',
  video: 'cs_upload_max_video_mb'
}
export const ATTACHMENT_BUCKET = 'cs-attachments'

/** 路径的形状：{session_id}/{uid}/{文件名}，和 schema.sql 里 cs_attach_insert 的三段约定一致。 */
export const ATTACHMENT_PATH_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([A-Za-z0-9._-]{1,120})$/i

/**
 * 拼一个上传路径。前端必须用这个函数而不是自己拼字符串：
 * 段数或顺序错了的表现是上传成功、发消息被拒（或者反过来），而两者都不会告诉你路径写错在哪。
 */
export function attachmentPath(sessionId, uploaderId, filename) {
  const safe = String(filename || 'file')
    .replace(/[^A-Za-z0-9._-]+/g, '-')   // 中文名、空格、括号一律换成横线：路径里它们是最容易出事的字符
    .replace(/^-+|-+$/g, '')
    .slice(-80) || 'file'
  // 前缀一个随机段：同一个人两次传同名文件不该互相覆盖，而 storage 的 upsert 默认是关的（会报 409）。
  const stamp = Math.random().toString(36).slice(2, 8)
  return `${sessionId}/${uploaderId}/${stamp}-${safe}`
}

/** 按 MIME 归类。归错的后果只是套用了另一档限额，所以按前缀粗判就够。 */
export function attachmentKindOf(mime) {
  const m = String(mime || '').toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  return 'file'
}

/**
 * 附件只存引用（bucket 里的路径 + 元信息），不存内容。
 *
 * 请求体里报的 size 是用户写的，所以它只当展示用的元信息收下来（下载前显示「12.4 MB」）。真实大小的
 * 判定在 api/_lib/cs.mjs 的 verifyAttachments 里，那一步去 storage 问对象的 metadata。
 *
 * sessionId / uploaderId 传进来时会钉住路径的前两段。不钉的话，一条消息可以把 path 指向另一个会话
 * 目录下的文件——存储策略只管「谁能上传、谁能下载」，管不了「哪条消息可以引用哪个路径」，于是
 * 会话 A 的人只要知道路径就能把会话 B 的附件贴进自己的会话里展示出来。
 */
export function normalizeAttachments(input, { sessionId = null, uploaderId = null } = {}) {
  if (input === undefined || input === null) return { ok: true, value: [] }
  if (!Array.isArray(input)) return { ok: false, error: 'attachments 必须是数组' }
  if (input.length > MAX_ATTACHMENTS) return { ok: false, error: `一条消息最多 ${MAX_ATTACHMENTS} 个附件` }
  const value = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: '附件必须是对象' }
    const path = String(raw.path || '').trim()
    const m = ATTACHMENT_PATH_RE.exec(path)
    if (!m) return { ok: false, error: '附件路径不合法，应为 会话id/用户id/文件名' }
    if (sessionId && m[1].toLowerCase() !== String(sessionId).toLowerCase()) {
      return { ok: false, error: '附件不属于当前会话' }
    }
    if (uploaderId && m[2].toLowerCase() !== String(uploaderId).toLowerCase()) {
      return { ok: false, error: '只能引用自己上传的附件' }
    }
    const kind = String(raw.kind || 'file')
    if (!ATTACHMENT_KINDS.includes(kind)) return { ok: false, error: '附件类型只能是 image/file/video' }
    value.push({
      path, kind,
      name: String(raw.name || '').slice(0, 200),
      size: Number.isFinite(Number(raw.size)) ? Math.max(0, Math.trunc(Number(raw.size))) : 0,
      mime: String(raw.mime || '').slice(0, 100)
    })
  }
  return { ok: true, value }
}

/**
 * 三档限额的解析。缺配置时用 §11 里那三个种子值，不是「无上限」——
 * 取不到配置就放行的写法意味着删掉一行 site_settings 等于关掉上限。
 */
export function uploadLimits(settings = {}) {
  const mb = (key, fallback) => {
    const n = Number(settings[key])
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  return {
    image: mb(UPLOAD_LIMIT_KEY.image, 10),
    file: mb(UPLOAD_LIMIT_KEY.file, 25),
    video: mb(UPLOAD_LIMIT_KEY.video, 100)
  }
}

/** 单个附件的大小判定。bytes 为 null/undefined 表示问不到——那种情况按拒绝算，理由在 verifyAttachments。 */
export function checkAttachmentSize(kind, bytes, limits) {
  const limitMb = limits?.[kind] ?? limits?.file ?? 25
  const max = limitMb * 1024 * 1024
  // 不能只判 Number.isFinite：Number(null) 是 0，于是「问不到大小」会被当成一个 0 字节的文件放过去。
  if (bytes === null || bytes === undefined || bytes === '' || !Number.isFinite(Number(bytes))) {
    return { ok: false, error: '无法确认附件大小' }
  }
  if (Number(bytes) > max) {
    return { ok: false, error: `${KIND_LABEL_CN[kind] || '文件'}不能超过 ${limitMb} MB`, limitMb }
  }
  return { ok: true }
}

const KIND_LABEL_CN = { image: '图片', file: '文件', video: '视频' }
export const ATTACHMENT_KIND_LABEL = KIND_LABEL_CN

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
 * §3 校验并归一化一条自动回复规则。
 *
 * 在 shared/ 而不是在接口文件里，是因为后台的规则编辑器也要它。抄一份到前端的代价不是「两处要改」，
 * 而是抄的那份宽一档时，界面判合法、接口回 400，填的人看到的是一个点了报错却不说哪错的保存按钮。
 * 接口照旧会再校验一次——这一份是省一次往返，不是替代它。
 *
 * 关键词规则必须有关键词：一条 trigger='keyword' 且 keywords 为空的规则，在 matchesKeyword 里
 * 永远不匹配，于是它安静地什么都不做。配的人会以为自己配好了，而唯一的症状是「自动回复没生效」。
 */
export function validateRule(input, { partial = false } = {}) {
  const out = {}

  if (input.name !== undefined) out.name = String(input.name).trim().slice(0, 120)
  if (input.enabled !== undefined) out.enabled = Boolean(input.enabled)

  if (input.trigger !== undefined) {
    if (!AUTO_REPLY_TRIGGERS.includes(String(input.trigger))) {
      return { ok: false, error: `trigger 只能是 ${AUTO_REPLY_TRIGGERS.join('/')}` }
    }
    out.trigger = String(input.trigger)
  } else if (!partial) {
    return { ok: false, error: 'trigger 必填' }
  }

  if (input.channel !== undefined) {
    if (!AUTO_REPLY_CHANNELS.includes(String(input.channel))) {
      return { ok: false, error: `channel 只能是 ${AUTO_REPLY_CHANNELS.join('/')}` }
    }
    out.channel = String(input.channel)
  }

  if (input.keywords !== undefined) {
    if (!Array.isArray(input.keywords)) return { ok: false, error: 'keywords 必须是数组' }
    // 去重并去掉空串：空串在 contains 模式下匹配任何文本，等于让这条规则对每句话都触发。
    const seen = new Set()
    for (const k of input.keywords) {
      const word = String(k ?? '').trim()
      if (!word) continue
      if (word.length > AUTO_REPLY_KEYWORD_CHARS) {
        return { ok: false, error: `单个关键词不能超过 ${AUTO_REPLY_KEYWORD_CHARS} 字` }
      }
      seen.add(word)
    }
    if (seen.size > AUTO_REPLY_KEYWORD_MAX) {
      return { ok: false, error: `关键词最多 ${AUTO_REPLY_KEYWORD_MAX} 个` }
    }
    out.keywords = [...seen]
  }

  if (input.match_mode !== undefined) {
    if (!MATCH_MODES.includes(String(input.match_mode))) {
      return { ok: false, error: `match_mode 只能是 ${MATCH_MODES.join('/')}` }
    }
    out.match_mode = String(input.match_mode)
  }

  if (input.format !== undefined) {
    if (!MESSAGE_FORMATS.includes(String(input.format))) {
      return { ok: false, error: `format 只能是 ${MESSAGE_FORMATS.join('/')}` }
    }
    out.format = String(input.format)
  }

  if (input.body !== undefined) {
    const body = String(input.body)
    if (body.length > AUTO_REPLY_BODY_MAX) {
      return { ok: false, error: `回复内容不能超过 ${AUTO_REPLY_BODY_MAX} 字` }
    }
    // 存进来就清洗，和用户发的消息同一套规则。规则的正文由管理员写，但「管理员不会写恶意 HTML」
    // 不是一个能依赖的前提——被盗的管理员账号第一件能做的事就是往每个新会话里投一段脚本。
    out.body = (out.format || input.format) === 'html' ? sanitizeHtml(body) : body
  }

  if (input.once_per_session !== undefined) out.once_per_session = Boolean(input.once_per_session)

  if (input.priority !== undefined) {
    const [lo, hi] = AUTO_REPLY_PRIORITY_RANGE
    const n = Number(input.priority)
    if (!Number.isInteger(n) || n < lo || n > hi) {
      return { ok: false, error: `priority 必须是 ${lo}..${hi} 的整数` }
    }
    out.priority = n
  }

  // 「关键词触发必须有关键词」这条跨字段规则在这里只对新建生效。改的时候请求体不一定带这两个字段，
  // 判断要拿现有行补齐，那部分在 updateRule 里——放在这里的话它只能看见请求体的一半。
  if (!partial) {
    if (out.trigger === 'keyword' && !out.keywords?.length) {
      return { ok: false, error: '关键词触发必须至少配一个关键词' }
    }
    if (!out.body?.trim()) return { ok: false, error: '回复内容不能为空' }
  }
  if (Object.keys(out).length === 0) return { ok: false, error: '没有可更新的字段' }

  return { ok: true, value: out }
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
