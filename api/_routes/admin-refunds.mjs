/**
 * §10.6 的退款审批看板，以及 §10.8 的可导出审计轨迹。
 *
 * 为什么退款需要一个自己的页面，而不是继续用站内信里那三个按钮：那三个按钮（批准/拒绝/转交）只在
 * 「有人给我发过一条待审批通知」时才存在，而 shared/notifications.mjs 的 ACTION_TYPES 里根本没有
 * execute_refund，所以 §13.4 的「退款成功 / 无法退款」这一对在收件箱里永远点不到——refund-execute.mjs
 * 从写完那天起就没有任何调用方。更要紧的是，通知会被读掉、会被归档、转交之后原来那条通知就不再有
 * 按钮，而一条退款申请的处理进度不该依赖某个人收件箱的状态：48 小时没人管的申请也只是安静躺在某个
 * 收件箱里。这一页按状态查库，所以它看到的是全部，包括从没有人收到过通知的那些。
 *
 * 门槛两档，和 SQL 里的策略一致：读是 STAFF（schema 里 refund_audit_read 的注释写着「客服要能看自己
 * 发起的退款进展，所以是 staff 而不只是 admin」），写是 admin（REFUND_APPROVER_GROUPS 只有 admin）。
 * 四个决定动作仍然各打各自的接口（refund-approve / refund-reject / refund-transfer / refund-execute），
 * 这里一个都不重复实现——那四个文件里的并发保护、金额校验和二次确认是它们各自的一部分，抄一份必然
 * 抄漏一条，而这里漏掉的每一条都直接对应一笔钱。
 *
 * 这里唯一的写动作是 repair，补的是「只写了一半」的申请。approve 和 execute 都是「先改申请、再改
 * 订单」的两步，而 Vercel 上没有事务，所以第二步失败是被设计进来的可能性：两个接口都如实返回
 * order_moved:false / status:'executing'，注释里也都写着「由 §10.6 的看板看到，人工能推完」。在这一页
 * 之前没有任何入口能推完——admin-orders 的 PATCH 明确拒绝 refund_pending 和 refunded（「只能由退款
 * 流程产生」），refund-execute 要求订单必须在 REFUND_PENDING，而 approved 的出边只有 executing。也就是
 * 说一条「已批准、订单还是 PAID」的申请在别处是个永久死结：钱和记录从此对不上，且无处可修。
 */

import { RANK, bodyOf, requireUser, send } from '../_lib/server.mjs'
import { logOrderStatus, logRefundAction, setting } from '../_lib/notify.mjs'
import {
  ORDER_STATUS_LABEL, REFUND_APPROVER_GROUPS, REFUND_INITIATOR_ROLES, REFUND_STATUSES,
  REFUND_STATUS_LABEL, canRefundTransition
} from '../../shared/orders.mjs'
import { isUuid, moveRefund } from '../_lib/refunds.mjs'
import { maskEmail, maskTail, toCsv } from './admin-orders.mjs'

/**
 * 「在途」的定义和 schema 里 one_open_refund_per_order 的谓词逐字一致：终态之外的都占位。
 *
 * 不从 REFUND_TRANSITIONS 推出来——failed 有出边（§10.7 允许重试）却不占位，推不出来。
 */
const CLOSED_STATUSES = ['rejected', 'completed', 'failed']
const OPEN_STATUSES = REFUND_STATUSES.filter(s => !CLOSED_STATUSES.includes(s))

const LIST_COLUMNS = 'id,order_id,user_id,status,amount_minor,currency,reason_code,reason_detail,' +
  'evidence_paths,admin_note,initiated_by,initiator_role,decided_by,decided_at,decision_note,' +
  'transferred_to,escalated_at,reminded_at,executed_at,execution_note,created_at,updated_at'

const PAGE_CAP = 200
const EXPORT_CAP = 2000
const OPEN_SCAN_CAP = 500
const HOUR = 3600_000

/**
 * 三种「只写了一半」的状态，以及各自唯一的补法。
 *
 * 判断只看订单状态，因为订单状态是这笔钱的唯一事实来源；申请上的状态只说明流程走到了哪一步。三种
 * 组合各自只有一个合理的补法，所以这里不给人选：让人在「标成已完成」和「标成失败」之间挑，等于把
 * 一次对账变成一次猜测。
 */
