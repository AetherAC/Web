/**
 * §10.3 的「拒绝」按钮，以及 §13.5 的拒绝路径。
 *
 * 和批准不同，拒绝不改订单状态：订单本来是 PAID，被拒之后还是 PAID。但 §13.5 明确要求把这次拒绝
 * 记进订单变更记录，写成 `PAID → PAID` 并带上理由。这看着像一条没有变化的记录，实际是订单页上
 * 用户唯一能看到「我申请过、被拒了、理由是什么」的地方——不写的话，用户只看到订单一直是已支付，
 * 而他明明提过申请。这条日志的形状由 shared/orders.mjs 的 rejectionLogEntry 统一给出，避免三个
 * 入口各写一份 from/to。
 *
 * 理由是必填的。§10.3 要求拒绝必须填理由，而这条理由有两个下游读者：用户（他要知道为什么被拒，
 * 以及要补什么材料才能重提）和下一个看这条订单的客服。空理由会让「补齐材料后重提」这条路走不通
 * ——one_open_refund_per_order 允许被拒之后重提，但重提什么得有人说得清。
 */

import { REFUND_APPROVER_GROUPS, rejectionLogEntry } from '../shared/orders.mjs'
import { logOrderStatus, logRefundAction, notifyRefundUser, settleApproval } from './_lib/notify.mjs'
import { orderHref } from '../shared/notifications.mjs'
import { bodyOf, requireUser, send } from './_lib/server.mjs'
import { checkNote, loadForDecision, moveRefund } from './_lib/refunds.mjs'
import { orderNoOf } from './refund-request.mjs'

export async function rejectRefund(db, caller, input) {
  // 权限先判，一次库都不查。理由和 refund-approve 一样：REFUND_APPROVER_GROUPS 是一份名单，
  // 而 rank 阈值将来会把任何一个同为 999 的新组悄悄放进来。
  if (!REFUND_APPROVER_GROUPS.includes(caller.group)) {
    return { status: 403, body: { error: '只有管理员可以审批退款' } }
  }

  const loaded = await loadForDecision(db, input?.refund_id, 'rejected')
  if (!loaded.ok) return { status: loaded.status, body: { error: loaded.error } }
  const { refund, order } = loaded

  const note = checkNote(input?.note, { required: true, label: '拒绝理由' })
  if (!note.ok) return { status: 400, body: { error: note.error } }

  // 拒绝不需要二次确认：它是可逆的（用户可以重提），而二次确认要留给不可逆的操作。
  // 到处都要确认一遍的结果是没人再看确认框写了什么。
  const moved = await moveRefund(db, refund.id, refund.status, 'rejected', {
    decided_by: caller.userId,
    decided_at: new Date().toISOString(),
    decision_note: note.text
  })
  if (!moved) return { status: 409, body: { error: '这条申请已被其他管理员处理' } }

  await logRefundAction(db, {
    refund_id: refund.id,
    actor_id: caller.userId,
    actor_group: caller.group,
    action: 'reject',
    from_status: refund.status,
    to_status: 'rejected',
    amount_minor: refund.amount_minor,
    note: note.text
  })

  // §13.5：订单状态没变，但这次拒绝要出现在订单变更记录里。
  await logOrderStatus(db, {
    ...rejectionLogEntry(order.id, caller.userId, caller.group, note.text),
    source: 'admin'
  })

  try {
    await settleApproval(db, refund.id, 'rejected', caller.userId)
  } catch (err) {
    // 拒绝已经生效，通知没收干净不该让调用方以为拒绝失败。留在 stderr 里，那条通知仍然带按钮，
    // 但按钮点下去会撞上 loadForDecision 的迁移校验并得到 409，不会造成第二次拒绝。
    console.error('审批通知回写失败', { refund_id: refund.id, error: err.message })
  }

  let notified = false
  try {
    const notification = await notifyRefundUser(db, refund.user_id, {
      kind: 'refund',
      scope: 'user',
      recipient_id: refund.user_id,
      title: `退款申请未通过：订单 ${orderNoOf(order.id)}`,
      // 理由直接给用户看。转述一遍只会丢掉「要补什么」这类具体信息，而那正是他需要的。
      body: [
        `订单 ${orderNoOf(order.id)} 的退款申请未获通过。`,
        '',
        '**原因**',
        note.text,
        '',
        '如问题已解决，可以重新提交申请，或在订单页联系售后客服。'
      ].join('\n'),
      state: null,
      order_id: order.id,
      refund_id: refund.id,
      actions: [{ type: 'link', label: '查看订单', href: orderHref(order.id) }]
    })
    notified = notification !== null
  } catch (err) {
    console.error('拒绝通知写入失败', { refund_id: refund.id, error: err.message })
  }

  return {
    status: 200,
    body: {
      refund_id: refund.id,
      status: 'rejected',
      order_status: order.status,
      reason: note.text,
      notified
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
  // rank 阈值只是兜底，真正的名单判断在 rejectRefund 里。
  const auth = await requireUser(req, res, true)
  if (!auth) return
  const input = await bodyOf(req)
  const answer = await rejectRefund(auth.db, { userId: auth.user.id, group: auth.group }, input)
  return send(res, answer.status, answer.body)
}
