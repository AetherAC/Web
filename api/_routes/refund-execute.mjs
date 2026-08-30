/**
 * §13.4 的「退款成功」按钮，以及状态图里那条「无法退款」的退路。
 *
 * 两个按钮一个接口。理由和 refund-request 一样：这两件事的前置条件完全相同（谁能点、订单必须在
 * REFUND_PENDING、申请必须已批准、并发下只能有一个人点成、订单和申请必须一起动），分成两个文件
 * 必然让其中一份漏掉一条，而这里漏掉的每一条都直接对应一笔钱的账实不符。差别只有两行：终态是
 * REFUNDED 还是回到 PAID。
 *
 * 为什么「退款成功」是人手点的：§14 的 refund_auto_execute 默认关，因为 PayerURL 没有退款接口，
 * 加密渠道更没有。系统拿不到任何「渠道确实把钱退出去了」的凭据，自动标记等于凭猜测改账。所以这个
 * 按钮的语义是「我已经在渠道后台退完了，现在来登记」——它记录的是一件已经发生的事实。
 *
 * 中间为什么要经过 executing：这一步之后还要改订单，而 Vercel 上没有事务。先把申请从 approved 抢到
 * executing，抢到的那个人是唯一一个继续往下走的；如果之后改订单失败，申请停在 executing、订单还在
 * REFUND_PENDING，按钮仍然在，再点一次可以从 executing 往下走完（§10.7 的 executing → completed）。
 * 反过来先改订单的话，订单已经是 REFUNDED 而申请还是 approved——钱记成退了，申请却永远不会完结，
 * 而按钮看订单状态判断显示，此时已经消失，没有任何入口能把它推完。
 *
 * 不可逆性体现在两处：状态图里 refunded 是终态（shared/orders.mjs 的 ORDER_TRANSITIONS.refunded 是
 * 空数组），以及 §14 的 refund_require_second_confirm 在这里必须过。前端弹框拦不住直接调接口的人，
 * 所以确认在服务端判。
 */

import { REFUND_APPROVER_GROUPS, assertTransition, transitionLabel } from '../../shared/orders.mjs'
import { formatMinor } from '../../shared/coupons.mjs'
import { refundDoneNotification } from '../../shared/notifications.mjs'
import { logOrderStatus, logRefundAction, notifyRefundUser, setting } from '../_lib/notify.mjs'
import { bodyOf, requireUser, send } from '../_lib/server.mjs'
import { checkNote, loadForDecision, moveRefund } from '../_lib/refunds.mjs'
import { orderNoOf } from './refund-request.mjs'

/** 两个按钮的差异全部收在这张表里，别处只读它。 */
const OUTCOMES = {
  success: {
    refundTo: 'completed',
    orderTo: 'refunded',
    action: 'execute_success',
    noteRequired: false,
    noteLabel: '执行备注'
  },
  failed: {
    // 「无法退款」：订单退回 PAID。§10.7 里 failed 还能回到 executing，所以这不是死路——
    // 换个渠道退成了，可以再点一次「退款成功」。
    refundTo: 'failed',
    orderTo: 'paid',
    action: 'execute_failed',
    // 退不出去必须说明原因：用户会收到一条「退款未成功」，而那条通知里要能写出为什么。
    noteRequired: true,
    noteLabel: '失败原因'
  }
}