function planRepair(refund, order) {
  if (refund.status === 'approved' && order?.status === 'paid') {
    // 批准时的第二步没落地（refund-approve 那次返回过 order_moved:false）。订单还没进入退款流程，
    // 所以补的是订单：paid → refund_pending，和批准时本该做的那一步一模一样。
    return {
      kind: 'order_move',
      action: 'repair_order_move',
      label: '补齐订单状态（改为退款中）',
      note: '补上批准时未完成的订单状态变更'
    }
  }
  if (refund.status === 'executing' && order?.status === 'refunded') {
    // 登记「退款成功」时第三步没落地。订单已经是 REFUNDED，账面是对的，只有申请没跟上。
    return {
      kind: 'settle',
      to: 'completed',
      action: 'repair_settle_completed',
      label: '补齐申请状态（标为已完成）',
      note: '订单已退款，补上未落地的申请终态'
    }
  }
  if (refund.status === 'executing' && order?.status === 'paid') {
    // 登记「无法退款」时第三步没落地：订单已经退回 PAID（钱没退出去），申请却停在执行中。终态是
    // failed 而不是 completed——订单状态说这笔钱没退。failed 还能回到 executing，所以补完之后换个
    // 渠道退成了，仍然可以再点一次「退款成功」。
    //
    // 这个组合只可能来自那一条路径：成功那一路的订单迁移是 refund_pending → refunded，失败时订单
    // 留在 refund_pending 而不是 paid；而「已批准但订单没动」时申请还是 approved，不是 executing。
    return {
      kind: 'settle',
      to: 'failed',
      action: 'repair_settle_failed',
      label: '补齐申请状态（标为失败）',
      note: '订单已退回已支付，补上未落地的申请终态'
    }
  }
  return null
}

/**
 * 这条申请现在能点哪些按钮。算在服务端，前端只照着画。
 *
 * 两边各算一次的话，界面上亮着的按钮和接口愿意接受的动作会分叉，而分叉的表现是「点了报 409」——
 * 用户看到的是一个坏掉的按钮，而不是一句能照着做的话。
 */
export function actionsFor(refund, order) {
  const out = []
  if (canRefundTransition(refund.status, 'approved')) out.push('approve')
  if (canRefundTransition(refund.status, 'rejected')) out.push('reject')
  if (canRefundTransition(refund.status, 'transferred')) out.push('transfer')
  // 执行段。executing 本身不在状态图的出边里（自环会让「执行中」失去含义），但 refund-execute 允许
  // 「接着走完」上一次没走完的那一步，所以它也算。前提都是订单真的在 REFUND_PENDING。
  const canExecute = (canRefundTransition(refund.status, 'executing') || refund.status === 'executing')
    && order?.status === 'refund_pending'
  if (canExecute) out.push('execute_success', 'execute_failed')
  return out
}

/**
 * 执行按钮不亮时，为什么不亮。
 *
 * 这一段是这一页存在的第二个理由。「已批准但订单还是已支付」这种状态在别处完全看不出成因：订单页
 * 显示已支付、收件箱里那条通知说已批准，两边都没错，只是中间那一步没写完。不把成因写出来的话，
 * 下一个人的处置办法通常是「再退一次款」。
 */
export function executeBlock(refund, order) {
  if (!['approved', 'failed', 'executing'].includes(refund.status)) return ''
  if (order?.status === 'refund_pending') return ''
  if (refund.status === 'approved' && order?.status === 'paid') {
    return '这条申请已批准，但订单没有进入「退款中」——批准时改订单那一步失败过。先点「补齐订单状态」，之后才能登记退款结果。'
  }
  if (refund.status === 'executing' && order?.status === 'refunded') {
    return '订单已经是「已退款」，钱的记录是对的，只有这条申请没落终态。点「补齐申请状态」把它标成已完成即可，不要再退一次款。'
  }
  if (refund.status === 'executing' && order?.status === 'paid') {
    return '订单已退回「已支付」，说明这次退款没成功，只有这条申请没落终态。点「补齐申请状态」把它标成失败，之后仍然可以重试。'
  }
  const label = ORDER_STATUS_LABEL[order?.status] || order?.status || '未知'
  return `订单当前是「${label}」，只有「退款中」的订单可以登记退款结果。`
}

