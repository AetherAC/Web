/**
 * 券的服务端组合逻辑：api/coupon.mjs（结算页预览）和 api/checkout.mjs（真正下单）共用。
 *
 * 为什么必须共用一份：这两条路径算出的折扣要是不一样，用户看到「立减 25」然后下单收到「立减 20」。
 * 那种 bug 没有报错、没有日志，只有工单，而且要拿着两个数字去对代码才能定位。shared/coupons.mjs 里的
 * quote() 已经是纯函数了，但它要的 ctx 得先查库拼出来——历史订单计数、商品的价格和 SKU、用户所在组。
 * 拼 ctx 才是容易两边写歪的那一步，所以它也只该有一份。
 */

import { quote } from '../../shared/coupons.mjs'

export const CODE_SHAPE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/

/** §1.2 的 order_history / first_order 条件要的那份计数。 */
export async function historyOf(db, userId) {
  // 只取状态列，在 JS 里数。六个状态各查一次 count 是六个往返，而一个账号的订单数在这个站点上是
  // 个位数到两位数。limit 是防线不是优化：万一有个刷单账号，也不该让结算页去拉它一万行。
  const { data, error } = await db.from('orders').select('status').eq('user_id', userId).limit(1000)
  if (error) throw new Error(`读取历史订单失败：${error.message}`)
  const counts = {}
  for (const row of data || []) counts[row.status] = (counts[row.status] || 0) + 1
  return { counts, total: (data || []).length }
}

/**
 * 按码取券。不存在返回 null——调用方要分别处理（预览要告诉用户「券不存在」，下单要拒绝整笔请求）。
 *
 * 库里的 code 是大写（那条 check 约束要求 code = upper(code)），唯一索引也建在 upper(code) 上，
 * 所以调用方传进来的码必须先转大写，这里不再转第二遍——转两遍等于给了「哪一层负责」这个问题两个答案。
 */
export async function couponByCode(db, code) {
  const { data, error } = await db.from('coupons')
    .select('id,code,name,enabled,conditions,actions,starts_at,ends_at,total_limit,used_count,allowed_user_ids')
    .eq('code', code).maybeSingle()
  if (error) throw new Error(`读取优惠券失败：${error.message}`)
  return data || null
}

/**
 * 算这张券对这件商品的效果。
 *
 * 金额一律从 artifact 取，不接受调用方传入的金额。前端传金额的话，一张「满 100 减 50」的券可以被一个
 * 声称金额是 100 的请求骗过；而 checkout 那边即使会重算，预览和实际不一致本身就是坑。
 *
 * 数量固定 1，和 api/checkout.mjs 写死的 quantity 一致。哪天 checkout 支持数量了，改这一处，
 * 两条路径同时跟上——这正是把这段放在这里的目的。
 */
export function quoteFor(coupon, { artifact, userId, userGroup, history, now = new Date() }) {
  return quote(coupon, {
    amountMinor: artifact.price_minor,
    currency: artifact.currency,
    sku: artifact.sku,
    userGroup: userGroup ?? 'default',
    userId,
    history,
    now
  })
}

/**
 * 一次做完「取券 + 算折扣」。返回的形状对两个调用方都够用：
 *   { ok:true, coupon, discountMinor, amountMinor }
 *   { ok:false, status, error, coupon }   coupon 可能为 null（码不存在）
 *
 * status 是给调用方参考的 HTTP 码：码不存在是 404，条件不满足是 200（那是一个正常答案，不是请求出错）。
 */
export async function resolveCoupon(db, { code, artifact, userId, userGroup }) {
  const coupon = await couponByCode(db, code)
  if (!coupon) return { ok: false, status: 404, error: '优惠券不存在', coupon: null }

  const history = await historyOf(db, userId)
  const result = quoteFor(coupon, { artifact, userId, userGroup, history })
  if (!result.ok) return { ok: false, status: 200, error: result.error, coupon }

  return { ok: true, coupon, discountMinor: result.discountMinor, amountMinor: result.amountMinor }
}

