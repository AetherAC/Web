/**
 * §1 优惠券的条件与动作。浏览器和 Serverless 函数都从这里读，所以只有一份。
 *
 * 为什么必须共用一份：前端要在结算页把折扣算给用户看，后端核销时要再算一遍。两边算法只要差一分钱，
 * 用户看到的价格和实际扣款就不一致，而这类不一致最先被发现的方式通常是支付渠道的对账差异——
 * 那时候已经很难倒推是哪一张券哪一条规则算错了。所以这里定的是唯一算法，两边都只是调用方。
 *
 * 数据库那边只校验到 `jsonb_typeof(conditions) = 'array'`（见 supabase/schema.sql 的 coupons 表）。
 * 条件集合是开放的——§1.2 列了六种 SKU 匹配和历史订单条件，以后还会加——把每种条件的形状写成 check
 * 约束意味着每加一种条件都要改一次表结构，而且旧行会被新约束判为非法。所以形状校验在这个文件里，
 * 数据库只保证它是个数组。代价是必须所有写入路径都走 validateCoupon()，这一点由 API 层保证。
 *
 * 金额一律是最小货币单位的整数（分/cent）。这个文件里不出现浮点数，也不接受浮点数输入：
 * 0.1 + 0.2 那类误差落在钱上就是对不上账的一分钱。
 */

/** §1.2 的条件类型。 */
export const CONDITION_TYPES = ['amount', 'sku', 'order_history', 'first_order', 'user_group']

/** §1.2 的 SKU 匹配方式。 */
export const SKU_OPERATORS = ['is', 'is_not', 'contains', 'not_contains', 'starts_with', 'ends_with']

/** 金额比较。gte/lte 是含端点的，因为「满 100 减 10」的自然读法包含正好 100。 */
export const AMOUNT_OPERATORS = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq']

/** §1.3 的动作类型。 */
export const ACTION_TYPES = ['delta', 'percent', 'fixed']

// 订单状态的唯一声明在 shared/orders.mjs（那边还管迁移图）。这里转发出来，让券的历史订单条件和
// 订单页读同一份取值——之前这个文件自己列了一份，多出一个枚举里根本不存在的 expired，于是
// statuses:['expired'] 能过校验、查库时才被 Postgres 拒掉。
export { ORDER_STATUSES } from './orders.mjs'
import { ORDER_STATUSES, ORDER_STATUS_LABEL } from './orders.mjs'

const isInt = v => Number.isInteger(v)
const isNonNegInt = v => Number.isInteger(v) && v >= 0
const isStr = v => typeof v === 'string' && v.length > 0
/** 币种统一大写比较：schema 里的 check 是 `^[A-Z]{3}$`，但前端传进来的可能是小写。 */
const cur = v => (typeof v === 'string' ? v.trim().toUpperCase() : '')

/** 校验失败一律返回 { ok:false, error } 而不抛异常——这些错误要原样显示给正在配券的管理员。 */
const fail = error => ({ ok: false, error })
const pass = () => ({ ok: true })

/**
 * 校验一条条件的形状。
 *
 * 未知的 type 判为非法，而不是「忽略它继续」。忽略未知条件的后果是一张券在旧版本代码上比在新版本上
 * 更容易满足——部署顺序会改变折扣结果，这是最难查的一类问题。
 */
