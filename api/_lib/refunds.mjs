/**
 * §10.3 的三个审批动作（批准/拒绝/转交）共用的部分。
 *
 * 三个动作各有一个接口，因为前端那三个按钮打的是三个地址（见 shared/notifications.mjs 的
 * ACTION_ENDPOINT）。但「取出申请、确认申请还在待审批、确认订单状态没被别人改过」这三步对三者
 * 完全一样，而这三步里任何一步松掉都会让同一条申请被处理两次——一次批准一次拒绝，钱退了但订单
 * 记录说被拒了。所以这段只有一份。
 */

import { assertRefundTransition } from '../../shared/orders.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isUuid = s => UUID.test(String(s || ''))

/**
 * 取出一条申请和它的订单，并确认它能迁移到 next。
 *
 * 返回 { ok:false, status, error } 或 { ok:true, refund, order }。把「读不到」「状态不对」这些
 * 情况在这里一次答完，是为了让三个接口的正文只剩下各自真正不同的那部分。
 *
 * resumable：申请此刻已经就在 next 上时不再套状态图。状态图里没有 executing → executing 这条边，
 * 那是对的——自环会让「执行中」这个状态失去含义。但 refund-execute 的第二步失败时会有意把申请留在
 * executing、订单留在 REFUND_PENDING，等人再点一次把它走完（那个文件开头那段就是这么写的），而那一次
 * 的语义是「接着走完」，不是一次新的迁移。不给这个开关的话，那些申请会被这里挡在
 * 409「退款申请不能从执行中变更为执行中」——而它们被留在 executing 的全部目的就是避免这种死路。
 */
export async function loadForDecision(db, refundId, next, { resumable = false } = {}) {
  if (!isUuid(refundId)) return { ok: false, status: 400, error: '退款申请号格式不正确' }

  const { data: refund, error } = await db.from('refund_requests')
    .select('id,order_id,user_id,status,amount_minor,currency,reason_detail,initiated_by,initiator_role')
    .eq('id', refundId).maybeSingle()
  if (error) return { ok: false, status: 500, error: '读取退款申请失败' }
  if (!refund) return { ok: false, status: 404, error: '退款申请不存在' }

  if (!(resumable && refund.status === next)) {
    const move = assertRefundTransition(refund.status, next)
    if (!move.ok) return { ok: false, status: 409, error: move.error }
  }

  const { data: order, error: orderErr } = await db.from('orders')
    .select('id,user_id,status,amount_minor,paid_amount_minor,currency,paid_currency')
    .eq('id', refund.order_id).maybeSingle()
  if (orderErr) return { ok: false, status: 500, error: '读取订单失败' }
  if (!order) return { ok: false, status: 404, error: '订单不存在' }

  return { ok: true, refund, order }
}

/**
 * 把申请从 from 迁到 to，条件是它此刻仍然是 from。
 *
 * 这个 .eq('status', from) 是三个接口全部的并发保护。上面 loadForDecision 里已经查过一次状态，
 * 但那次查询和这次写入之间有一段时间，两个管理员同时点不同按钮就会都通过检查。带上条件之后，
 * 慢的那次影响 0 行，调用方据此知道自己不是做决定的那个人。
 *
 * 返回受影响的行，0 行表示被别人抢先了。
 */
export async function moveRefund(db, refundId, from, to, patch = {}) {
  const { data, error } = await db.from('refund_requests')
    .update({ ...patch, status: to, updated_at: new Date().toISOString() })
    .eq('id', refundId).eq('status', from)
    .select('id,status')
  if (error) throw new Error(`退款状态更新失败：${error.message}`)
  return data?.length ?? 0
}

/** 三个接口都要求填写说明的那部分校验。批准可以不填，拒绝和转交必填（§10.3）。 */
export function checkNote(note, { required, label }) {
  const text = String(note || '').trim()
  if (required && !text) return { ok: false, error: `请填写${label}` }
  if (text.length > 2000) return { ok: false, error: `${label}请控制在 2000 字以内` }
  return { ok: true, text }
}

