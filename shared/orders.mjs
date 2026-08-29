/**
 * §12/§13 的订单与退款状态机，前后端共用。
 *
 * 这里是「哪些状态迁移合法」的唯一一份声明。放在 shared 是因为三个地方要问同一个问题，而三个地方
 * 各自判断必然会分叉：界面要决定「退款」按钮是亮的还是灰的（§13.2），接口要在写库前拒掉非法迁移
 * （§12.5），日志要把迁移记成 `PAID → REFUND_PENDING` 这种可读形式（§13.4）。
 *
 * 数据库那边还有一道：orders.status 是 public.order_status 枚举，refund_requests.status 是
 * text + check。两边的取值必须和这里逐字一致，tests/api-smoke.mjs 读 schema.sql 对着断言。
 * 少一个值的后果不是报错而是更糟——JS 放行、Postgres 拒收，调用方只拿到一句约束名。
 */

/**
 * 订单状态，和 schema.sql 里 public.order_status 枚举逐字对齐。
 *
 * 没有 expired。曾经有过，但那个值在枚举里从不存在，也没有任何代码写它——一条
 * `statuses:['expired']` 的券条件能过 JS 校验，查库时才被 Postgres 拒掉。废弃的结账单由
 * api/cancel-order.mjs 和 one_pending_order_per_user 那段对账统一落到 cancelled，
 * 「过期」不是一个独立状态。
 */
export const ORDER_STATUSES = ['pending', 'paid', 'failed', 'cancelled', 'refund_pending', 'refunded']

export const ORDER_STATUS_LABEL = {
  pending: '待支付', paid: '已支付', failed: '支付失败',
  cancelled: '已取消', refund_pending: '退款中', refunded: '已退款'
}

/**
 * 合法的订单状态迁移。
 *
 * refund_pending → paid 是 §13 状态图里那个「无法退款」按钮：钱没退成得能退回原状，否则订单
 * 永久卡在退款中。它和 paid → refund_pending 构成一个可来回的环，是整张图里唯一的环。
 *
 * paid → paid 不在这里。§13.5 要求「拒绝退款」记一条 `PAID → PAID` 的日志，但那是一条审计
 * 记录而不是一次迁移——状态压根没动。把它写成合法迁移会让 canTransition('paid','paid') 为真，
 * 于是任何幂等性检查都失去意义。日志由 logOrderStatus 直接写，不经过这张表。
 */
export const ORDER_TRANSITIONS = {
  pending: ['paid', 'failed', 'cancelled'],
  paid: ['refund_pending'],
  failed: [],
  cancelled: [],
  refund_pending: ['refunded', 'paid'],
  refunded: []
}

/** 终态：没有任何出边。列出来是为了让界面知道哪些订单不用再轮询。 */
export const TERMINAL_ORDER_STATUSES = ORDER_STATUSES.filter(s => ORDER_TRANSITIONS[s].length === 0)

/**
 * §10.4 的退款审批状态。和 schema.sql 里 refund_requests_status_check 逐字对齐。
 *
 * 这张表用 text + check 而不是枚举，理由在 schema.sql 那段注释里（同一事务里加了枚举值就不能
 * 当字面量用，而那个文件整体是一个事务）。对 JS 来说好处是：加一个状态只要改两处字符串。
 */
export const REFUND_STATUSES = ['pending', 'approved', 'rejected', 'transferred', 'executing', 'completed', 'failed']

export const REFUND_STATUS_LABEL = {
  pending: '待审批', approved: '已批准', rejected: '已拒绝', transferred: '已转交',
  executing: '执行中', completed: '已完成', failed: '失败'
}

/**
 * 退款申请的状态迁移。
 *
 * transferred → pending 是 §10.3 的「转交」：转交不是终点，接手的人还得批或拒，所以它绕回
 * 待审批而不是自成一档终态。approved → executing → completed/failed 是 §10.4 的执行段；
 * failed 有出边回到 executing，因为退款失败通常是渠道侧的临时问题，重试比新建一条申请更对
 * ——新建会丢掉整条审批链，而 §10.8 要求审计完整。
 */
export const REFUND_TRANSITIONS = {
  pending: ['approved', 'rejected', 'transferred'],
  approved: ['executing'],
  rejected: [],
  transferred: ['pending', 'approved', 'rejected'],
  executing: ['completed', 'failed'],
  completed: [],
  failed: ['executing']
}

/**
 * §10.7：能替别人提退款的三个组。
 *
 * 名字里的「代提」是关键。用户本人当然能给自己的订单提退款——§13.3 把用户订单页列为三个入口之一，
 * §13.2 还要求那个按钮在不可退时置灰并给悬浮说明，而用户根本没有的按钮不需要置灰。这份名单管的是
 * 「替另一个人提」：客服在工作台里代提，管理员在订单详情里代提。schema 那边的
 * refund_requests_initiator_role_check 允许 'user'，说的是同一件事。
 *
 * 写成枚举而不是 rank 阈值，因为 presale 的 rank 是 777、和 postsale 一样，用阈值会把售前
 * 一起放进来——而售前不该碰钱。这和 shared/groups.mjs 里 EDITOR_GROUPS 是同一个理由。
 */
export const REFUND_PROXY_GROUPS = ['postsale', 'cs', 'admin']

/** initiator_role 的取值，和 refund_requests_initiator_role_check 逐字对齐。 */
export const REFUND_INITIATOR_ROLES = ['user', ...REFUND_PROXY_GROUPS]

/** 只有 admin 能审批。转交也是审批动作的一种，所以同一份名单。 */
export const REFUND_APPROVER_GROUPS = ['admin']