/**
 * 把一批 user_id 换成脱敏后的显示信息，累加进 into。
 *
 * 脱敏用的是 admin-orders 导出的那两个函数，不是抄一份：这一页门槛是 STAFF，比订单列表还低一档，
 * 而那边的注释说清了为什么连管理员看到的也是打过码的（想看完整邮箱有 admin-users，那个接口是 admin
 * 且只返回账号信息）。两份实现迟早会有一份漏掉域名或者少遮一位。
 */
async function peopleFor(db, ids, into = {}) {
  const missing = [...new Set(ids.filter(Boolean))].filter(id => !into[id])
  if (!missing.length) return into
  const { data, error } = await db.from('user_profiles')
    .select('user_id,email,display_name,group_name').in('user_id', missing)
  if (error) throw new Error(`读取用户资料失败：${error.message}`)
  for (const p of data || []) {
    into[p.user_id] = { name: maskTail(p.display_name), email: maskEmail(p.email), group: p.group_name }
  }
  return into
}

/**
 * 给申请补上「订单现在什么状态」「等了多久」「现在等谁」。
 *
 * 订单单独查一次，不用 PostgREST 的嵌套 select：refund_requests.order_id 有外键到 orders，但
 * user_profiles 那一头没有（两张表都指向 auth.users，彼此之间没有外键），既然人已经要单独查，
 * 订单也一起单独查，省一套两种写法。
 */
async function attachContext(db, rows, { timeoutHours }) {
  const people = await peopleFor(db,
    rows.flatMap(r => [r.user_id, r.initiated_by, r.decided_by, r.transferred_to]))

  const orderIds = [...new Set(rows.map(r => r.order_id).filter(Boolean))]
  const orders = {}
  if (orderIds.length) {
    const { data, error } = await db.from('orders')
      .select('id,status,sku,sku_name,amount_minor,paid_amount_minor,currency,paid_currency,paid_at')
      .in('id', orderIds)
    if (error) throw new Error(`读取订单失败：${error.message}`)
    for (const o of data || []) orders[o.id] = o
  }

  const now = Date.now()
  const decorated = rows.map(r => {
    const order = orders[r.order_id] || null
    const created = Date.parse(r.created_at)
    const waited = Number.isFinite(created) ? Math.floor((now - created) / HOUR) : 0
    return {
      ...r,
      order_status: order?.status || '',
      order_sku_name: order?.sku_name || order?.sku || '',
      order_paid_minor: order?.paid_amount_minor ?? order?.amount_minor ?? null,
      waited_hours: waited,
      // 超时只对还在等决定的申请有意义。一条三个月前拒掉的申请「等了 2000 小时」不是问题，把它
      // 标红只会让真正超时的那几条淹在里面。
      overdue: r.status === 'pending' && waited >= timeoutHours,
      // 「这条现在等谁」。转交过就是那个人，否则是全体管理员。不写清这一点的话，一条 transferred_to
      // 已经填好的申请在列表上和没人管的那些长得一模一样。
      waiting_on: OPEN_STATUSES.includes(r.status) ? (r.transferred_to || '') : '',
      actions: actionsFor(r, order),
      execute_block: executeBlock(r, order),
      repair: planRepair(r, order)
    }
  })
  return { rows: decorated, people, orders }
}

/**
 * 看板顶上那三个数字：在途、超时、卡在执行中。
 *
 * 一次查回全部在途申请的三个小列在内存里数，而不是发三次 count 查询。在途申请按定义不会多——终态
 * 不占这个集合，OPEN_STATUSES 里的四个状态每一个都在等某个人做一件事。上限 OPEN_SCAN_CAP 是防呆：
 * 真到了那个量级，「数字准不准」已经不是最要紧的问题了，所以宁可少算也不要让这一页超时。
 */
export async function boardCounts(db, { timeoutHours }) {
  const { data, error } = await db.from('refund_requests')
    .select('id,status,created_at').in('status', OPEN_STATUSES)
    .order('created_at', { ascending: true }).limit(OPEN_SCAN_CAP)
  if (error) return { open: 0, overdue: 0, executing: 0, counted: false }
  const rows = data || []
  const cut = Date.now() - timeoutHours * HOUR
  return {
    open: rows.length,
    overdue: rows.filter(r => r.status === 'pending' && Date.parse(r.created_at) <= cut).length,
    executing: rows.filter(r => r.status === 'executing').length,
    counted: true
  }
}