export function validateCondition(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return fail('条件必须是对象')
  if (!CONDITION_TYPES.includes(c.type)) return fail(`未知的条件类型：${String(c.type)}`)
  if (c.type === 'amount') {
    if (!AMOUNT_OPERATORS.includes(c.op)) return fail(`金额条件的比较方式不合法：${String(c.op)}`)
    if (!isNonNegInt(c.value)) return fail('金额条件的 value 必须是非负整数（最小货币单位）')
    // 币种是必填的。缺省成站点币种看着方便，但一张券被复制到另一个币种的站点上时会静默地按错的
    // 数量级比较——100 日元和 100 美元差两个数量级，而这种错不会报错，只会少收钱。
    if (!/^[A-Z]{3}$/.test(cur(c.currency))) return fail('金额条件必须指定三字母币种')
    return pass()
  }
  if (c.type === 'sku') {
    if (!SKU_OPERATORS.includes(c.op)) return fail(`SKU 匹配方式不合法：${String(c.op)}`)
    if (!isStr(c.value)) return fail('SKU 条件的 value 不能为空')
    return pass()
  }
  if (c.type === 'order_history') {
    if (!Array.isArray(c.statuses) || c.statuses.length === 0) return fail('历史订单条件至少要选一个状态')
    const bad = c.statuses.find(s => !ORDER_STATUSES.includes(s))
    if (bad) return fail(`未知的订单状态：${String(bad)}`)
    if (!AMOUNT_OPERATORS.includes(c.op)) return fail(`历史订单条件的比较方式不合法：${String(c.op)}`)
    if (!isNonNegInt(c.count)) return fail('历史订单条件的 count 必须是非负整数')
    return pass()
  }
  if (c.type === 'first_order') {
    if (typeof c.value !== 'boolean') return fail('首单条件的 value 必须是布尔值')
    return pass()
  }
  if (c.type === 'user_group') {
    if (!Array.isArray(c.groups) || c.groups.length === 0) return fail('用户组条件至少要选一个组')
    if (c.groups.some(g => !isStr(g))) return fail('用户组条件里有空值')
    return pass()
  }
  return fail(`条件类型 ${c.type} 缺少校验实现`)
}

/**
 * 校验一条动作的形状。
 *
 * percent 用「万分之」而不是百分之的小数：9.5 折写成 9500，一分之差的折扣率也能精确表达，而且不用
 * 在钱的计算路径上引入浮点数。上限 10000 是原价，不允许超过——加价不叫优惠券。
 */
export function validateAction(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return fail('动作必须是对象')
  if (!ACTION_TYPES.includes(a.type)) return fail(`未知的动作类型：${String(a.type)}`)
  if (a.type === 'delta') {
    // delta 允许为负（减价）也允许为正（加价）。允许加价看着奇怪，但 §1.3 写的是「金额增减」，
    // 而组合券里「先加运费再打折」是真实场景。最终金额不为负由 applyActions 兜。
    if (!isInt(a.value)) return fail('金额增减的 value 必须是整数（最小货币单位，可为负）')
    return pass()
  }
  if (a.type === 'percent') {
    if (!isNonNegInt(a.value) || a.value > 10000) return fail('折扣率必须是 0..10000 的整数（万分之，10000 = 原价）')
    return pass()
  }
  if (a.type === 'fixed') {
    if (!isNonNegInt(a.value)) return fail('固定折扣额必须是非负整数（最小货币单位）')
    return pass()
  }
  return fail(`动作类型 ${a.type} 缺少校验实现`)
}

/**
 * 校验整张券。API 的每一个写入路径都必须先过这里，因为数据库只保证 conditions/actions 是数组。
 */
export function validateCoupon(coupon) {
  if (!coupon || typeof coupon !== 'object') return fail('券必须是对象')
  const code = typeof coupon.code === 'string' ? coupon.code.trim() : ''
  // 大写唯一：schema 里的唯一索引建在 upper(code) 上，所以这里不做大写就会出现「输入 abc 建成功、
  // 再输入 ABC 报唯一冲突」这种从提示上看不出原因的失败。
  if (!/^[0-9A-Za-z_-]{3,64}$/.test(code)) return fail('券码只能是 3..64 位的字母、数字、下划线或连字符')
  if (!Array.isArray(coupon.conditions)) return fail('conditions 必须是数组')
  if (!Array.isArray(coupon.actions)) return fail('actions 必须是数组')
  if (coupon.actions.length === 0) return fail('券至少要有一个动作，否则它什么都不做')
  for (const [i, c] of coupon.conditions.entries()) {
    const r = validateCondition(c)
    if (!r.ok) return fail(`第 ${i + 1} 条条件：${r.error}`)
  }
  for (const [i, a] of coupon.actions.entries()) {
    const r = validateAction(a)
    if (!r.ok) return fail(`第 ${i + 1} 个动作：${r.error}`)
  }
  // §1.4 的限制。null 和 0 是两种不同的意思：null = 不限，0 = 一次都不能用。schema 里那两列可为空
  // 就是为了保留这个区别，所以这里不能把 null 折叠成 0。
  for (const k of ['per_user_limit', 'total_limit']) {
    const v = coupon[k]
    if (v !== null && v !== undefined && !isNonNegInt(v)) return fail(`${k} 必须是非负整数或 null（null = 不限）`)
  }
  if (coupon.starts_at && coupon.ends_at && new Date(coupon.starts_at) >= new Date(coupon.ends_at)) {
    return fail('生效时间必须早于失效时间')
  }
  if (coupon.allowed_user_ids !== null && coupon.allowed_user_ids !== undefined) {
    if (!Array.isArray(coupon.allowed_user_ids)) return fail('allowed_user_ids 必须是数组或 null')
    // 空数组不是「不限」，是「谁都不能用」。这是个容易配错的形状，所以直接拒掉并说清楚。
    if (coupon.allowed_user_ids.length === 0) return fail('指定可用用户为空数组会导致谁都不能用；不限制请留空（null）')
  }
  return { ok: true, code: code.toUpperCase() }
}

