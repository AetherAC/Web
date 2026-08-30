/**
 * §1 的券管理：客服和管理员建券、改券，管理员删券。
 *
 * 门槛跟着 schema.sql 里那四条策略（coupons_staff_read/insert/update + coupons_admin_delete）：
 * 建和改是 staff（§1.1 说管理员和客服都能发券），删是 admin。删除留给管理员的理由在 schema 的注释里
 * ——coupon_redemptions 是 on delete cascade，删一张用过的券会把它的核销记录一起带走，而那是订单
 * 折扣的唯一凭据。
 *
 * 走接口而不是让后台直接写表：券的形状（conditions/actions 两个 jsonb 数组）SQL 的 check 只能保证
 * 「是数组」，具体形状由 shared/coupons.mjs 校验。让浏览器直接 insert 的话，一条 op 拼错的条件会静静
 * 落库，然后在某个用户的结算页上被 evaluateCondition 判为「不成立」——券永远用不了，而后台看着一切正常。
 */

import { bodyOf, RANK, requireUser, send } from '../_lib/server.mjs'
import { describeAction, describeCondition, validateCoupon } from '../../shared/coupons.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 可写的列。白名单而不是黑名单：漏掉一个不该写的列，后果是它能被写。 */
const WRITABLE = [
  'code', 'name', 'description', 'enabled', 'conditions', 'actions',
  'starts_at', 'ends_at', 'per_user_limit', 'total_limit', 'allowed_user_ids'
]

/**
 * used_count 不在白名单里，这一条单独说：它是 total_limit 的账本，由 public.redeem_coupon() 在一条
 * 带条件的 UPDATE 里加。允许后台改它等于允许把「已发完」的券改回「还有余量」，而余量是靠这个数
 * 和 total_limit 比出来的——改一次就是一次超发，且事后从 coupon_redemptions 能看出对不上，
 * 但没人会去比。
 */
export const NEVER_WRITABLE = ['id', 'used_count', 'created_by', 'created_at', 'updated_at']

const isoOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined
}

/** null 表示不限，0 表示一次都不能用——两者不同（schema 里那条 check 也是这么写的）。 */
const limitOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

/**
 * 把请求里的字段整理成可以落库的一行。
 *
 * 返回 { ok:false, error } 或 { ok:true, patch }。只挑白名单里出现过的键，所以 PATCH 可以只带
 * 想改的那几个字段，而不用把整张券回传——后者会让两个客服同时编辑时，后保存的那个把前一个的改动
 * 覆盖成自己打开页面时的旧值。
 */
export function shapeCoupon(input, { partial }) {
  const patch = {}
  for (const key of Object.keys(input || {})) {
    if (NEVER_WRITABLE.includes(key)) {
      return { ok: false, error: `${key} 不能通过接口修改` }
    }
  }

  if (input?.code !== undefined) patch.code = String(input.code).trim().toUpperCase()
  for (const key of ['name', 'description']) {
    if (input?.[key] !== undefined) patch[key] = String(input[key] ?? '').trim()
  }
  if (input?.enabled !== undefined) patch.enabled = input.enabled === true

  for (const key of ['conditions', 'actions']) {
    if (input?.[key] !== undefined) {
      if (!Array.isArray(input[key])) return { ok: false, error: `${key} 必须是数组` }
      patch[key] = input[key]
    }
  }

  for (const key of ['starts_at', 'ends_at']) {
    if (input?.[key] !== undefined) {
      const v = isoOrNull(input[key])
      if (v === undefined) return { ok: false, error: `${key} 不是合法的时间` }
      patch[key] = v
    }
  }
  for (const key of ['per_user_limit', 'total_limit']) {
    if (input?.[key] !== undefined) {
      const v = limitOrNull(input[key])
      if (v === undefined) return { ok: false, error: `${key} 必须是不小于 0 的整数，或留空表示不限` }
      patch[key] = v
    }
  }
  if (input?.allowed_user_ids !== undefined) {
    const list = input.allowed_user_ids
    if (!Array.isArray(list)) return { ok: false, error: 'allowed_user_ids 必须是数组' }
    const bad = list.find(id => !UUID.test(String(id)))
    if (bad !== undefined) return { ok: false, error: `allowed_user_ids 里有不合法的用户 ID：${String(bad).slice(0, 40)}` }
    patch.allowed_user_ids = [...new Set(list.map(String))]
  }

  if (!partial) {
    if (!patch.code) return { ok: false, error: '请填写券码' }
    // 没有任何动作的券是一张不打折的券。它能建、能发、用户能输，然后折扣是 0——一个只会在
    // 「为什么没减钱」的工单里被发现的配置错误。
    if (!patch.actions?.length) return { ok: false, error: '至少要配置一个优惠动作，否则这张券不会减任何钱' }
    patch.conditions ??= []
  }

  // 形状校验交给 shared/coupons.mjs：那一份前端也在用，两边判定必须同源。这里只在字段齐全时校验
  // （PATCH 只改名字时没有 conditions 可校验），落库前的完整校验由下面读回旧行后再做一次。
  return { ok: true, patch }
}

