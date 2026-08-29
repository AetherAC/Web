// Buyer-initiated cancellation of a pending order.
//
// This goes through an API route rather than the browser's Supabase client because RLS on `orders`
// grants UPDATE to admins only (`admin_orders_update`), and widening that policy would let a buyer
// PATCH any column of their own row — `amount_minor` included, since a policy cannot restrict which
// columns an update touches. Here the server decides: status and checkout_url, nothing else.
//
// `auth.db` is the service client and bypasses RLS, so the `.eq('user_id', …)` below *is* the
// authorization check. It is not decoration.
import { bodyOf, requireUser, send } from './_lib/server.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The whole decision, with `db` passed in so a test can hold it to the filters it must apply. Returns
 * `{ status, body }` rather than writing to the response.
 */
export async function cancelPendingOrder(db, userId, orderId) {
  // Checked here so a malformed id answers 400 rather than surfacing Postgres's 22P02 as a 500.
  if (!UUID.test(String(orderId || ''))) return { status: 400, body: { error: 'order_id 必须是订单的 UUID' } }

  // One statement does the whole thing: the three filters are ownership, target and precondition, and
  // Postgres applies them atomically. Two clicks on the cancel button cannot both succeed, and a
  // callback marking the order paid in the same instant either wins or loses cleanly — there is no
  // read-then-write window for it to slip through. `checkout_url` is cleared so the site stops offering
  // a hosted payment page for an order that is no longer live.
  const { data: cancelled, error } = await db.from('orders')
    .update({ status: 'cancelled', checkout_url: null })
    .eq('id', orderId).eq('user_id', userId).eq('status', 'pending')
    .select().maybeSingle()
  if (error) throw error

  if (!cancelled) {
    // Nothing matched. Separate "not yours / does not exist" from "wrong status" so the buyer gets a
    // useful message, while still scoping the lookup to their own rows: someone probing another
    // account's order id must not be able to tell an existing order from a missing one.
    const { data: existing } = await db.from('orders')
      .select('id,status').eq('id', orderId).eq('user_id', userId).maybeSingle()
    if (!existing) return { status: 404, body: { error: '订单不存在，或不属于当前账户' } }
    return { status: 409, body: { error: `订单当前状态为 ${existing.status}，只有待支付的订单可以取消`, order: existing } }
  }

  // 券的名额不在这里退。orders_release_coupon 那个触发器会在 pending → cancelled 时调 release_coupon，
  // 因为能让订单离开 pending 的地方不止这一处（管理员改状态、下单失败回滚、以后的超时清理），在每处各写
  // 一遍就意味着漏掉一处而没人发现。
  //
  // Deliberately one-way: if the buyer had the hosted checkout open in another tab and pays after this,
  // the provider callback still marks the order paid. Money actually received should hand over the
  // artifact rather than vanish into a cancelled row — so the UI tells them to close that page.
  return { status: 200, body: { order: cancelled } }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    const input = await bodyOf(req)
    const { status, body } = await cancelPendingOrder(auth.db, auth.user.id, input.order_id)
    return send(res, status, body)
  } catch (error) { return send(res, 500, { error: error.message }) }
}
