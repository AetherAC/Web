/**
 * §10.3 的「转交其他管理员」按钮。
 *
 * 转交后申请回到 pending，而不是停在 transferred。§10.7 的状态机里 transferred 能走回 pending，
 * 而这个接口一次做完两步：如果停在 transferred，接手人打开申请时看到的是一个终态之外的中间状态，
 * 他要点什么才能开始审批？没有那个按钮。所以 transferred 在这里只作为审计里的一笔（谁转给了谁），
 * 落库状态直接回到 pending —— 接手人看到的就是一条正常的待审批申请。
 *
 * 为什么还要在 refund_requests 上留 transferred_to：§10.6 的看板要能回答「这条申请现在等谁」。
 * 只靠审计流水的话，得把一条申请的全部历史读回来再取最后一次转交，而看板是列表查询。
 *
 * 转交对象必须是管理员。转给一个非管理员等于把申请扔进一个没人有权限处理的地方，而它同时已经从
 * 原管理员的视野里消失了（那条通知被 settle 掉了）——申请就此静默卡死，直到 §10.5 的 48 小时超时
 * 才有人发现。所以这里查一次 user_profiles，宁可让转交失败也不让申请消失。
 */

import { REFUND_APPROVER_GROUPS } from '../shared/orders.mjs'
import { logRefundAction, insertNotification, settleApproval } from './_lib/notify.mjs'
import { bodyOf, requireUser, send } from './_lib/server.mjs'
import { checkNote, isUuid, loadForDecision, moveRefund } from './_lib/refunds.mjs'
import { orderNoOf } from './refund-request.mjs'
import { formatMinor } from '../shared/coupons.mjs'

export async function transferRefund(db, caller, input) {
  if (!REFUND_APPROVER_GROUPS.includes(caller.group)) {
    return { status: 403, body: { error: '只有管理员可以审批退款' } }
  }

  const target = String(input?.transfer_to || '')
  if (!isUuid(target)) return { status: 400, body: { error: '请选择要转交的管理员' } }
  if (target === caller.userId) {
    // 转给自己是空操作，但它会把那条待审批通知 settle 掉，然后重新发一条——净效果是自己把自己
    // 的待办清掉又建一个，看板上却多出一次转交记录。直接拒掉更诚实。
    return { status: 400, body: { error: '不能转交给自己' } }
  }

  const loaded = await loadForDecision(db, input?.refund_id, 'transferred')
  if (!loaded.ok) return { status: loaded.status, body: { error: loaded.error } }
  const { refund, order } = loaded

  // §10.3 把转交也算成一次要说明理由的决定（shared/notifications.mjs 的 REASON_REQUIRED_ACTIONS
  // 里就有 transfer_refund）：接手人需要知道为什么轮到他，否则他只能从零开始重新判断一遍。
  const note = checkNote(input?.note, { required: true, label: '转交说明' })
  if (!note.ok) return { status: 400, body: { error: note.error } }

  const { data: receiver, error: receiverErr } = await db.from('user_profiles')
    .select('user_id,display_name,group_name').eq('user_id', target).maybeSingle()
  if (receiverErr) return { status: 500, body: { error: '读取转交对象失败' } }
  if (!receiver) return { status: 404, body: { error: '转交对象不存在' } }
  if (!REFUND_APPROVER_GROUPS.includes(receiver.group_name)) {
    return { status: 400, body: { error: '只能转交给管理员' } }
  }

  // 一次 update 走完 transferred → pending 两步，条件仍然是原状态，所以并发下只有一个人能转交。
  // 中间那个 transferred 不落库，只落在审计里：见文件头。
  const moved = await moveRefund(db, refund.id, refund.status, 'pending', {
    transferred_to: target,
    decision_note: note.text
  })
  if (!moved) return { status: 409, body: { error: '这条申请已被其他管理员处理' } }

  await logRefundAction(db, {
    refund_id: refund.id,
    actor_id: caller.userId,
    actor_group: caller.group,
    action: 'transfer',
    from_status: refund.status,
    to_status: 'transferred',
    amount_minor: refund.amount_minor,
    note: `转交给 ${receiver.display_name || target}：${note.text}`
  })
  // 回到 pending 单独记一条，否则审计里的最后一笔是 transferred，和库里的 pending 不一致，
  // 而 §10.8 的导出是拿审计当事实来源的。
  await logRefundAction(db, {
    refund_id: refund.id,
    actor_id: caller.userId,
    actor_group: caller.group,
    action: 'reopen_after_transfer',
    from_status: 'transferred',
    to_status: 'pending',
    amount_minor: refund.amount_minor
  })

  try {
    await settleApproval(db, refund.id, 'transferred', caller.userId)
  } catch (err) {
    console.error('审批通知回写失败', { refund_id: refund.id, error: err.message })
  }

  // 给接手人单独发一条带按钮的通知，scope 是 user 而不是 admin：转交的意思就是「这件事现在归你」，
  // 再广播给全体管理员的话，转交和不转交没有区别。
  const amountText = formatMinor(refund.amount_minor, refund.currency)
  let notified = false
  try {
    await insertNotification(db, {
      kind: 'refund_approval',
      scope: 'user',
      recipient_id: target,
      title: `转交给你的退款审批：订单 ${orderNoOf(order.id)}（${amountText}）`,
      body: [
        `**转交人**：${caller.userId === target ? '你' : caller.userId}`,
        `**订单号**：${orderNoOf(order.id)}`,
        `**退款金额**：${amountText}`,
        '',
        '**转交说明**',
        note.text,
        '',
        '**原始退款原因**',
        refund.reason_detail || '（申请时未填写）'
      ].join('\n'),
      state: 'pending',
      refund_id: refund.id,
      order_id: order.id,
      // 不给「再转交」按钮：一条申请可以被转一次、两次，但按钮上摆着转交就等于邀请把它转下去，
      // 而 §10.5 的 48 小时超时是按申请算的，转多少次都不会重置。要转的人可以在申请详情页里转。
      actions: [
        { type: 'approve_refund', label: `批准退款 ${amountText}`, target: refund.id },
        { type: 'reject_refund', label: '拒绝', target: refund.id }
      ]
    })
    notified = true
  } catch (err) {
    // 通知没发出去，但申请已经回到 pending 并记了 transferred_to，看板上仍然能找到它，
    // 48 小时超时提醒也照样会发。所以这里不回滚，只如实报告。
    console.error('转交通知写入失败', { refund_id: refund.id, target, error: err.message })
  }

  return {
    status: 200,
    body: {
      refund_id: refund.id,
      status: 'pending',
      transferred_to: target,
      transferred_to_name: receiver.display_name || '',
      notified
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
  const auth = await requireUser(req, res, true)
  if (!auth) return
  const input = await bodyOf(req)
  const answer = await transferRefund(auth.db, { userId: auth.user.id, group: auth.group }, input)
  return send(res, answer.status, answer.body)
}
