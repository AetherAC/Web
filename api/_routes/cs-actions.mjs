/**
 * §2.6 会话内发券、§2.7 会话内发起退款。
 *
 * 这两件事为什么不直接让工作台去打 admin-coupons 和 refund-request：
 *
 *   - 发券要「限定给这个用户」。客服手里的券如果是全站通用的，那张券码会被贴到论坛上，而客服本来
 *     只想补偿一个人。所以这里发出去的券一律带 allowed_user_ids = [会话所属用户]。
 *   - 两件事都要在会话里留下痕迹。客服说「已经给您补了一张八折券」而系统里查不到，就是一次无法
 *     追溯的补偿；反过来券发了但用户没在对话里看到券码，客服还得再复述一遍。
 *   - 退款要从会话推出订单号。售后会话绑着订单，客服不该再手抄一遍订单号——手抄就会抄错，
 *     而抄错的后果是给另一笔单退了钱。
 */

import { RANK, bodyOf, rankOf, requireUser, send } from '../_lib/server.mjs'
import { sessionCapabilities } from '../../shared/cs.mjs'
import { describeAction, formatMinor, validateCoupon } from '../../shared/coupons.mjs'
import { forValidation } from './admin-coupons.mjs'
import { insertMessage, logEvent, touchSession } from '../_lib/cs.mjs'
import { requestRefund } from './refund-request.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// 会话内发的券默认七天有效。客服补偿的场景里「永久有效」几乎总是错的：那张券会在半年后被用掉，
// 而当时的补偿理由早就不成立了。
const CHAT_COUPON_DAYS = 7
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * 生成券码。去掉了 I/O/0/1 —— 客服会把券码念给用户听，或者用户会手打，而这四个字符是手打错误的
 * 主要来源。前缀固定 CS 是为了在券列表里一眼看出哪些是会话里发出去的。
 */
export function chatCouponCode(random = Math.random) {
  let body = ''
  for (let i = 0; i < 8; i += 1) body += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)]
  return `CS${body}`
}

async function loadSession(db, id) {
  const { data, error } = await db.from('cs_sessions')
    .select('id,channel,user_id,order_id,agent_id,status,admin_mode,opened_at,created_at,first_response_seconds')
    .eq('id', id).maybeSingle()
  if (error) throw new Error(`读取会话失败：${error.message}`)
  return data || null
}

/**
 * §2.6：在会话里发一张券给当前用户。
 *
 * 券的定义由客服在界面上填（折扣方式、金额门槛），但限制项由服务端接管：只给这个用户、每人一次、
 * 总量一次、七天有效。客服能改的只有折扣本身——把这些限制交给客服填，等于每次补偿都有机会发出
 * 一张全站可用的无限量券。
 */