/**
 * §10.6 的列表。
 *
 * status 除了七个真实状态还接受 open——「还没结束的」是这一页默认要看的东西，而它不是某一个状态，
 * 让前端拼四个状态的 in 列表等于把 OPEN_STATUSES 的定义抄到浏览器里。
 */
export async function listRefunds(db, query, { timeoutHours, cap = PAGE_CAP, pageSize = 20 } = {}) {
  const status = String(query?.status || '').trim()
  if (status && status !== 'open' && !REFUND_STATUSES.includes(status)) {
    return { status: 400, body: { error: `状态必须是 open 或 ${REFUND_STATUSES.join(' / ')} 之一` } }
  }
  const role = String(query?.initiator_role || '').trim()
  if (role && !REFUND_INITIATOR_ROLES.includes(role)) {
    return { status: 400, body: { error: `发起方必须是 ${REFUND_INITIATOR_ROLES.join(' / ')} 之一` } }
  }
  // 这两个要拼进等值过滤器，所以先确认它们真的是 uuid，而不是把随手输入的东西送进查询。
  for (const [key, label] of [['order_id', '订单号'], ['user_id', '用户 ID']]) {
    const v = String(query?.[key] || '').trim()
    if (v && !isUuid(v)) return { status: 400, body: { error: `${label}格式不正确` } }
  }

  const requested = Number(query?.limit)
  const limit = Math.min(Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : pageSize, cap)
  const rawOffset = Number(query?.offset)
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0

  let q = db.from('refund_requests').select(LIST_COLUMNS, { count: 'exact' })
  if (status === 'open') q = q.in('status', OPEN_STATUSES)
  else if (status) q = q.eq('status', status)
  if (role) q = q.eq('initiator_role', role)
  for (const key of ['order_id', 'user_id']) {
    const v = String(query?.[key] || '').trim()
    if (v) q = q.eq(key, v)
  }

  // §10.5 的超时。按 created_at 算，不按 updated_at：转交会刷新 updated_at，而用户从提交那一刻起
  // 就在等——用 updated_at 会让一条被转交过两次的老申请显示成刚刚才来的。
  const overdue = query?.overdue === true || ['1', 'true'].includes(String(query?.overdue || ''))
  if (overdue) {
    q = q.lte('created_at', new Date(Date.now() - timeoutHours * HOUR).toISOString())
    // 显式选了某个状态时只保留时间条件：那时人是在查历史（「上个月超时的都后来怎么了」），
    // 再补一个 status=pending 会让两个条件互相抵消成 0 行。
    if (!status) q = q.eq('status', 'pending')
  }

  const { data, error, count } = await q
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) return { status: 500, body: { error: `读取退款申请失败：${error.message}` } }

  return {
    status: 200,
    body: { refunds: data || [], total: count ?? (data || []).length, limit, offset }
  }
}

/**
 * §10.6 的详情 + §10.8 的审计轨迹。
 *
 * 审计记录按时间正序，和列表的倒序相反：列表要先看到最新的申请，而一条申请的经过要从头读起。
 */
export async function refundDetail(db, refundId, { timeoutHours }) {
  if (!isUuid(refundId)) return { status: 400, body: { error: '申请号格式不正确' } }

  const { data: refund, error } = await db.from('refund_requests')
    .select(LIST_COLUMNS).eq('id', refundId).maybeSingle()
  if (error) return { status: 500, body: { error: `读取退款申请失败：${error.message}` } }
  if (!refund) return { status: 404, body: { error: '退款申请不存在' } }

  const { data: logs, error: logErr } = await db.from('refund_audit_log')
    .select('id,actor_id,actor_group,action,from_status,to_status,amount_minor,note,created_at')
    .eq('refund_id', refundId).order('created_at', { ascending: true })
  if (logErr) return { status: 500, body: { error: `读取审计记录失败：${logErr.message}` } }

  const ctx = await attachContext(db, [refund], { timeoutHours })
  const order = ctx.orders[refund.order_id] || null
  // 审计里的操作人也要能显示成名字，而他们不一定出现在申请那四个字段里：转交给 A、A 再拒绝，
  // decided_by 是 A，但更早那次转交的操作人是别人，而那一行正是「这条申请为什么绕了一圈」的答案。
  await peopleFor(db, (logs || []).map(l => l.actor_id), ctx.people)

  return {
    status: 200,
    body: {
      refund: ctx.rows[0],
      order: order ? { ...order, status_label: ORDER_STATUS_LABEL[order.status] || order.status } : null,
      logs: logs || [],
      people: ctx.people
    }
  }
}