const compare = (op, left, right) => {
  switch (op) {
    case 'gt': return left > right
    case 'gte': return left >= right
    case 'lt': return left < right
    case 'lte': return left <= right
    case 'eq': return left === right
    case 'neq': return left !== right
    default: return false
  }
}

/**
 * 判断一条条件是否成立。
 *
 * ctx 的形状：{ amountMinor, currency, sku, userGroup, history }
 * history 是调用方查好后传进来的：{ counts: { paid: 3, ... }, total: 5 }。
 * 为什么不在这里查库：这个函数在浏览器里也要跑（结算页要即时预览折扣），浏览器读不到别人的订单，
 * 也不该读到。让调用方负责取数据，这个函数就保持纯函数——纯函数才能在两个环境里给出同一个答案。
 */
export function evaluateCondition(c, ctx) {
  const r = validateCondition(c)
  // 形状不合法的条件判为不成立，而不是抛异常。理由：核销路径上一条脏数据不该让整个结算 500，
  // 而「条件不成立」的效果是券用不了——对用户是提示，对系统是安全的默认。
  if (!r.ok) return false
  if (c.type === 'amount') {
    // 币种不同判不成立，而不是报错。跨币种比金额没有意义，但把它当异常抛出会让一张配错币种的券
    // 在多币种站点上直接 500。判不成立的结果是这张券在该币种下用不了，这正是想要的行为。
    if (cur(c.currency) !== cur(ctx.currency)) return false
    return compare(c.op, Number(ctx.amountMinor), Number(c.value))
  }
  if (c.type === 'sku') {
    const sku = String(ctx.sku ?? '')
    const v = String(c.value)
    switch (c.op) {
      case 'is': return sku === v
      case 'is_not': return sku !== v
      case 'contains': return sku.includes(v)
      case 'not_contains': return !sku.includes(v)
      case 'starts_with': return sku.startsWith(v)
      case 'ends_with': return sku.endsWith(v)
      default: return false
    }
  }
  if (c.type === 'order_history') {
    const counts = ctx.history?.counts ?? {}
    // 多个状态求和，不是逐个比较：「已支付或已退款的订单满 3 笔」是一个条件，不是三个。
    const n = c.statuses.reduce((sum, s) => sum + (Number(counts[s]) || 0), 0)
    return compare(c.op, n, Number(c.count))
  }
  if (c.type === 'first_order') {
    // 首单的判定基准是「有没有付过钱」，不是「有没有下过单」。按下单算的话，一个下了单没付、
    // 过期作废的用户就永远拿不到首单优惠了。
    const paid = Number(ctx.history?.counts?.paid) || 0
    const refunded = Number(ctx.history?.counts?.refunded) || 0
    return c.value === (paid + refunded === 0)
  }
  if (c.type === 'user_group') return c.groups.includes(String(ctx.userGroup ?? 'default'))
  return false
}

/**
 * 全部条件必须同时成立（AND）。
 *
 * 没有做 OR：§1.2 没要求，而条件组合一旦引入嵌套的与或树，管理员界面和这里的求值都要复杂一个量级。
 * 需要 OR 的场景目前都能用「发两张券」表达。返回不成立的那几条是为了让后台能指出是哪一条卡住了。
 */