export async function sendCoupon(db, auth, input) {
  const sessionId = String(input?.session_id || '')
  if (!UUID.test(sessionId)) return { status: 400, body: { error: 'session_id 必须是 UUID' } }
  const session = await loadSession(db, sessionId)
  if (!session) return { status: 404, body: { error: '会话不存在' } }

  const caps = sessionCapabilities(session, auth)
  // 用户自己不能给自己发券。can_post 对会话所属用户是 true，所以这条要单独判。
  if (caps.is_owner) return { status: 403, body: { error: '不能给自己发券' } }
  if (!caps.can_post) {
    return session.status !== 'open'
      ? { status: 409, body: { error: '会话已关闭，无法发券' } }
      : { status: 403, body: { error: '无权在该会话中发券' } }
  }
  if (rankOf(auth.group) < RANK.STAFF) return { status: 403, body: { error: '只有客服可以发券' } }

  const actions = Array.isArray(input?.actions) ? input.actions : []
  if (actions.length === 0) return { status: 400, body: { error: '请指定券的优惠方式' } }
  if (actions.length > 3) return { status: 400, body: { error: '一张券最多三个优惠动作' } }

  const now = new Date()
  const days = Math.min(Math.max(Number(input?.valid_days) || CHAT_COUPON_DAYS, 1), 90)
  const draft = {
    code: chatCouponCode(),
    name: String(input?.name || '客服补偿券').slice(0, 120),
    description: String(input?.description || '').slice(0, 500),
    enabled: true,
    conditions: Array.isArray(input?.conditions) ? input.conditions : [],
    actions,
    starts_at: now.toISOString(),
    ends_at: new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString(),
    // 三条限制不接受请求里的值。这是这个接口和 admin-coupons 的根本区别。
    per_user_limit: 1,
    total_limit: 1,
    allowed_user_ids: [session.user_id],
    created_by: auth.userId
  }

  // 用和 admin-coupons 完全同一个校验器，并且走同一个 forValidation 翻译。少了这一步，会话里能发出
  // 一张管理界面拒绝保存的券，而它在结算时的行为没人验证过。
  const checked = validateCoupon(forValidation(draft))
  if (!checked.ok) return { status: 400, body: { error: checked.error } }

  const { data: coupon, error } = await db.from('coupons').insert(draft).select().single()
  // 23505 只能是 coupons_code_key：八位随机码撞了。重试一次比让客服重新填一遍界面合理。
  if (error?.code === '23505') {
    const retry = { ...draft, code: chatCouponCode() }
    const { data: second, error: secondErr } = await db.from('coupons').insert(retry).select().single()
    if (secondErr) throw new Error(`创建优惠券失败：${secondErr.message}`)
    return finishCoupon(db, auth, session, second, days)
  }
  if (error) throw new Error(`创建优惠券失败：${error.message}`)
  return finishCoupon(db, auth, session, coupon, days)
}

/**
 * 券建好之后要做的两件事：在会话里贴出券码，并留一条事件。
 *
 * 消息以客服身份发（用户看到的是「客服给了我一张券」），格式用 markdown 好让券码加粗。
 */
async function finishCoupon(db, auth, session, coupon, days) {
  const lines = [
    `已为您发放一张优惠券：**${coupon.code}**`,
    coupon.name ? `名称：${coupon.name}` : '',
    ...(coupon.actions || []).map(a => `优惠：${describeAction(a)}`),
    `有效期：${days} 天（至 ${new Date(coupon.ends_at).toLocaleDateString('zh-CN')}）`,
    '结算时输入券码即可使用，仅限本账户。'
  ].filter(Boolean)

  const message = await insertMessage(db, session, {
    senderId: session.agent_id || auth.userId,
    senderRole: 'agent',
    body: lines.join('\n\n'),
    format: 'markdown',
    authoredBy: (session.agent_id && session.agent_id !== auth.userId) ? auth.userId : null
  })
  await touchSession(db, session, message)
  await logEvent(db, session.id, 'coupon_sent', auth, { coupon_id: coupon.id, code: coupon.code })

  return {
    status: 201,
    body: {
      coupon: { id: coupon.id, code: coupon.code, name: coupon.name, ends_at: coupon.ends_at },
      message_id: message.id
    }
  }
}

/**
 * §2.7：从会话里发起退款。
 *
 * 订单号从会话上取，不从请求体取。售前会话没有订单，所以请求体可以带一个 order_id —— 但那时要
 * 验证订单属于会话所属用户，否则这是一个「给任意订单发起退款」的接口。
 *
 * 实际的申请逻辑复用 requestRefund：金额上限、在途唯一、审批通知、审计日志全在那里。在这里重写
 * 一遍就等于多了一条可能漏掉金额上限的路径。
 */