const CSV_COLUMNS = [
  { title: '申请号', pick: r => r.refund_id },
  { title: '订单号', pick: r => r.order_id },
  { title: '时间', pick: r => r.created_at },
  { title: '操作', pick: r => r.action },
  { title: '操作人', pick: r => r.actor },
  { title: '操作人用户组', pick: r => r.actor_group },
  { title: '状态变化', pick: r => (r.from_status || r.to_status ? `${r.from_status || '—'} → ${r.to_status || '—'}` : '') },
  { title: '金额（最小货币单位）', pick: r => r.amount_minor ?? '' },
  { title: '说明', pick: r => r.note }
]

/**
 * §10.8 的导出：一行一个审计事件，而不是一行一条申请。
 *
 * 「全流程可审计」要的是经过，不是结果——谁在什么时候把它从待审批改成了已批准、金额是不是被改过、
 * 转交给了谁。每条申请从出生起就有一行 create（refund-request 会写），所以一条刚提交、还没人动过的
 * 申请在导出里也有一行，不会因为「没有决定记录」而整条消失。
 *
 * 没有单独的开关。§14 里只有 order_export_enabled，那是订单导出的开关；把审计导出一起挂上去，等于
 * 让一个为了订单表设的开关静默地关掉 §10.8 明确要求的能力。上限 EXPORT_CAP 条申请，理由和订单导出
 * 一样：函数内存和 10 秒的限制，超了是 502，看起来像故障而不是「数据太多」。
 */
export async function exportRefundAudit(db, query, { timeoutHours }) {
  const listed = await listRefunds(db, { ...query, limit: query?.limit || EXPORT_CAP, offset: 0 },
    { timeoutHours, cap: EXPORT_CAP, pageSize: EXPORT_CAP })
  if (listed.status !== 200) return listed
  const refunds = listed.body.refunds

  let logs = []
  if (refunds.length) {
    const { data, error } = await db.from('refund_audit_log')
      .select('refund_id,actor_id,actor_group,action,from_status,to_status,amount_minor,note,created_at')
      .in('refund_id', refunds.map(r => r.id)).order('created_at', { ascending: true })
    if (error) return { status: 500, body: { error: `读取审计记录失败：${error.message}` } }
    logs = data || []
  }

  const people = await peopleFor(db, [
    ...refunds.flatMap(r => [r.user_id, r.initiated_by, r.decided_by, r.transferred_to]),
    ...logs.map(l => l.actor_id)
  ])
  const grouped = new Map()
  for (const l of logs) {
    if (!grouped.has(l.refund_id)) grouped.set(l.refund_id, [])
    grouped.get(l.refund_id).push(l)
  }

  const rows = []
  for (const r of refunds) {
    for (const l of grouped.get(r.id) || []) {
      const who = people[l.actor_id]
      rows.push({
        refund_id: r.id, order_id: r.order_id, created_at: l.created_at, action: l.action,
        // 系统写的行没有 actor_id（pg_cron 的升级提醒就是这样），如实写「系统」而不是留空——空
        // 单元格看起来像导出漏了一列。
        actor: who?.name || who?.email || (l.actor_id ? l.actor_id : '系统'),
        actor_group: l.actor_group, from_status: l.from_status, to_status: l.to_status,
        amount_minor: l.amount_minor, note: l.note
      })
    }
  }

  const stamp = new Date().toISOString().slice(0, 10)
  return {
    status: 200,
    csv: toCsv(rows, CSV_COLUMNS),
    filename: `refund-audit-${stamp}.csv`,
    exported: rows.length,
    refunds: refunds.length,
    total: listed.body.total,
    truncated: listed.body.total > refunds.length
  }
}