const listColumns = 'id,code,name,description,enabled,conditions,actions,starts_at,ends_at,per_user_limit,total_limit,allowed_user_ids,used_count,created_by,created_at,updated_at'

/**
 * 「不限用户」在三层里有两种写法，这个函数是它们之间的翻译。
 *
 *   - 数据库：allowed_user_ids 是 `not null default '{}'`，所以「不限」只能是空数组，null 存不进去。
 *   - 求值层：shared/coupons.mjs 的 checkAvailability 和 SQL 的 redeem_coupon 都把空数组当「不限」。
 *   - 校验层：同一个文件里的 validateCoupon 明确拒绝空数组，理由是「空数组不是不限，是谁都不能用」，
 *     并让调用方改用 null。
 *
 * 于是有一个洞：一张不限用户的券，它在库里的形状（[]）正好是 validateCoupon 唯一拒绝的形状。不翻译
 * 的话，后台每次保存一张不限用户的券都会被自己的校验挡住，而报错信息让人去填一个存不进去的 null。
 *
 * 翻译方向选「校验时把空数组当 null」，不是「改 validateCoupon 接受空数组」：那个函数前端也在用，
 * 而它那条检查防的是一种真实的误配（后台的多选框空着提交，管理员以为是「不限」，但如果哪天存储层
 * 改成可空，空数组就会变成「谁都不能用」）。留着那条检查、在唯一的写入口做翻译，是把这两件事都
 * 保住的办法。tests/api-smoke.mjs 里钉了这三层的解释一致。
 */
export const forValidation = (row) => ({
  ...row,
  allowed_user_ids: Array.isArray(row.allowed_user_ids) && row.allowed_user_ids.length === 0
    ? null : row.allowed_user_ids
})

/** §1 的券列表。带上核销数和剩余量，那是后台唯一能看出「这张券还能发几张」的地方。 */
export async function listCoupons(db) {
  const { data, error } = await db.from('coupons').select(listColumns).order('created_at', { ascending: false }).limit(500)
  if (error) return { status: 500, body: { error: `读取优惠券失败：${error.message}` } }
  const coupons = (data || []).map(c => ({
    ...c,
    remaining: c.total_limit === null || c.total_limit === undefined
      ? null : Math.max(0, Number(c.total_limit) - Number(c.used_count || 0)),
    // 条件和动作的中文说明由 shared 那份生成，后台不自己拼一遍——拼错的表现是「界面写着满 100 减 50，
    // 实际判定是满 100 减 5」，而两份实现里只有求值那份是真的。
    condition_text: (c.conditions || []).map(describeCondition),
    action_text: (c.actions || []).map(describeAction)
  }))
  return { status: 200, body: { coupons } }
}

export async function createCoupon(db, caller, input) {
  const shaped = shapeCoupon(input, { partial: false })
  if (!shaped.ok) return { status: 400, body: { error: shaped.error } }

  const check = validateCoupon(forValidation(shaped.patch))
  if (!check.ok) return { status: 400, body: { error: check.error } }

  // code 用 validateCoupon 返回的那个：它做了 trim + 大写，而库里的 check 约束要求 code = upper(code)。
  const row = { ...shaped.patch, code: check.code, created_by: caller.userId }
  const { data, error } = await db.from('coupons').insert(row).select(listColumns).single()
  // 23505 只能是 coupons_code_key（建在 upper(code) 上）。回一句人话而不是约束名——后台看到
  // "duplicate key value violates unique constraint" 只会以为是系统故障。
  if (error?.code === '23505') return { status: 409, body: { error: `券码 ${check.code} 已存在` } }
  if (error) return { status: 500, body: { error: `创建优惠券失败：${error.message}` } }
  return { status: 201, body: { coupon: data } }
}

