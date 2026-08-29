/**
 * §10.2 / §13.3：发起退款申请。
 *
 * 三个入口打的是同一个接口：用户在自己的订单页上提、客服在工作台里代提、管理员在订单详情里代提。
 * 三个入口不做成三个接口是因为「谁能提、能不能改金额、金额上限、并发下只允许一条在途」这四件事
 * 对三者完全一样，分开写必然让其中一份漏掉一条——而漏掉金额上限那条就是可以退出比实付更多的钱。
 *
 * 这个接口不改订单状态。§13.3 说得很明确：订单是在审批通过时才进 REFUND_PENDING，提交申请时还是
 * PAID。所以这里也不写 order_status_log——那张表记的是状态变更，而这里没有变更；申请本身的痕迹在
 * refund_audit_log 里。把没发生的迁移写进状态日志，会让 §12.4 的订单变更记录里出现假条目。
 */

import { bodyOf, requireUser, send } from './_lib/server.mjs'
import { insertNotification, logRefundAction, setting } from './_lib/notify.mjs'
import { refundApprovalNotification } from '../shared/notifications.mjs'
import { formatMinor } from '../shared/coupons.mjs'
import { REFUND_PROXY_GROUPS, canRequestRefund, validateRefundAmount } from '../shared/orders.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 订单号的展示形式。库里没有单独的订单号列，id 就是订单号；只在通知标题里截短一下。 */
export const orderNoOf = id => String(id || '').slice(0, 8).toUpperCase()

/**
 * 决策函数。db 从外面传进来，好让测试把它必须加的过滤条件钉死——这个接口跑在 service client 上，
 * 所以那些条件就是全部的授权检查。
 */