export function evaluateConditions(conditions, ctx) {
  const list = Array.isArray(conditions) ? conditions : []
  const failed = list.filter(c => !evaluateCondition(c, ctx))
  return { ok: failed.length === 0, failed }
}

/**
 * 依次应用动作，返回最终金额和折扣额。
 *
 * 顺序敏感，而且是有意的：「先减 10 再打 9 折」和「先打 9 折再减 10」结果不同，管理员配置的数组
 * 顺序就是执行顺序。所以这个函数不排序、不合并同类项。
 *
 * 取整只在 percent 这一步发生，方向是让**折扣额**向下取整，也就是零头归商家：101 分打 9.5 折，
 * 应折 5.05 分，实折 5 分，用户付 96 而不是 95。选这个方向的理由是折扣永远不超过应折金额——
 * 反过来（对折扣额向上取整）每笔多折一分，在订单量上是会累加的漏损，而且对不上账时很难定位。
 * 代价要说清楚：小额订单上折扣可能被抹成 0（1 分钱打 9.5 折，应折 0.05 分，实折 0），
 * 这在数学上正确但在「全场 9.5 折」的宣传下会显得没打折。真要避免就改成对折扣额 ceil，
 * 但那是个商务决定，不是技术决定，所以留在这里显式记着而不是悄悄选一个。
 * 另外，取整只能作用在折扣额上，不能作用在最终金额上：那两者的取整结果在边界上不互为补数，
 * 换一个对象就会出现折扣额和「原价减实付」对不上的账。
 */
export function applyActions(actions, amountMinor) {
  const start = Number(amountMinor)
  if (!Number.isInteger(start) || start < 0) throw new TypeError('applyActions 的金额必须是非负整数（最小货币单位）')
  let amount = start
  const steps = []
  for (const a of Array.isArray(actions) ? actions : []) {
    if (!validateAction(a).ok) continue
    const before = amount
    if (a.type === 'delta') amount = amount + a.value
    else if (a.type === 'fixed') amount = amount - a.value
    else if (a.type === 'percent') {
      // 万分之 → 折扣额 = floor(amount * (10000 - value) / 10000)。先乘后除，不先算比率，
      // 因为比率一旦落进浮点数就可能出现 0.9499999 这种把 9.5 折算成 9.49 折的偏差。
      const cut = Math.floor((amount * (10000 - a.value)) / 10000)
      amount = amount - cut
    }
    // 每一步都夹到 0，而不是只夹最后一次。夹在中间是为了让后续的百分比动作作用在 0 上仍是 0，
    // 否则「减 200 再加 100」在一张 100 元的订单上会得到 0 而不是负数再回正——那是两种不同的意图，
    // 而按步夹取的那种更符合管理员看到的动作列表。
    if (amount < 0) amount = 0
    steps.push({ action: a, before, after: amount })
  }
  return { amountMinor: amount, discountMinor: start - amount, steps }
}

/** 后台和结算页都要把规则说给人看，所以描述文本也放在这里，避免两处各写一份中文。 */
export function describeCondition(c) {
  const OP_TEXT = { gt: '大于', gte: '不低于', lt: '小于', lte: '不高于', eq: '等于', neq: '不等于' }
  if (!c || typeof c !== 'object') return '（无效条件）'
  if (c.type === 'amount') return `订单金额${OP_TEXT[c.op] ?? c.op} ${formatMinor(c.value, c.currency)}`
  if (c.type === 'sku') {
    const T = { is: '等于', is_not: '不等于', contains: '包含', not_contains: '不包含', starts_with: '以…开头', ends_with: '以…结尾' }
    return `商品 SKU ${T[c.op] ?? c.op} ${c.value}`
  }
  if (c.type === 'order_history') {
    // 标签也从 orders.mjs 取，不再本地抄一份——抄的那份和取值列表会各自漂移。
    return `历史${c.statuses.map(s => ORDER_STATUS_LABEL[s] ?? s).join('/')}订单数${OP_TEXT[c.op] ?? c.op} ${c.count} 笔`
  }
  if (c.type === 'first_order') return c.value ? '仅限首次购买' : '仅限已购买过的用户'
  if (c.type === 'user_group') return `用户组属于 ${c.groups.join('、')}`
  return '（未知条件）'
}