export async function executeRefund(db, caller, input) {
  if (!REFUND_APPROVER_GROUPS.includes(caller.group)) {
    return { status: 403, body: { error: '只有管理员可以标记退款结果' } }
  }

  const outcome = OUTCOMES[String(input?.outcome || '')]
  if (!outcome) {
    return { status: 400, body: { error: 'outcome 只能是 success 或 failed' } }
  }

  const loaded = await loadForDecision(db, input?.refund_id, 'executing')
  if (!loaded.ok) return { status: loaded.status, body: { error: loaded.error } }
  const { refund, order } = loaded

  const note = checkNote(input?.note, { required: outcome.noteRequired, label: outcome.noteLabel })
  if (!note.ok) return { status: 400, body: { error: note.error } }

  // 订单必须在 REFUND_PENDING。这一条不能只靠「申请是 approved」推出来：批准之后改订单那一步
  // 可能失败过（refund-approve 会如实返回 order_moved:false），那时申请已批准而订单还是 PAID，
  // 此时标记退款成功会把一笔没进入退款流程的订单直接改成已退款。
  const orderMove = assertTransition(order.status, outcome.orderTo)
  if (!orderMove.ok) return { status: 409, body: { error: orderMove.error } }
  if (order.status !== 'refund_pending') {
    return { status: 409, body: { error: `只有退款中的订单可以标记退款结果，当前状态：${order.status}` } }
  }

  if (await setting(db, 'refund_require_second_confirm', true)) {
    if (input?.confirm !== true) {
      return {
        status: 428,
        body: {
          error: outcome.refundTo === 'completed'
            ? '标记退款成功不可撤销，请二次确认'
            : '标记无法退款会把订单退回已支付，请二次确认',
          requires_confirm: true
        }
      }
    }
  }

  const now = new Date().toISOString()
  // 第一步：把申请从 approved（或上次失败留下的 failed）抢到 executing。抢到的人才继续。
  const claimed = await moveRefund(db, refund.id, refund.status, 'executing', { executed_at: now })
  if (!claimed) return { status: 409, body: { error: '这条申请正在被其他管理员处理' } }
  await logRefundAction(db, {
    refund_id: refund.id,
    actor_id: caller.userId,
    actor_group: caller.group,
    action: 'execute_claim',
    from_status: refund.status,
    to_status: 'executing',
    amount_minor: refund.amount_minor
  })

  // 第二步：改订单。条件仍然是 refund_pending，所以并发下只有一个人能改成。
  const { data: orderRows, error: orderErr } = await db.from('orders')
    .update({ status: outcome.orderTo, updated_at: now })
    .eq('id', order.id).eq('status', 'refund_pending')
    .select('id')
  const orderMoved = !orderErr && (orderRows?.length ?? 0) > 0

  if (!orderMoved) {
    // 申请留在 executing，订单留在 REFUND_PENDING，按钮还在，可以再点一次。不把申请推到终态是
    // 有意的：终态 + 订单还在退款中，等于一笔钱的状态永久对不上而且没有入口能修。
    console.error('退款执行时订单未能改动', {
      order_id: order.id, refund_id: refund.id, error: orderErr?.message
    })
    await logRefundAction(db, {
      refund_id: refund.id,
      actor_id: caller.userId,
      actor_group: caller.group,
      action: 'execute_order_move_failed',
      from_status: 'executing',
      to_status: 'executing',
      note: orderErr?.message || '订单状态已被其他操作改变'
    })
    return {
      status: 409,
      body: {
        error: '订单状态已变化，退款结果未登记，请刷新后重试',
        refund_id: refund.id,
        status: 'executing',
        order_status: order.status
      }
    }
  }

  await logOrderStatus(db, {
    order_id: order.id,
    from_status: 'refund_pending',
    to_status: outcome.orderTo,
    actor_id: caller.userId,
    actor_group: caller.group,
    source: 'admin',
    note: note.text || transitionLabel('refund_pending', outcome.orderTo)
  })

  // 第三步：申请落终态。到这里订单已经改完，所以即使这一步失败，账面是对的——申请停在 executing
  // 会被 §10.6 的看板看到，人工能推完，而钱已经按订单状态记清楚了。
  const settled = await moveRefund(db, refund.id, 'executing', outcome.refundTo, {
    execution_note: note.text,
    executed_at: now
  })
  await logRefundAction(db, {
    refund_id: refund.id,
    actor_id: caller.userId,
    actor_group: caller.group,
    action: outcome.action,
    from_status: 'executing',
    to_status: outcome.refundTo,
    amount_minor: refund.amount_minor,
    note: note.text
  })

  let notified = false
  try {
    const sent = await notifyRefundUser(db, refund.user_id, refundDoneNotification({
      userId: refund.user_id,
      orderNo: orderNoOf(order.id),
      orderId: order.id,
      amountText: formatMinor(refund.amount_minor, refund.currency),
      ok: outcome.refundTo === 'completed',
      note: note.text
    }))
    notified = sent !== null
  } catch (err) {
    console.error('退款结果通知写入失败', { refund_id: refund.id, error: err.message })
  }

  return {
    status: 200,
    body: {
      refund_id: refund.id,
      status: settled ? outcome.refundTo : 'executing',
      order_status: outcome.orderTo,
      // §13.4：登记之后按钮消失。订单已经不在 REFUND_PENDING，前端据此隐藏，这里如实回报。
      can_execute: false,
      notified
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
  const auth = await requireUser(req, res, true)
  if (!auth) return
  const input = await bodyOf(req)
  const answer = await executeRefund(auth.db, { userId: auth.user.id, group: auth.group }, input)
  return send(res, answer.status, answer.body)
}