export async function startRefund(db, auth, input) {
  const sessionId = String(input?.session_id || '')
  if (!UUID.test(sessionId)) return { status: 400, body: { error: 'session_id 必须是 UUID' } }
  const session = await loadSession(db, sessionId)
  if (!session) return { status: 404, body: { error: '会话不存在' } }

  const caps = sessionCapabilities(session, auth)
  if (caps.is_owner) return { status: 403, body: { error: '请在订单页发起退款' } }
  if (!caps.can_post) {
    return session.status !== 'open'
      ? { status: 409, body: { error: '会话已关闭，无法发起退款' } }
      : { status: 403, body: { error: '无权在该会话中操作' } }
  }

  let orderId = session.order_id
  if (!orderId) {
    orderId = String(input?.order_id || '')
    if (!UUID.test(orderId)) {
      return { status: 400, body: { error: '售前会话没有关联订单，请提供 order_id' } }
    }
    // 会话所属用户必须是这笔单的买家。没有这一步，客服可以从任何一个会话里对任何订单发起退款。
    const { data: order, error } = await db.from('orders').select('id,user_id').eq('id', orderId).maybeSingle()
    if (error) throw new Error(`读取订单失败：${error.message}`)
    if (!order || order.user_id !== session.user_id) {
      return { status: 404, body: { error: '订单不存在，或不属于该会话的用户' } }
    }
  }

  // requestRefund 自己判 REFUND_PROXY_GROUPS（postsale/cs/admin），所以 presale 会在那里被挡下。
  const result = await requestRefund(db, { userId: auth.userId, group: auth.group }, {
    order_id: orderId,
    reason_code: input?.reason_code,
    reason_detail: input?.reason_detail,
    amount_minor: input?.amount_minor,
    evidence_paths: input?.evidence_paths
  })
  if (result.status >= 400) return result

  const refund = result.body.refund
  const amountText = formatMinor(refund.amount_minor, refund.currency)
  const message = await insertMessage(db, session, {
    senderId: session.agent_id || auth.userId,
    senderRole: 'agent',
    body: `已为您提交退款申请，金额 ${amountText}，正在等待管理员审批。审批结果会通过站内信通知您。`,
    format: 'plain',
    authoredBy: (session.agent_id && session.agent_id !== auth.userId) ? auth.userId : null
  })
  await touchSession(db, session, message)
  await logEvent(db, session.id, 'refund_requested', auth, {
    refund_id: refund.id, order_id: orderId, amount_minor: refund.amount_minor
  })

  return {
    status: 201,
    body: { refund, notified: result.body.notified, message_id: message.id }
  }
}

/**
 * 会话里能操作的订单列表。客服要先知道用户有哪些单才能选一笔退款。
 *
 * 只读会话所属用户的单，不接受 user_id 参数——接受的话这就是一个「按用户 ID 列出全部订单」的接口，
 * 而它的门槛只有 STAFF。
 */
export async function listSessionOrders(db, auth, input) {
  const sessionId = String(input?.session_id || '')
  if (!UUID.test(sessionId)) return { status: 400, body: { error: 'session_id 必须是 UUID' } }
  const session = await loadSession(db, sessionId)
  if (!session) return { status: 404, body: { error: '会话不存在' } }
  const caps = sessionCapabilities(session, auth)
  if (!caps.can_see) return { status: 403, body: { error: '无权查看该会话' } }
  if (caps.is_owner && rankOf(auth.group) < RANK.STAFF) {
    return { status: 403, body: { error: '无权查看订单列表' } }
  }

  const { data, error } = await db.from('orders')
    .select('id,status,sku,sku_name,amount_minor,paid_amount_minor,currency,paid_currency,provider,created_at,paid_at')
    .eq('user_id', session.user_id).order('created_at', { ascending: false }).limit(50)
  if (error) throw new Error(`读取订单失败：${error.message}`)
  return { status: 200, body: { orders: data || [] } }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
  const auth = await requireUser(req, res, RANK.STAFF)
  if (!auth) return
  const caller = { db: auth.db, userId: auth.user.id, group: auth.group }
  try {
    const input = await bodyOf(req)
    const actions = {
      send_coupon: () => sendCoupon(auth.db, caller, input),
      start_refund: () => startRefund(auth.db, caller, input),
      orders: () => listSessionOrders(auth.db, caller, input)
    }
    const run = actions[String(input?.action || '')]
    if (!run) return send(res, 400, { error: `action 必须是 ${Object.keys(actions).join('/')}` })
    const { status, body } = await run()
    return send(res, status, body)
  } catch (error) {
    console.error('cs-actions 失败', error)
    return send(res, 500, { error: error.message })
  }
}