export async function updateCoupon(db, couponId, input) {
  if (!UUID.test(String(couponId || ''))) return { status: 400, body: { error: '优惠券 ID 格式不正确' } }

  const shaped = shapeCoupon(input, { partial: true })
  if (!shaped.ok) return { status: 400, body: { error: shaped.error } }
  if (!Object.keys(shaped.patch).length) return { status: 400, body: { error: '没有要修改的字段' } }

  const { data: existing, error: readErr } = await db.from('coupons').select(listColumns).eq('id', couponId).maybeSingle()
  if (readErr) return { status: 500, body: { error: '读取优惠券失败' } }
  if (!existing) return { status: 404, body: { error: '优惠券不存在' } }

  // 校验合并后的整张券，不是只校验补丁。只校验补丁的话，把 ends_at 改到 starts_at 之前是能通过的
  // ——那条规则要两个字段一起看，而补丁里只有一个。
  const merged = { ...existing, ...shaped.patch }
  const check = validateCoupon(forValidation(merged))
  if (!check.ok) return { status: 400, body: { error: check.error } }

  const patch = { ...shaped.patch, updated_at: new Date().toISOString() }
  if (patch.code !== undefined) patch.code = check.code

  // 已经有人用过的券，不许改条件、动作和券码。
  //
  // 改了会发生什么：一个用户三天前用这张券下单，订单上存的是当时的折扣快照（discount_minor），
  // 而 coupon_redemptions 指向的是这张券。改完之后，从券的定义倒推那笔订单的折扣会得到另一个数字，
  // 而对账的人没有任何办法知道定义变过。要改就停用旧券、新建一张——这是多一步操作换一份能对上的账。
  const used = Number(existing.used_count || 0) > 0
  if (used) {
    const frozen = ['code', 'conditions', 'actions'].filter(k => shaped.patch[k] !== undefined)
    if (frozen.length) {
      return {
        status: 409,
        body: { error: `这张券已被使用 ${existing.used_count} 次，${frozen.join('、')} 不能再改；请停用它并新建一张` }
      }
    }
  }

  const { data, error } = await db.from('coupons').update(patch).eq('id', couponId).select(listColumns).single()
  if (error?.code === '23505') return { status: 409, body: { error: `券码 ${patch.code} 已存在` } }
  if (error) return { status: 500, body: { error: `修改优惠券失败：${error.message}` } }
  return { status: 200, body: { coupon: data } }
}

/**
 * 删券。仅管理员，且用过的券不给删。
 *
 * coupon_redemptions 是 on delete cascade，所以删一张用过的券会连带删掉它的核销记录。那些记录是
 * 「这笔订单为什么少收了 25 块」的唯一凭据——订单行上有 discount_minor 和 coupon_code 快照，但没有
 * 「这张券当时的条件是什么」。要下架就停用（enabled=false）：停用的券立刻用不了，记录还在。
 */
export async function deleteCoupon(db, couponId) {
  if (!UUID.test(String(couponId || ''))) return { status: 400, body: { error: '优惠券 ID 格式不正确' } }
  const { data: existing, error } = await db.from('coupons').select('id,code,used_count').eq('id', couponId).maybeSingle()
  if (error) return { status: 500, body: { error: '读取优惠券失败' } }
  if (!existing) return { status: 404, body: { error: '优惠券不存在' } }
  if (Number(existing.used_count || 0) > 0) {
    return {
      status: 409,
      body: { error: `${existing.code} 已被使用 ${existing.used_count} 次，删除会连带删掉核销记录；请改为停用` }
    }
  }
  const { error: delErr } = await db.from('coupons').delete().eq('id', couponId)
  if (delErr) return { status: 500, body: { error: `删除优惠券失败：${delErr.message}` } }
  return { status: 200, body: { ok: true, deleted: existing.code } }
}

export default async function handler(req, res) {
  // 读、建、改是 staff（§1.1：管理员和客服都能发券），删在下面单独判 admin。
  const auth = await requireUser(req, res, RANK.STAFF)
  if (!auth) return
  const caller = { userId: auth.user.id, group: auth.group, rank: auth.rank }
  try {
    if (req.method === 'GET') {
      const result = await listCoupons(auth.db)
      return send(res, result.status, result.body)
    }
    if (req.method === 'POST') {
      const result = await createCoupon(auth.db, caller, await bodyOf(req))
      return send(res, result.status, result.body)
    }
    if (req.method === 'PATCH') {
      const body = await bodyOf(req)
      const { id, ...rest } = body || {}
      const result = await updateCoupon(auth.db, id, rest)
      return send(res, result.status, result.body)
    }
    if (req.method === 'DELETE') {
      if (auth.rank < RANK.ADMIN) return send(res, 403, { error: '只有管理员可以删除优惠券' })
      const body = await bodyOf(req)
      const result = await deleteCoupon(auth.db, body?.id)
      return send(res, result.status, result.body)
    }
    return send(res, 405, { error: 'Method not allowed' })
  } catch (e) {
    console.error('admin-coupons 失败', e)
    return send(res, 500, { error: '优惠券管理接口出错' })
  }
}