/**
 * 下单时要写进 orders 的那几列。空码返回原价、无券的形状——调用方不需要分支。
 *
 * 返回 { ok:false, status, error } 时调用方必须直接回错，不能按原价继续：无券下单和用券下单是两笔
 * 金额，券填错了却静默按原价扣钱是最坏的一种「成功」。
 */
export async function couponFieldsFor(db, { code, artifact, userId, userGroup }) {
  const raw = String(code || '').trim().toUpperCase()
  const base = {
    // §5 要显示「下单时的 SKU 名称和描述」。存快照而不是查商品表：商品改名或改描述之后，历史订单上
    // 显示的必须还是买家当时看到的那份。
    sku_name: artifact.name, sku_description: artifact.description || '',
    // list_amount_minor 是划线价，discount_minor 是省下的钱。两个都存，订单页和 §12 的导出才能显示
    // 「原价 / 优惠 / 实付」，而不是只有一个算不回去的最终数字。
    list_amount_minor: artifact.price_minor, discount_minor: 0,
    amount_minor: artifact.price_minor, coupon_id: null, coupon_code: ''
  }
  if (!raw) return { ok: true, coupon: null, fields: base }
  if (!CODE_SHAPE.test(raw)) return { ok: false, status: 400, error: '券码格式不正确' }

  const resolved = await resolveCoupon(db, { code: raw, artifact, userId, userGroup })
  // 预览里「条件不满足」是 200 + ok:false（那是个正常答案）；下单时同一件事是 409——用户是带着一张
  // 他以为能用的券来的，这笔请求不该继续。
  if (!resolved.ok) return { ok: false, status: resolved.status === 404 ? 404 : 409, error: resolved.error }

  return {
    ok: true,
    coupon: resolved.coupon,
    fields: {
      ...base,
      discount_minor: resolved.discountMinor,
      amount_minor: resolved.amountMinor,
      coupon_id: resolved.coupon.id,
      coupon_code: resolved.coupon.code
    }
  }
}

/**
 * 核销，失败就把刚建的订单删掉。
 *
 * 必须在订单 insert 之后调：coupon_redemptions.order_id 有外键指向 orders，订单还不存在时那行插不进去。
 * 于是有一个窗口——订单已建、券还没占住。这个方向是有意选的：反过来（先占券再建单）在建单失败时留下
 * 一个占着名额但没有订单的核销行，而那种孤儿行没有任何东西能把它找出来；现在这个方向失败时留下的是一笔
 * 待支付订单，它有主、有 id，删得掉。
 *
 * 为什么失败一定要删单，而不是留着让买家自己取消：one_pending_order_per_user 是个唯一索引，买家紧接着
 * 的重试会撞上它，得到一句「你已有一笔待支付订单」，而他并不知道自己有。
 */
export async function redeemOrRollback(db, { coupon, order, userId, discountMinor }) {
  if (!coupon) return { ok: true }
  const { data: redeemed, error } = await db.rpc('redeem_coupon', {
    p_coupon: coupon.id, p_user: userId, p_order: order.id, p_discount: discountMinor
  })
  if (!error && redeemed) return { ok: true }

  // 删除带 status='pending'：万一在这几十毫秒里回调已经把订单标成 paid，那笔钱是真收到的，绝不能删。
  await db.from('orders').delete().eq('id', order.id).eq('status', 'pending')
  if (error) console.error('redeem_coupon 调用失败', { order: order.id, error: error.message })
  // 抢不到名额（限量券被别人先用完，或 per_user_limit 刚好在这一刻满了）。resolveCoupon 检查过一次，
  // 但那是一次读——真正的判定在 redeem_coupon 那条带条件的 UPDATE 里。
  return { ok: false, status: 409, error: error ? '优惠券核销失败，请重试' : '优惠券已达使用上限' }
}