export async function requestRefund(db, caller, input) {
  const orderId = String(input?.order_id || '')
  if (!UUID.test(orderId)) return { status: 400, body: { error: '订单号格式不正确' } }

  const reasonCode = String(input?.reason_code || '').trim()
  const reasonDetail = String(input?.reason_detail || '').trim()
  // §10.2：原因必填。空原因的申请到了审批人那里就是一条无法判断的请求，只能退回来重问一遍。
  if (!reasonDetail) return { status: 400, body: { error: '请填写退款原因' } }
  if (reasonDetail.length > 2000) return { status: 400, body: { error: '退款原因请控制在 2000 字以内' } }
  if (reasonCode.length > 64) return { status: 400, body: { error: '原因分类不合法' } }

  const { data: order, error: orderErr } = await db.from('orders')
    .select('id,user_id,status,amount_minor,paid_amount_minor,currency,paid_currency')
    .eq('id', orderId).maybeSingle()
  if (orderErr) return { status: 500, body: { error: '读取订单失败' } }

  const isProxy = REFUND_PROXY_GROUPS.includes(caller.group)
  // 不存在的订单和别人的订单要给同一个答复。分开答等于给一个探测接口：拿订单号逐个试，
  // 404 和 403 的区别就能问出「这个订单号存在吗」。代提人本来就能看全部订单，对他们不必伪装。
  if (!order || (order.user_id !== caller.userId && !isProxy)) {
    return { status: 404, body: { error: '订单不存在' } }
  }
  const onBehalf = order.user_id !== caller.userId
  const initiatorRole = onBehalf ? caller.group : 'user'

  // 在途申请要单独查一次。§13.3 规定申请提交时订单还是 PAID，所以只看订单状态查不出「已经提过了」。
  const { data: existing, error: exErr } = await db.from('refund_requests')
    .select('id,status').eq('order_id', orderId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (exErr) return { status: 500, body: { error: '读取退款申请失败' } }

  const allowed = canRequestRefund(order, existing)
  if (!allowed.ok) return { status: 409, body: { error: allowed.reason } }

  // §10.2 + §14：金额可改，但改的权限分三档。
  //
  // 用户不能自己挑金额——那是「我只想退一半」这种诉求，得由客服判断后代提，否则退款金额变成用户
  // 单方面填的数字。这里选择明确拒绝而不是静默忽略：静默忽略会让用户以为部分退款已经提上去了。
  // 客服能不能改由 refund_cs_can_edit_amount 开关决定（§14）；管理员不受这个开关约束，那个开关的
  // 字面意思就是「客服是否可改金额」。
  const wantsAmount = input?.amount_minor !== undefined && input?.amount_minor !== null
  let amountMinor = allowed.maxAmountMinor
  if (wantsAmount) {
    if (!onBehalf) return { status: 403, body: { error: '退款金额由客服确认，请在申请原因里说明你希望退多少' } }
    if (caller.group !== 'admin' && !(await setting(db, 'refund_cs_can_edit_amount', true))) {
      return { status: 403, body: { error: '当前设置不允许客服修改退款金额' } }
    }
    const amountCheck = validateRefundAmount(order, input.amount_minor)
    if (!amountCheck.ok) return { status: 400, body: { error: amountCheck.error } }
    amountMinor = amountCheck.amountMinor
  }

  // 证据是存储里的路径，不是内容。上传时 storage 的 RLS 策略已经把路径形状和归属管住了
  // （见 schema.sql 的 refund_evidence_* 策略），这里只挡住明显不合形状的输入。
  const rawEvidence = Array.isArray(input?.evidence_paths) ? input.evidence_paths : []
  if (rawEvidence.length > 10) return { status: 400, body: { error: '证据文件最多 10 个' } }
  const evidence = rawEvidence.map(p => String(p || '').trim()).filter(Boolean)
  if (evidence.some(p => p.length > 400 || p.includes('..'))) {
    return { status: 400, body: { error: '证据文件路径不合法' } }
  }

  const currency = order.paid_currency || order.currency
  const row = {
    order_id: orderId,
    user_id: order.user_id,
    reason_code: reasonCode,
    reason_detail: reasonDetail,
    evidence_paths: evidence,
    status: 'pending',
    amount_minor: amountMinor,
    currency,
    initiated_by: caller.userId,
    initiator_role: initiatorRole
  }
  const { data: refund, error: insErr } = await db.from('refund_requests').insert(row).select().single()
  if (insErr) {
    // 23505 是唯一约束冲突，来自 one_open_refund_per_order：两个请求同时读到零行、同时插入。
    // 这条比上面那次查询更可靠——查询解决不了并发，索引才能。
    if (insErr.code === '23505') return { status: 409, body: { error: '该订单已有一条在途的退款申请' } }
    return { status: 500, body: { error: '提交退款申请失败' } }
  }

  await logRefundAction(db, {
    refund_id: refund.id, actor_id: caller.userId, actor_group: caller.group,
    action: 'create', to_status: 'pending', amount_minor: amountMinor,
    note: onBehalf ? `${caller.group} 代提，原因：${reasonDetail}` : `用户提交，原因：${reasonDetail}`
  })

  // §10.3 的审批通知。它插不进去等于审批请求没发出去，所以这里不吞错误——但申请已经落库了，
  // 所以答复里带上告警而不是回一个失败：让调用方知道申请在、通知没到，管理员仍能从待审批列表看到。
  const amountText = formatMinor(amountMinor, currency)
  let notified = true
  try {
    await insertNotification(db, refundApprovalNotification({
      refundId: refund.id, orderNo: orderNoOf(orderId), amountText,
      reason: reasonDetail, initiator: onBehalf ? `${caller.group}（代提）` : '用户本人'
    }))
  } catch (e) {
    notified = false
    console.error('审批通知写入失败', { refund_id: refund.id, error: e.message })
  }

  return { status: 201, body: { refund, notified } }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
  // 门槛是 0：任何登录用户都能给自己的订单提退款（§13.3 的第一个入口）。代提的权限在
  // requestRefund 里按 group 判断，不在这里——这里拦不住「登录用户给别人的订单提」。
  const auth = await requireUser(req, res, 0)
  if (!auth) return
  try {
    const input = await bodyOf(req)
    const result = await requestRefund(auth.db, { userId: auth.user.id, group: auth.group }, input)
    return send(res, result.status, result.body)
  } catch (e) {
    console.error('refund-request 失败', e)
    return send(res, 500, { error: '提交退款申请失败' })
  }
}
