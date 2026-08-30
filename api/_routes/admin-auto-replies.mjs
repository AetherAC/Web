/**
 * §3 自动回复规则的管理接口。
 *
 * 三种触发方式（关键词、下单后、会话开启）共用一张表，因为产出物完全一样——一条挂在客服名下、
 * 不计入响应时间的消息。区别只在什么时候发，那是 trigger 列的事。
 *
 * 这里只做增删改查。发送在 api/_lib/cs.mjs 的 deliverAutoReply 里，因为它要在开会话、收到用户消息、
 * 订单支付成功三条完全不同的路径上被调用。
 */

import { RANK, bodyOf, requireUser, send } from '../_lib/server.mjs'
import { AUTO_REPLY_TRIGGERS, MATCH_MODES, MESSAGE_FORMATS, sanitizeHtml } from '../../shared/cs.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CHANNEL_VALUES = ['presale', 'postsale', 'both']

// 这些列由服务端决定，不接受请求里的值。created_by 尤其重要：允许改的话，一条规则可以被伪造成
// 别人建的，而那正是出问题时第一个要查的字段。
export const NEVER_WRITABLE = ['id', 'created_by', 'created_at', 'updated_at']

const RULE_COLUMNS = 'id,name,enabled,trigger,channel,keywords,match_mode,body,format,' +
  'once_per_session,priority,created_by,created_at,updated_at'

/**
 * 校验并归一化一条规则。
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
    if (!CHANNEL_VALUES.includes(String(input.channel))) {
      return { ok: false, error: `channel 只能是 ${CHANNEL_VALUES.join('/')}` }
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
      if (word.length > 100) return { ok: false, error: '单个关键词不能超过 100 字' }
      seen.add(word)
    }
    if (seen.size > 50) return { ok: false, error: '关键词最多 50 个' }
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
    if (body.length > 4000) return { ok: false, error: '回复内容不能超过 4000 字' }
    // 存进来就清洗，和用户发的消息同一套规则。规则的正文由管理员写，但「管理员不会写恶意 HTML」
    // 不是一个能依赖的前提——被盗的管理员账号第一件能做的事就是往每个新会话里投一段脚本。
    out.body = (out.format || input.format) === 'html' ? sanitizeHtml(body) : body
  }

  if (input.once_per_session !== undefined) out.once_per_session = Boolean(input.once_per_session)

  if (input.priority !== undefined) {
    const n = Number(input.priority)
    if (!Number.isInteger(n) || n < -1000 || n > 1000) {
      return { ok: false, error: 'priority 必须是 -1000..1000 的整数' }
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

export async function listRules(db, input = {}) {
  let query = db.from('cs_auto_replies').select(RULE_COLUMNS)
    .order('trigger', { ascending: true })
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true })
  if (input.trigger && AUTO_REPLY_TRIGGERS.includes(String(input.trigger))) {
    query = query.eq('trigger', String(input.trigger))
  }
  if (input.enabled !== undefined) query = query.eq('enabled', Boolean(input.enabled))
  const { data, error } = await query
  if (error) throw new Error(`读取自动回复规则失败：${error.message}`)
  return { status: 200, body: { rules: data || [] } }
}

export async function createRule(db, auth, input) {
  const checked = validateRule(input || {})
  if (!checked.ok) return { status: 400, body: { error: checked.error } }
  const { data, error } = await db.from('cs_auto_replies')
    .insert({ ...checked.value, created_by: auth.userId }).select(RULE_COLUMNS).single()
  if (error) throw new Error(`创建自动回复规则失败：${error.message}`)
  return { status: 201, body: { rule: data } }
}

/**
 * 改一条规则。
 *
 * 先把现有行读回来，是为了做「关键词触发不能没有关键词」这条跨字段校验——只改 trigger 为 keyword
 * 而不带 keywords 的请求，光看请求体是合法的，看完整状态才知道它会造出一条永不触发的规则。
 */
export async function updateRule(db, id, input) {
  if (!UUID.test(String(id || ''))) return { status: 400, body: { error: 'id 必须是 UUID' } }
  const { data: existing, error: readErr } = await db.from('cs_auto_replies')
    .select(RULE_COLUMNS).eq('id', id).maybeSingle()
  if (readErr) throw new Error(`读取自动回复规则失败：${readErr.message}`)
  if (!existing) return { status: 404, body: { error: '规则不存在' } }

  const patch = { ...(input || {}) }
  for (const key of NEVER_WRITABLE) delete patch[key]
  delete patch.action
  const checked = validateRule(patch, { partial: true })
  if (!checked.ok) return { status: 400, body: { error: checked.error } }

  const nextTrigger = checked.value.trigger ?? existing.trigger
  const nextKeywords = checked.value.keywords ?? existing.keywords ?? []
  if (nextTrigger === 'keyword' && nextKeywords.length === 0) {
    return { status: 400, body: { error: '关键词触发必须至少配一个关键词' } }
  }
  const nextBody = checked.value.body ?? existing.body
  if (!String(nextBody || '').trim()) return { status: 400, body: { error: '回复内容不能为空' } }

  const { data, error } = await db.from('cs_auto_replies')
    .update({ ...checked.value, updated_at: new Date().toISOString() })
    .eq('id', id).select(RULE_COLUMNS).maybeSingle()
  if (error) throw new Error(`更新自动回复规则失败：${error.message}`)
  return { status: 200, body: { rule: data } }
}

/**
 * 删一条规则。
 *
 * cs_messages.auto_reply_rule_id 是 on delete set null，所以删规则不会删掉历史消息，只是那些消息
 * 从此说不出自己是哪条规则发的。这是可以接受的——留着规则不让删的代价是规则列表越来越长，
 * 而管理员真正想要的是「停用」，那走 enabled=false。
 */
export async function deleteRule(db, id) {
  if (!UUID.test(String(id || ''))) return { status: 400, body: { error: 'id 必须是 UUID' } }
  const { data, error } = await db.from('cs_auto_replies').delete().eq('id', id).select('id').maybeSingle()
  if (error) throw new Error(`删除自动回复规则失败：${error.message}`)
  if (!data) return { status: 404, body: { error: '规则不存在' } }
  return { status: 200, body: { deleted: data.id } }
}

export default async function handler(req, res) {
  // 规则的正文会发给每一个开会话的用户，所以写权限只给管理员，不给 cs。
  const auth = await requireUser(req, res, req.method === 'GET' ? RANK.STAFF : RANK.ADMIN)
  if (!auth) return
  const caller = { userId: auth.user.id, group: auth.group }
  try {
    if (req.method === 'GET') {
      const { status, body } = await listRules(auth.db, {
        trigger: req.query?.trigger,
        enabled: req.query?.enabled === undefined ? undefined : req.query.enabled !== 'false'
      })
      return send(res, status, body)
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
    const input = await bodyOf(req)
    const actions = {
      list: () => listRules(auth.db, input),
      create: () => createRule(auth.db, caller, input),
      update: () => updateRule(auth.db, input.id, input),
      delete: () => deleteRule(auth.db, input.id)
    }
    const run = actions[String(input?.action || '')]
    if (!run) return send(res, 400, { error: `action 必须是 ${Object.keys(actions).join('/')}` })
    const { status, body } = await run()
    return send(res, status, body)
  } catch (error) {
    console.error('admin-auto-replies 失败', error)
    return send(res, 500, { error: error.message })
  }
}