export function describeAction(a) {
  if (!a || typeof a !== 'object') return '（无效动作）'
  if (a.type === 'delta') return a.value < 0 ? `减 ${formatMinor(-a.value)}` : `加 ${formatMinor(a.value)}`
  if (a.type === 'percent') {
    // 万分之转成人话。9500 是 9.5 折，10000 是原价（不打折），0 是全免。
    const pct = (10000 - a.value) / 100
    if (a.value === 10000) return '不打折'
    if (a.value === 0) return '全额免除'
    return `打 ${(a.value / 1000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} 折（减 ${pct}%）`
  }
  if (a.type === 'fixed') return `固定减 ${formatMinor(a.value)}`
  return '（未知动作）'
}

/**
 * 最小单位整数 → 展示文本。零小数位的币种（JPY/KRW 等）不能除 100，除了就把 1000 日元显示成 10 日元。
 */
export const ZERO_DECIMAL_CURRENCIES = ['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'BIF', 'DJF', 'GNF', 'KMF', 'MGA', 'PYG', 'RWF', 'UGX', 'VUV', 'XAF', 'XOF', 'XPF']
export function formatMinor(minor, currency) {
  const c = cur(currency)
  const n = Number(minor) || 0
  if (c && ZERO_DECIMAL_CURRENCIES.includes(c)) return `${n} ${c}`
  const text = (n / 100).toFixed(2)
  return c ? `${text} ${c}` : text
}

/**
 * §1.4 的可用性判定里不依赖数据库的那一半。
 *
 * 时间窗、启用开关、名单、总量上限都能在这里判；per_user_limit 要数这个用户用过几次，那是数据库的事，
 * 由 public.redeem_coupon() 在一条 UPDATE 里原子地判（见 schema.sql）。为什么不在这里一起判：
 * 「先查再写」在并发下会超发——两个请求同时读到「还剩 1 张」，然后都写成功。这里判出来的结果只用于
 * 提前给出友好提示，最终仍以数据库那次原子核销为准。
 */
export function checkAvailability(coupon, { now = new Date(), userId = null } = {}) {
  if (!coupon) return fail('券不存在')
  if (coupon.enabled === false) return fail('该券已停用')
  const t = now instanceof Date ? now : new Date(now)
  if (coupon.starts_at && t < new Date(coupon.starts_at)) return fail('该券尚未开始')
  if (coupon.ends_at && t > new Date(coupon.ends_at)) return fail('该券已过期')
  if (coupon.total_limit !== null && coupon.total_limit !== undefined && Number(coupon.used_count || 0) >= Number(coupon.total_limit)) {
    return fail('该券已被领完')
  }
  if (Array.isArray(coupon.allowed_user_ids) && coupon.allowed_user_ids.length > 0) {
    if (!userId || !coupon.allowed_user_ids.includes(userId)) return fail('该券不适用于当前账号')
  }
  return pass()
}

/**
 * 一次算完：能不能用 + 用了多少钱。前端预览和后端核销前的预检都调这个。
 *
 * 注意它返回的 discountMinor 是**预计**折扣。真正落到订单上的折扣以 redeem_coupon 成功那一刻
 * 重算的结果为准，因为这中间用户可能改了购物内容，而 conditions 是对内容求值的。
 */
export function quote(coupon, ctx) {
  const avail = checkAvailability(coupon, { now: ctx.now, userId: ctx.userId })
  if (!avail.ok) return { ok: false, error: avail.error, discountMinor: 0, amountMinor: Number(ctx.amountMinor) || 0 }
  const cond = evaluateConditions(coupon.conditions, ctx)
  if (!cond.ok) {
    return {
      ok: false,
      error: `不满足使用条件：${cond.failed.map(describeCondition).join('；')}`,
      discountMinor: 0,
      amountMinor: Number(ctx.amountMinor) || 0
    }
  }
  const applied = applyActions(coupon.actions, ctx.amountMinor)
  return { ok: true, ...applied }
}