/**
 * 补齐「只写了一半」的申请。仅管理员，且只做 planRepair 算出来的那一件事。
 *
 * 前端要把 repair.action 一起送上来。不是为了让前端决定做什么——真正做什么仍然由这里重新算一次
 * planRepair 决定——而是为了检出「你看到的和现在的实际情况已经不是一回事」：看板可能开了十分钟，
 * 期间别人已经把它修好了，甚至订单已经被推到别的状态。那时按钮上写的动作和现在该做的动作不一致，
 * 应该让人重新看一眼，而不是默默执行另一件他没打算做的事。
 *
 * 不发站内信。三种情况的用户通知都已经发过了：order_move 那条的批准通知由 refund-approve 发，两条
 * settle 的结果通知由 refund-execute 在改完订单之后发（那一步在第三步之前）。这里补的是内部记录，
 * 用户那边看到的东西一个字都没变，再发一条只会让人以为又发生了一次退款。
 */
export async function repairRefund(db, caller, input) {
  if (!REFUND_APPROVER_GROUPS.includes(caller.group)) {
    return { status: 403, body: { error: '只有管理员可以补齐退款记录' } }
  }
  const refundId = String(input?.refund_id || '')
  if (!isUuid(refundId)) return { status: 400, body: { error: '申请号格式不正确' } }

  const { data: refund, error } = await db.from('refund_requests')
    .select('id,order_id,user_id,status,amount_minor,currency').eq('id', refundId).maybeSingle()
  if (error) return { status: 500, body: { error: `读取退款申请失败：${error.message}` } }
  if (!refund) return { status: 404, body: { error: '退款申请不存在' } }

  const { data: order, error: orderErr } = await db.from('orders')
    .select('id,status').eq('id', refund.order_id).maybeSingle()
  if (orderErr) return { status: 500, body: { error: `读取订单失败：${orderErr.message}` } }
  if (!order) return { status: 404, body: { error: '订单不存在' } }

  const plan = planRepair(refund, order)
  if (!plan) {
    return {
      status: 409,
      body: {
        error: `这条申请不需要补齐：申请是「${REFUND_STATUS_LABEL[refund.status] || refund.status}」，` +
          `订单是「${ORDER_STATUS_LABEL[order.status] || order.status}」，两边是一致的`,
        status: refund.status,
        order_status: order.status
      }
    }
  }
  const wanted = String(input?.action || '')
  if (wanted && wanted !== plan.action) {
    return {
      status: 409,
      body: {
        error: '这条申请的情况已经变了，请刷新后再看该补哪一步',
        expected: plan.action,
        status: refund.status,
        order_status: order.status
      }
    }
  }

  const extra = String(input?.note || '').trim()
  if (extra.length > 2000) return { status: 400, body: { error: '补齐说明请控制在 2000 字以内' } }
  const note = extra ? `${plan.note}：${extra}` : plan.note

  if (plan.kind === 'order_move') {
    // .eq('status','paid') 是并发保护，理由和别处一样：两个管理员同时点，慢的那次影响 0 行而不是
    // 把订单从别的状态强行改成退款中。
    const { data: moved, error: moveErr } = await db.from('orders')
      .update({ status: 'refund_pending', updated_at: new Date().toISOString() })
      .eq('id', order.id).eq('status', 'paid').select('id')
    if (moveErr) return { status: 500, body: { error: `订单状态更新失败：${moveErr.message}` } }
    if (!moved?.length) {
      return { status: 409, body: { error: '订单状态刚刚被改过，请刷新后重试' } }
    }
    await logOrderStatus(db, {
      order_id: order.id,
      from_status: 'paid',
      to_status: 'refund_pending',
      actor_id: caller.userId,
      actor_group: caller.group,
      source: 'admin',
      note
    })
    // 申请状态没动（还是 approved），所以 from/to 都写 approved：这一行记的是「订单被补上了」，
    // 把 to_status 留空会让审计轨迹上这一行看起来像一次失败的迁移。
    await logRefundAction(db, {
      refund_id: refund.id,
      actor_id: caller.userId,
      actor_group: caller.group,
      action: plan.action,
      from_status: refund.status,
      to_status: refund.status,
      amount_minor: refund.amount_minor,
      note
    })
    return {
      status: 200,
      body: { ok: true, refund_id: refund.id, status: refund.status, order_status: 'refund_pending' }
    }
  }

  // settle：只有申请要动，订单已经在它该在的地方。execution_note 不覆盖——refund-execute 那次写的
  // 失败原因是当时的事实，这次补记的原因写进审计轨迹里，两者都要留着。
  const settled = await moveRefund(db, refund.id, 'executing', plan.to)
  if (!settled) return { status: 409, body: { error: '这条申请刚刚被其他管理员处理过，请刷新后重试' } }
  await logRefundAction(db, {
    refund_id: refund.id,
    actor_id: caller.userId,
    actor_group: caller.group,
    action: plan.action,
    from_status: 'executing',
    to_status: plan.to,
    amount_minor: refund.amount_minor,
    note
  })
  return {
    status: 200,
    body: { ok: true, refund_id: refund.id, status: plan.to, order_status: order.status }
  }
}

