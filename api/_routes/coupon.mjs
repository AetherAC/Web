/**
 * §1 的券码校验：用户在结算页输入一个码，这里回答「能不能用、便宜多少」。
 *
 * 买家永远不直接读 coupons 表（schema.sql 里那条策略只给 staff）。原因不是权限洁癖：券的条件本身就是
 * 不该外泄的信息——「限哪些 SKU」「还剩几张」「限哪几个账号」合起来就是一份可以被薅的地图。所以这个
 * 接口返回的东西刻意贫瘠：能不能用、折多少、券名。conditions、actions、limits、used_count 一个都不给。
 *
 * 折扣的计算走 api/_lib/coupons.mjs，和 api/checkout.mjs 是同一份：预览和下单算出两个数字的话，
 * 用户看到「立减 25」然后下单收到「立减 20」，而那种 bug 只会以工单的形式出现。
 */

import { bodyOf, requireUser, send } from '../_lib/server.mjs'
import { CODE_SHAPE, resolveCoupon } from '../_lib/coupons.mjs'
import { formatMinor } from '../../shared/coupons.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 限流窗口和上限。
 *
 * 为什么需要：券码的形状是 [A-Z0-9][A-Z0-9_-]{2,31}，一个 4 位码只有百万量级组合，而一张没有指定
 * allowed_user_ids 的券对任何猜到码的人都有效——码本身就是全部的保护。这个接口不限流就是一个可以
 * 按秒穷举的接口，而穷举成功的后果是真金白银。
 *
 * 一个真实用户在结算页最多手输几次：打错一次、换一张券再试一次。20 次/10 分钟对他毫无感觉，对脚本
 * 来说是把每秒几百次压到每分钟两次，百万量级的码空间从几小时变成几年。
 *
 * 按账号算而不是按 IP：这个接口要登录才能调，账号是唯一可靠的身份，而 IP 在移动网络下几十人共用。
 * 代价是攻击者可以多注册账号，但注册要过 GitHub OAuth，那是另一道门槛。
 */
const THROTTLE_WINDOW_MS = 10 * 60 * 1000
const THROTTLE_MAX = 20

/**
 * 记一次尝试。写失败只记 stderr——限流的账本写不进去不该让用户用不了券。
 *
 * 这个取舍的方向要说清楚：写失败时限流会短暂失效（少记一次就少算一次）。反过来（写不进就拒绝校验）
 * 意味着 coupon_attempts 一出问题，全站结算页的券功能同时挂掉。前者是一个窗口内多放几次尝试，
 * 后者是可用性事故。
 */
async function recordAttempt(db, userId, code, ok) {
  const { error } = await db.from('coupon_attempts').insert({ user_id: userId, code, ok })
  if (error) console.error('coupon_attempts 写入失败', { user_id: userId, error: error.message })
}

/** 最近窗口内试了几次。超了就不再往下查券——那次查询本身就是攻击者想要的答案。 */
async function overThrottle(db, userId) {
  const since = new Date(Date.now() - THROTTLE_WINDOW_MS).toISOString()
  const { count, error } = await db.from('coupon_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId).gte('created_at', since)
  if (error) {
    // 读不到就放行。理由同 recordAttempt：限流是防滥用的，不是业务的前置条件。
    console.error('coupon_attempts 读取失败', { user_id: userId, error: error.message })
    return false
  }
  return (count ?? 0) >= THROTTLE_MAX
}

/**
 * 校验一个码对某件商品的效果。
 *
 * caller 里要带 group：§1.2 有 user_group 条件，而组名只有服务端知道（前端那份是显示用的，
 * 改了它不该能改变券的判定）。
 */
export async function quoteCoupon(db, caller, input) {
  const code = String(input?.code || '').trim().toUpperCase()
  if (!CODE_SHAPE.test(code)) return { status: 400, body: { ok: false, error: '券码格式不正确' } }

  const artifactId = String(input?.artifact_id || '')
  if (!UUID.test(artifactId)) return { status: 400, body: { ok: false, error: '缺少合法的商品 ID' } }

  if (await overThrottle(db, caller.userId)) {
    return { status: 429, body: { ok: false, error: '尝试次数过多，请稍后再试' } }
  }

  const { data: artifact, error: artErr } = await db.from('artifacts')
    .select('id,sku,name,price_minor,currency').eq('id', artifactId).eq('active', true).maybeSingle()
  if (artErr) return { status: 500, body: { ok: false, error: '读取商品失败' } }
  if (!artifact) return { status: 404, body: { ok: false, error: '商品不存在或已下架' } }

  const resolved = await resolveCoupon(db, {
    code, artifact, userId: caller.userId, userGroup: caller.group
  })

  await recordAttempt(db, caller.userId, code, resolved.ok)

  if (!resolved.ok) {
    // 「不存在」和「已过期」给不同的话是有意的：手上拿着过期券的用户需要知道券过期了，而不是被告知
    // 码不对然后反复重输。这确实泄露了「这个码存在」，但挡穷举靠的是上面的限流——把所有失败说成
    // 同一句会让每个正常用户都困惑，而挡不住一个耐心的脚本。
    //
    // 条件不满足回 200：那是一个正常答案，不是请求出错。做成 4xx 会让前端每个 fetch 的错误分支
    // 都要区分「网络坏了」和「券不满足条件」。
    return { status: resolved.status, body: { ok: false, code, error: resolved.error } }
  }

  return {
    status: 200,
    body: {
      ok: true,
      code,
      // 券名给用户看（「新人首单券」），描述不给：那是管理员写给自己的备注。
      name: resolved.coupon.name || '',
      list_amount_minor: artifact.price_minor,
      discount_minor: resolved.discountMinor,
      amount_minor: resolved.amountMinor,
      currency: artifact.currency,
      // 格式化后的文本一起给。前端自己算就有第二份取整逻辑，而 applyActions 的取整方向（零头归商家）
      // 是个显式的商务决定，只该有一份。
      discount_text: formatMinor(resolved.discountMinor, artifact.currency),
      amount_text: formatMinor(resolved.amountMinor, artifact.currency)
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
  // 任何登录用户都能调（need=0）。要登录是限流的前提：账号是这里唯一可靠的身份。
  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    const result = await quoteCoupon(auth.db, { userId: auth.user.id, group: auth.group }, await bodyOf(req))
    return send(res, result.status, result.body)
  } catch (e) {
    console.error('coupon 校验失败', e)
    return send(res, 500, { error: '优惠券校验失败' })
  }
}
