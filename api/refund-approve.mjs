/**
 * §10.3 的「批准」按钮 + §13.4 的 PAID → REFUND_PENDING。
 *
 * 批准做四件事，顺序有讲究：先把申请从 pending 迁到 approved（带 status 条件，抢不到就直接返回），
 * 再把订单迁到 refund_pending，再写状态日志，最后收掉那条审批通知的置顶。
 *
 * 为什么申请要排在订单之前：如果先改订单、再改申请，而改申请时发现被别人抢先了，订单已经进了
 * REFUND_PENDING 而申请是「已拒绝」——订单卡在退款中，没有任何在途申请能把它推下去。反过来则安全：
 * 抢到申请的那次一定是唯一一次，后面几步都是它一个人在做。
 *
 * Vercel 上没有事务可用（每次调用都是独立的 HTTP 请求，Supabase 的 JS 客户端也不开事务），
 * 所以正确性靠的是「唯一一个写者」而不是回滚。这也是上面那个顺序不能反的原因。
 */

import { bodyOf, requireUser, send } from './_lib/server.mjs'
import { logOrderStatus, logRefundAction, setting, settleApproval } from './_lib/notify.mjs'
import { checkNote, loadForDecision, moveRefund } from './_lib/refunds.mjs'
import { REFUND_APPROVER_GROUPS, assertTransition, validateRefundAmount } from '../shared/orders.mjs'

export async function approveRefund(db, caller, input) {
  if (!REFUND_APPROVER_GROUPS.includes(caller.group)) {
    return { status: 403, body: { error: '只有管理员可以审批退款' } }
  }

  const loaded = await loadForDecision(db, input?.refund_id, 'approved')
  if (!loaded.ok) return { status: loaded.status, body: { error: loaded.error } }
  const { refund, order } = loaded

  const note = checkNote(input?.note, { required: false, label: '审批说明' })
  if (!note.ok) return { status: 400, body: { error: note.error } }

  // §14 的 refund_require_second_confirm。开着的时候必须带上 confirm，因为批准之后钱就在路上了,
  // 而这个接口没有撤销动作——§13 的状态图里 REFUND_PENDING 只能走向 REFUNDED 或退回 PAID，
  // 前者不可逆。开关在服务端再验一遍而不是只靠前端弹窗：弹窗拦不住直接打接口的人。
  if (await setting(db, 'refund_require_second_confirm', true)) {
    if (input?.confirm !== true) {
      return { status: 428, body: { error: '批准退款需要二次确认', requires_confirm: true } }
    }
  }

  // 管理员可以在批准时改金额（§10.2 的上限对所有人一样：不得超过实付）。
  let amountMinor = refund.amount_minor
  if (input?.amount_minor !== undefined && input?.amount_minor !== null) {
    const checked = validateRefundAmount(order, input.amount_minor)
    if (!checked.ok) return { status: 400, body: { error: checked.error } }
    amountMinor = checked.amountMinor
  }

  // 订单必须还在 PAID。§13.1 只允许从这里进退款中，而申请提交到审批之间订单可能被别的路径动过。
  const orderMove = assertTransition(order.status, 'refund_pending')
  if (!orderMove.ok) return { status: 409, body: { error: orderMove.error } }

  const moved = await moveRefund(db, refund.id, 'pending', 'approved', {
    decided_by: caller.userId,
    decided_at: new Date().toISOString(),
    decision_note: note.text,
    amount_minor: amountMinor
  })
  if (moved === 0) return { status: 409, body: { error: '这条申请已被其他管理员处理' } }

  await logRefundAction(db, {
    refund_id: refund.id, actor_id: caller.userId, actor_group: caller.group,
    action: 'approve', from_status: 'pending', to_status: 'approved',
    amount_minor: amountMinor, note: note.text
  })

  // §13.4：订单进入退款中，并留下一条 PAID → REFUND_PENDING。
  // 这次 update 也带 status 条件，理由和 moveRefund 一样——批准和别的路径（比如管理员在订单详情里
  // 直接操作）之间同样有窗口。抢不到就如实报告：申请已批准但订单没动，需要人看一眼。
  const { data: orderRows, error: orderErr } = await db.from('orders')
    .update({ status: 'refund_pending', updated_at: new Date().toISOString() })
    .eq('id', order.id).eq('status', 'paid')
    .select('id')
  const orderMoved = !orderErr && (orderRows?.length ?? 0) > 0
  if (orderMoved) {
    await logOrderStatus(db, {
      order_id: order.id, from_status: 'paid', to_status: 'refund_pending',
      actor_id: caller.userId, actor_group: caller.group, source: 'admin',
      note: note.text ? `退款申请已批准：${note.text}` : '退款申请已批准'
    })
  } else {
    console.error('订单未能进入退款中', { order_id: order.id, refund_id: refund.id, error: orderErr?.message })
    await logRefundAction(db, {
      refund_id: refund.id, actor_id: caller.userId, actor_group: caller.group,
      action: 'order_move_failed', from_status: 'paid', to_status: 'refund_pending',
      note: '批准已生效，但订单状态未能更新，需要人工核对'
    })
  }

  // §9.6：那条带三个按钮的站内信要停止置顶，并留下「已批准」。这一步失败不该让批准回滚——
  // 批准已经生效了，通知只是它的展示面。所以这里吞掉错误，只记日志。
  try {
    await settleApproval(db, refund.id, 'approved', caller.userId)
  } catch (e) {
    console.error('审批通知回写失败', { refund_id: refund.id, error: e.message })
  }

  // §14 的 refund_auto_execute。默认关闭，因为 §13.4 要求「退款成功」是人手动点的——
  // 支付渠道那边到底退没退成，这个系统没有可靠的自动判据，自动置为已退款等于凭猜测改账。
  const autoExecute = await setting(db, 'refund_auto_execute', false)

  return {
    status: 200,
    body: {
      refund_id: refund.id, status: 'approved', amount_minor: amountMinor,
      order_status: orderMoved ? 'refund_pending' : order.status,
      order_moved: orderMoved, auto_execute: autoExecute === true
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
  // 门槛设成 admin 的 rank，但组名仍然在 approveRefund 里再查一遍：rank 是个阈值，将来加一个
  // 同为 999 的组会悄悄获得审批权，而 REFUND_APPROVER_GROUPS 是一份明确的名单。
  const auth = await requireUser(req, res, true)
  if (!auth) return
  try {
    const input = await bodyOf(req)
    const result = await approveRefund(auth.db, { userId: auth.user.id, group: auth.group }, input)
    return send(res, result.status, result.body)
  } catch (e) {
    console.error('refund-approve 失败', e)
    return send(res, 500, { error: '批准退款失败' })
  }
}