/** 迁移是否合法。未知状态一律返回 false，不抛——调用方通常是在决定按钮亮不亮。 */
export function canTransition(from, to) {
  const out = ORDER_TRANSITIONS[from]
  return Array.isArray(out) && out.includes(to)
}

export function canRefundTransition(from, to) {
  const out = REFUND_TRANSITIONS[from]
  return Array.isArray(out) && out.includes(to)
}

/**
 * §13.4 的日志形式：`PAID → REFUND_PENDING`。
 *
 * 大写加箭头是给人看的，库里存的是小写状态名。两者分开是有意的：日志表的 from_status/to_status
 * 存原始小写值，好让「所有进过退款中的订单」这种查询能直接用 = 比较；这个函数只在渲染时用。
 */
export function transitionLabel(from, to) {
  return `${String(from).toUpperCase()} → ${String(to).toUpperCase()}`
}

/**
 * §13.2：能不能对这个订单发起退款，以及不能的话灰按钮该挂什么悬浮文案。
 *
 * 返回 reason 而不是只返回布尔，因为需求明确要求「按钮置灰并给出悬浮说明」。一个只回 false 的
 * 函数会让三个调用点各自编一句文案，然后三句话不一样。
 *
 * 已经有在途申请也要拦。这一条不能只靠 status——申请刚提交时订单还是 paid（要等批准才进
 * refund_pending，见 §13.3），所以光看订单状态会让同一个订单被提两次。
 */
export function canRequestRefund(order, openRefund = null) {
  if (!order || typeof order !== 'object') return { ok: false, reason: '订单不存在' }
  if (order.status !== 'paid') {
    const label = ORDER_STATUS_LABEL[order.status] || String(order.status)
    if (order.status === 'refund_pending') return { ok: false, reason: '该订单正在退款中' }
    if (order.status === 'refunded') return { ok: false, reason: '该订单已退款' }
    return { ok: false, reason: `只有已支付的订单可以退款，当前状态：${label}` }
  }
  if (openRefund && !['rejected', 'completed'].includes(openRefund.status)) {
    return { ok: false, reason: `已有一条${REFUND_STATUS_LABEL[openRefund.status] || '在途'}的退款申请` }
  }
  const paid = Number(order.paid_amount_minor ?? order.amount_minor)
  if (!Number.isInteger(paid) || paid <= 0) return { ok: false, reason: '该订单没有可退金额' }
  return { ok: true, reason: '', maxAmountMinor: paid }
}

/**
 * §10.2：退款金额可改，但不得超过实付。
 *
 * 上限取 paid_amount_minor，没有就退回 amount_minor——老订单没有前者（那是这次加的列）。
 * 不接受浮点数，理由和 shared/coupons.mjs 一样：钱只走最小货币单位的整数。
 */
export function validateRefundAmount(order, amountMinor) {
  const cap = Number(order?.paid_amount_minor ?? order?.amount_minor)
  if (!Number.isInteger(cap) || cap <= 0) return { ok: false, error: '该订单没有可退金额' }
  // 只收真正的 number，不做字符串转换。Number('1e3') 是 1000——一个字符串可以变成一个完全不像
  // 它的数字，而这里是钱。JSON body 里的金额本来就该是数字，传字符串是调用方的 bug，
  // 应该在这里响亮地拒掉，而不是悄悄转换成某个可能不是对方本意的值。
  const n = amountMinor
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    return { ok: false, error: '退款金额必须是整数（最小货币单位）' }
  }
  if (n <= 0) return { ok: false, error: '退款金额必须大于 0' }
  if (n > cap) return { ok: false, error: `退款金额不得超过实付金额 ${cap}` }
  return { ok: true, error: '', amountMinor: n }
}

/** §12.5：非法迁移要被拒，且错误信息要说清合法的下一步有哪些。 */
export function assertTransition(from, to) {
  if (canTransition(from, to)) return { ok: true, error: '' }
  const out = ORDER_TRANSITIONS[from]
  if (!Array.isArray(out)) return { ok: false, error: `未知的订单状态：${String(from)}` }
  if (out.length === 0) {
    return { ok: false, error: `${ORDER_STATUS_LABEL[from] || from} 是终态，不能再变更` }
  }
  const allowed = out.map(s => ORDER_STATUS_LABEL[s] || s).join('、')
  return { ok: false, error: `不能从${ORDER_STATUS_LABEL[from] || from}变更为${ORDER_STATUS_LABEL[to] || to}，只能改为：${allowed}` }
}

export function assertRefundTransition(from, to) {
  if (canRefundTransition(from, to)) return { ok: true, error: '' }
  const out = REFUND_TRANSITIONS[from]
  if (!Array.isArray(out)) return { ok: false, error: `未知的退款状态：${String(from)}` }
  if (out.length === 0) {
    return { ok: false, error: `${REFUND_STATUS_LABEL[from] || from} 是终态，不能再变更` }
  }
  const allowed = out.map(s => REFUND_STATUS_LABEL[s] || s).join('、')
  return { ok: false, error: `退款申请不能从${REFUND_STATUS_LABEL[from] || from}变更为${REFUND_STATUS_LABEL[to] || to}，只能改为：${allowed}` }
}

/** §13.5：拒绝退款要记一条 PAID → PAID。这里把那条日志的形状固定下来，避免三个调用点各写一遍。 */
export function rejectionLogEntry(orderId, actorId, actorGroup, reason) {
  return {
    order_id: orderId, from_status: 'paid', to_status: 'paid',
    actor_id: actorId, actor_group: actorGroup, source: 'admin',
    note: `退款申请被拒绝：${reason}`
  }
}