export default async function handler(req, res) {
  // 门槛 STAFF，和 schema 里 refund_audit_read 一致：客服要能看自己发起的退款走到哪了。四个决定动作
  // 和这里的 repair 都单独判 admin（REFUND_APPROVER_GROUPS），所以看得见不等于点得动。
  const auth = await requireUser(req, res, RANK.STAFF)
  if (!auth) return
  const caller = { userId: auth.user.id, group: auth.group, rank: auth.rank }
  const canDecide = REFUND_APPROVER_GROUPS.includes(auth.group)

  try {
    const timeoutHours = Number(await setting(auth.db, 'refund_approval_timeout_hours', 48)) || 48
    const pageSize = Number(await setting(auth.db, 'order_list_page_size', 20)) || 20

    if (req.method === 'GET') {
      const query = req.query || {}

      if (query.refund_id) {
        const detail = await refundDetail(auth.db, query.refund_id, { timeoutHours })
        if (detail.status !== 200) return send(res, detail.status, detail.body)
        return send(res, 200, { ...detail.body, can_decide: canDecide })
      }

      if (String(query.view || '') === 'export') {
        const out = await exportRefundAudit(auth.db, query, { timeoutHours })
        if (out.status !== 200) return send(res, out.status, out.body)
        res.status(200)
        res.setHeader('Content-Type', 'text/csv; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`)
        res.setHeader('X-Export-Total', String(out.total))
        res.setHeader('X-Export-Truncated', out.truncated ? '1' : '0')
        return res.send(out.csv)
      }

      const listed = await listRefunds(auth.db, query, { timeoutHours, pageSize })
      if (listed.status !== 200) return send(res, listed.status, listed.body)
      const ctx = await attachContext(auth.db, listed.body.refunds, { timeoutHours })
      const counts = await boardCounts(auth.db, { timeoutHours })
      return send(res, 200, {
        ...listed.body,
        refunds: ctx.rows,
        people: ctx.people,
        counts,
        page_size: pageSize,
        can_decide: canDecide,
        // §14 的三个值一起下发：前端要用 timeout_hours 说明「超时」是多久，用 require_confirm 决定
        // 是否先弹二次确认（服务端仍然会判，这里只是让人少挨一次 428），用 auto_execute 决定要不要
        // 提示「自动执行已开启」——那时手工登记的语义完全不同。
        timeout_hours: timeoutHours,
        reminder_interval_hours: Number(await setting(auth.db, 'refund_reminder_interval_hours', 24)) || 24,
        require_confirm: await setting(auth.db, 'refund_require_second_confirm', true),
        auto_execute: await setting(auth.db, 'refund_auto_execute', false)
      })
    }

    if (req.method === 'POST') {
      const input = await bodyOf(req)
      const action = String(input?.action_kind || 'repair')
      if (action !== 'repair') {
        return send(res, 400, { error: '这个接口只处理补齐动作，审批请用对应的退款接口' })
      }
      const out = await repairRefund(auth.db, caller, input)
      return send(res, out.status, out.body)
    }

    return send(res, 405, { error: 'Method not allowed' })
  } catch (e) {
    console.error('admin-refunds 失败', e)
    return send(res, 500, { error: '退款看板接口出错' })
  }
}

