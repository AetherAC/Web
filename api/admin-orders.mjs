/**
 * §12 订单管理页面的后端。
 *
 * 为什么读取也走接口，而不是让浏览器直接查 Supabase：`orders` 上的 RLS 确实允许 rank ≥ 111 读全部
 * 订单（own_orders_read 那条策略），所以理论上前端可以自己查。但 §12.5 要求「用户联系方式脱敏」，而
 * 脱敏是没法用 RLS 表达的——策略只能决定行的可见性，不能决定某一列返回什么。放在前端打码等于没打：
 * 数据已经到了浏览器里，F12 就能看到完整邮箱。所以列表和详情都在服务端组装，脱敏在这里做。
 *
 * 修改仍然只有管理员能做，理由见 api/cancel-order.mjs 的文件头：策略管不了「只能改哪几列」，放开
 * orders 的 UPDATE 等于允许买家 PATCH 自己那行的 amount_minor。
 */

import { bodyOf, RANK, requireUser, send } from './_lib/server.mjs'
import { logOrderStatus, setting } from './_lib/notify.mjs'
import {
  assertTransition, ORDER_STATUSES, ORDER_STATUS_LABEL, ORDER_TRANSITIONS
} from '../shared/orders.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * §12.3 的三个精确搜索项。都是精确匹配，不是模糊匹配——§12.3 写的就是「精确搜索」，而这个接口
 * rank ≥ 111 就能调（§12.2 确认过：加入组织就是拿到这个权限的方式）。模糊搜索会让任何组织成员
 * 能用一个字母把全部订单号捞出来，那是枚举，不是搜索。
 */
const SEARCH_FIELDS = {
  user_id: { columns: ['user_id'], shape: UUID, label: '用户 ID' },
  order_no: { columns: ['id'], shape: UUID, label: '订单号' },
  // 支付 ID 落在两列：payment_reference 是渠道给的流水号（§5 要显示的那个），provider_order_id 是
  // 早期回调写进去的同一个东西。只查一列的话，老订单永远搜不到。
  //
  // 字符集里故意没有逗号和右括号：这两个字符能改写下面 .or() 拼出来的过滤器。今天的支付流水号不含
  // 它们，但这个检查存在的意义是将来某个渠道用了别的格式时在这里失败，而不是在过滤器里静默生效。
  payment_id: { columns: ['payment_reference', 'provider_order_id'], shape: /^[A-Za-z0-9_.:@=+/-]{1,128}$/, label: '支付 ID' }
}

const EXPORT_CAP = 5000

/**
 * 只能通过退款流程达到的状态。
 *
 * 这两个状态在 ORDER_TRANSITIONS 里是合法迁移，但不能从订单详情直接点——它们各自绑着别的东西：
 * refund_pending 要有一条已批准的申请（§13.3 的批准动作产生），refunded 要走 §13.4 的不可逆二次确认
 * 并给用户发站内信。在这里放开等于给了一个「把订单标成已退款但没有任何退款记录」的入口，事后审计
 * 里会出现一笔查不到申请、查不到审批人的退款。
 */
const REFUND_ONLY = new Set(['refund_pending', 'refunded'])

/**
 * §12.5 的联系方式脱敏。
 *
 * 保留首尾字符和完整域名：客服在电话里核对身份时需要能对上「是不是 a***@gmail.com」，全部打成
 * 星号就没法核对了，而留中间几位等于没打。域名不遮是有意的——它不足以定位到人，却是判断「这是不是
 * 公司邮箱」的唯一线索。
 *
 * 管理员看到的也是脱敏后的。想看完整邮箱有 api/admin-users.mjs，那个接口门槛是 admin 且只返回账号
 * 信息；订单列表是 rank ≥ 111 的人都能翻的地方，在这里放完整邮箱等于把它降到 111。
 */
export function maskEmail(email) {
  const raw = String(email || '').trim()
  if (!raw) return ''
  const at = raw.lastIndexOf('@')
  if (at <= 0) return maskTail(raw)
  const name = raw.slice(0, at)
  const domain = raw.slice(at)
  if (name.length <= 2) return `${name[0]}*${domain}`
  return `${name[0]}${'*'.repeat(Math.min(name.length - 2, 6))}${name[name.length - 1]}${domain}`
}

const maskTail = (value) => {
  const raw = String(value || '')
  if (raw.length <= 2) return raw ? `${raw[0]}*` : ''
  return `${raw[0]}${'*'.repeat(Math.min(raw.length - 2, 6))}${raw[raw.length - 1]}`
}

/** 时间筛选（§12.3）。解析不出来就当没填，而不是报错：一个空的日期输入框不该让整页列表 400。 */
const timeBound = (value) => {
  if (!value) return null
  const t = Date.parse(String(value))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/**
 * §12.4 的 CSV。Excel 能直接打开 CSV，所以不引 xlsx 依赖。
 *
 * 每个单元格都加引号并把内部引号翻倍，且以 = + - @ 开头的值前面补一个单引号。后者是因为 Excel 会把
 * 这样的单元格当公式执行：一个显示名叫 `=cmd|...` 的用户能让打开导出文件的人执行命令。订单导出的
 * 内容里有用户可控的字段（sku_name、display_name 都来自别处写入），所以这不是假想。
 *
 * BOM 是必须的：没有它，Excel 用本地代码页解释 UTF-8，中文列名和 SKU 名直接变乱码。
 */
export function toCsv(rows, columns) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v)
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
    return `"${safe.replace(/"/g, '""')}"`
  }
  const lines = [columns.map(c => cell(c.title)).join(',')]
  for (const row of rows) lines.push(columns.map(c => cell(c.pick(row))).join(','))
  return `﻿${lines.join('\r\n')}\r\n`
}

const CSV_COLUMNS = [
  { title: '订单号', pick: o => o.id },
  { title: '创建时间', pick: o => o.created_at },
  { title: '支付时间', pick: o => o.paid_at || '' },
  { title: '状态', pick: o => ORDER_STATUS_LABEL[o.status] || o.status },
  { title: 'SKU', pick: o => o.sku },
  { title: '商品名', pick: o => o.sku_name },
  { title: '数量', pick: o => o.quantity },
  { title: '原价', pick: o => o.list_amount_minor },
  { title: '优惠', pick: o => o.discount_minor },
  { title: '应付', pick: o => o.amount_minor },
  { title: '实付', pick: o => o.paid_amount_minor ?? '' },
  { title: '货币', pick: o => o.paid_currency || o.currency },
  { title: '优惠券', pick: o => o.coupon_code },
  { title: '支付渠道', pick: o => o.provider },
  { title: '支付 ID', pick: o => o.payment_reference || o.provider_order_id || '' },
  { title: '用户 ID', pick: o => o.user_id },
  { title: '用户邮箱', pick: o => o.user_email }
]

const LIST_COLUMNS = [
  'id', 'user_id', 'sku', 'sku_name', 'quantity', 'status', 'provider', 'provider_order_id',
  'payment_reference', 'amount_minor', 'list_amount_minor', 'discount_minor', 'paid_amount_minor',
  'currency', 'paid_currency', 'coupon_code', 'created_at', 'paid_at', 'updated_at'
].join(',')

/**
 * 把用户信息贴到订单行上。
 *
 * 单独查一次而不是用 PostgREST 的嵌套 select：`orders.user_id` 指向 auth.users，`user_profiles.user_id`
 * 也指向 auth.users，两张业务表之间没有外键，嵌套语法查不出来。
 */
async function attachUsers(db, rows) {
  const ids = [...new Set(rows.map(r => r.user_id).filter(Boolean))]
  if (!ids.length) return rows.map(r => ({ ...r, user_email: '', user_name: '' }))
  const { data, error } = await db.from('user_profiles').select('user_id,email,display_name').in('user_id', ids)
  if (error) throw new Error(`读取用户资料失败：${error.message}`)
  const byId = new Map((data || []).map(p => [p.user_id, p]))
  return rows.map(r => {
    const p = byId.get(r.user_id)
    return { ...r, user_email: maskEmail(p?.email), user_name: maskTail(p?.display_name) }
  })
}

/**
 * §12.2/§12.3 的列表。rank ≥ 111 可读。
 *
 * 分页用 range 而不是 limit：§12.4 的导出要一次取到上限条，而翻页要能看到第 N 页。两者共用这一个
 * 函数，区别只在 limit 的上限和是否贴用户信息。
 */
export async function listOrders(db, query, { pageSize, cap = 200 } = {}) {
  const filters = {}
  const status = String(query?.status || '').trim()
  if (status && !ORDER_STATUSES.includes(status)) {
    return { status: 400, body: { error: `状态必须是 ${ORDER_STATUSES.join(' / ')} 之一` } }
  }
  const provider = String(query?.provider || '').trim()
  // 渠道 id 是 text 主键，形状不受控，所以按名单校验——拼进过滤器的东西必须先确认它存在。
  if (provider) {
    const { data: known, error } = await db.from('payment_providers').select('id')
    if (error) return { status: 500, body: { error: '读取支付渠道失败' } }
    if (!(known || []).some(p => p.id === provider)) {
      return { status: 400, body: { error: `未知的支付渠道：${provider}` } }
    }
  }

  const search = String(query?.search || '').trim()
  const field = String(query?.search_field || 'order_no')
  if (search) {
    const spec = SEARCH_FIELDS[field]
    if (!spec) return { status: 400, body: { error: `搜索项必须是 ${Object.keys(SEARCH_FIELDS).join(' / ')} 之一` } }
    if (!spec.shape.test(search)) return { status: 400, body: { error: `${spec.label}格式不正确` } }
    filters.search = { spec, value: search }
  }

  const requested = Number(query?.limit)
  const limit = Math.min(Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : pageSize, cap)
  const rawOffset = Number(query?.offset)
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0

  let q = db.from('orders').select(LIST_COLUMNS, { count: 'exact' })
  if (status) q = q.eq('status', status)
  if (provider) q = q.eq('provider', provider)

  // 两段时间：下单时间和支付时间（§12.3）。四个边界各自独立，只填一个也成立。
  const bounds = [
    ['created_at', timeBound(query?.created_from), timeBound(query?.created_to)],
    ['paid_at', timeBound(query?.paid_from), timeBound(query?.paid_to)]
  ]
  for (const [col, from, to] of bounds) {
    if (from) q = q.gte(col, from)
    if (to) q = q.lte(col, to)
  }

  if (filters.search) {
    const { spec, value } = filters.search
    if (spec.columns.length === 1) q = q.eq(spec.columns[0], value)
    else q = q.or(spec.columns.map(c => `${c}.eq.${value}`).join(','))
  }

  const { data, error, count } = await q
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) return { status: 500, body: { error: `读取订单失败：${error.message}` } }

  return {
    status: 200,
    body: { orders: data || [], total: count ?? (data || []).length, limit, offset }
  }
}

/**
 * §12.5 的订单详情：基础信息、商品行、脱敏后的联系方式、变更记录、以及管理员操作区要用的信息。
 *
 * 商品描述取订单上的快照（sku_name / sku_description），不是去 artifacts 表现查。§5 要的是「下单时的」
 * 名称和描述——商品改名或改价之后，回头看这笔订单必须还是当时那份，否则订单记录会跟着商品定义一起
 * 变，而那是对账时最难发现的一类不一致。artifacts 只用来补历史行的空快照。
 */
export async function orderDetail(db, orderId, { canModify }) {
  if (!UUID.test(String(orderId || ''))) return { status: 400, body: { error: '订单号格式不正确' } }

  // 不查 provider_payload：那是渠道回调的原文，里面有什么由渠道决定（PayerURL 会带回买家邮箱和
  // IP）。渠道 ID 和支付流水号已经单独有列，详情页要显示的就是那两个，把整包原文送到浏览器等于
  // 让一个 rank 111 的人看到未脱敏的联系方式，而上面刚把邮箱打了码。
  const { data: order, error } = await db.from('orders')
    .select(`${LIST_COLUMNS},artifact_id,sku_description,coupon_id`)
    .eq('id', orderId).maybeSingle()
  if (error) return { status: 500, body: { error: '读取订单失败' } }
  if (!order) return { status: 404, body: { error: '订单不存在' } }

  const [withUser] = await attachUsers(db, [order])

  const [logResult, refundResult, artifactResult] = await Promise.all([
    db.from('order_status_log').select('id,from_status,to_status,actor_id,actor_group,source,note,created_at')
      .eq('order_id', orderId).order('created_at', { ascending: false }).limit(200),
    db.from('refund_requests').select('id,status,amount_minor,currency,reason_detail,initiator_role,created_at,updated_at')
      .eq('order_id', orderId).order('created_at', { ascending: false }),
    order.sku_name ? Promise.resolve({ data: null }) : db.from('artifacts').select('name,description').eq('id', order.artifact_id).maybeSingle()
  ])

  const fallback = artifactResult?.data
  const line = {
    sku: order.sku,
    name: order.sku_name || fallback?.name || '',
    description: order.sku_description || fallback?.description || '',
    quantity: order.quantity,
    list_amount_minor: order.list_amount_minor,
    discount_minor: order.discount_minor,
    amount_minor: order.amount_minor,
    currency: order.currency,
    // §5：用了券显示券，没用就是空——不显示「无」，那会让「没用券」和「券信息没读出来」看起来一样。
    coupon_code: order.coupon_code || ''
  }

  const refunds = refundResult.data || []
  const openRefund = refunds.find(r => !['rejected', 'completed', 'failed'].includes(r.status)) || null

  return {
    status: 200,
    body: {
      order: withUser,
      line,
      logs: logResult.data || [],
      refunds,
      open_refund: openRefund,
      // 操作区（§12.5）：合法的下一步由状态机给，前端不自己算一份。can_modify 为 false 时前端仍然
      // 收到这个数组，用来把按钮画成灰的并说明原因，而不是干脆不画——§13.2 要的就是可见但不可点。
      can_modify: canModify,
      next_statuses: (ORDER_TRANSITIONS[order.status] || []).map(s => ({
        status: s, label: ORDER_STATUS_LABEL[s] || s, via_refund: REFUND_ONLY.has(s)
      }))
    }
  }
}

/**
 * §12.5 的状态变更。仅管理员，且必须填变更说明。
 *
 * 说明是必填的（§12.5 明确要求）。这不是形式：order_status_log 记下了谁在什么时候把订单从 A 改成 B，
 * 但「为什么」只有操作的人知道，而手工改订单状态的场合恰好都是异常场合——回调丢了、渠道那边对不上。
 * 三个月后对账的人需要那句话。
 */
export async function updateOrderStatus(db, caller, input) {
  const orderId = String(input?.order_id || '')
  if (!UUID.test(orderId)) return { status: 400, body: { error: '订单号格式不正确' } }

  const to = String(input?.status || '')
  if (!ORDER_STATUSES.includes(to)) {
    return { status: 400, body: { error: `状态必须是 ${ORDER_STATUSES.join(' / ')} 之一` } }
  }
  const note = String(input?.note || '').trim()
  if (!note) return { status: 400, body: { error: '请填写变更说明' } }
  if (note.length > 2000) return { status: 400, body: { error: '变更说明请控制在 2000 字以内' } }

  if (REFUND_ONLY.has(to)) {
    return {
      status: 409,
      body: { error: `${ORDER_STATUS_LABEL[to]} 只能由退款流程产生：请在退款申请上操作，不要直接改订单状态` }
    }
  }

  const { data: order, error } = await db.from('orders').select('id,status').eq('id', orderId).maybeSingle()
  if (error) return { status: 500, body: { error: '读取订单失败' } }
  if (!order) return { status: 404, body: { error: '订单不存在' } }

  const move = assertTransition(order.status, to)
  if (!move.ok) return { status: 409, body: { error: move.error } }

  // .eq('status', order.status) 是并发保护：两个管理员同时改同一笔订单时，慢的那次影响 0 行，
  // 而不是把先到的那次结果覆盖掉。回调也在改这张表，所以这不是只有两个人同时点才会遇到。
  const patch = { status: to, updated_at: new Date().toISOString() }
  if (to === 'paid') patch.paid_at = new Date().toISOString()
  const { data: moved, error: moveErr } = await db.from('orders')
    .update(patch).eq('id', orderId).eq('status', order.status).select('id,status')
  if (moveErr) return { status: 500, body: { error: `订单状态更新失败：${moveErr.message}` } }
  if (!moved?.length) {
    return { status: 409, body: { error: '订单状态刚刚被其他人或支付回调改过，请刷新后重试' } }
  }

  await logOrderStatus(db, {
    order_id: orderId,
    from_status: order.status,
    to_status: to,
    actor_id: caller.userId,
    actor_group: caller.group,
    source: 'admin',
    note
  })

  return { status: 200, body: { ok: true, order_id: orderId, from: order.status, status: to } }
}

/**
 * §12.4 的批量导出，受 §14 的 order_export_enabled 管。
 *
 * 关掉时返回 403 而不是静默给个空文件：管理员关掉这个开关是为了不让订单数据被整表带走，而一个空
 * CSV 会让点导出的人以为「这个月没订单」。
 *
 * 上限 EXPORT_CAP 条。没有上限的话，一次导出要把全表读进 Vercel 函数的内存再拼成字符串，而函数
 * 有内存和 10 秒的限制——超了是 502，看起来像故障而不是「数据太多」。
 */
export async function exportOrders(db, query, { pageSize }) {
  if (!(await setting(db, 'order_export_enabled', true))) {
    return { status: 403, body: { error: '订单导出已被管理员关闭' } }
  }
  const listed = await listOrders(db, { ...query, limit: query?.limit || EXPORT_CAP, offset: 0 }, { pageSize, cap: EXPORT_CAP })
  if (listed.status !== 200) return listed

  const rows = await attachUsers(db, listed.body.orders)
  const stamp = new Date().toISOString().slice(0, 10)
  return {
    status: 200,
    csv: toCsv(rows, CSV_COLUMNS),
    filename: `orders-${stamp}.csv`,
    // 导出条数和总数都告诉调用方：被上限截断时前端要能提示「只导出了前 5000 条，请缩小筛选范围」，
    // 而不是让人拿着一份不完整的表去对账。
    exported: rows.length,
    total: listed.body.total,
    truncated: listed.body.total > rows.length
  }
}

export default async function handler(req, res) {
  // 门槛 MEMBER（rank ≥ 111），和 SQL 里的 private.can_view_orders() 一致。§12.2 确认过是有意的：
  // 加入组织就是拿到「能看全部订单」的方式。修改在下面单独判 ADMIN。
  const auth = await requireUser(req, res, RANK.MEMBER)
  if (!auth) return
  const caller = { userId: auth.user.id, group: auth.group, rank: auth.rank }
  const canModify = auth.rank >= RANK.ADMIN

  try {
    const pageSize = Number(await setting(auth.db, 'order_list_page_size', 20)) || 20

    if (req.method === 'GET') {
      const query = req.query || {}
      if (query.order_id) {
        const detail = await orderDetail(auth.db, query.order_id, { canModify })
        return send(res, detail.status, detail.body)
      }
      if (String(query.view || '') === 'export') {
        const out = await exportOrders(auth.db, query, { pageSize })
        if (out.status !== 200) return send(res, out.status, out.body)
        res.status(200)
        res.setHeader('Content-Type', 'text/csv; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        // filename 里只有日期，没有筛选条件——把用户 ID 或支付 ID 拼进文件名会让它跟着文件一起
        // 散出去，而导出文件常常是直接转发给别人的。
        res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`)
        res.setHeader('X-Export-Total', String(out.total))
        res.setHeader('X-Export-Truncated', out.truncated ? '1' : '0')
        return res.send(out.csv)
      }
      const listed = await listOrders(auth.db, query, { pageSize })
      if (listed.status !== 200) return send(res, listed.status, listed.body)
      const rows = await attachUsers(auth.db, listed.body.orders)
      return send(res, 200, { ...listed.body, orders: rows, page_size: pageSize, can_modify: canModify })
    }

    if (req.method === 'PATCH') {
      if (!canModify) return send(res, 403, { error: '只有管理员可以修改订单状态' })
      const result = await updateOrderStatus(auth.db, caller, await bodyOf(req))
      return send(res, result.status, result.body)
    }

    return send(res, 405, { error: 'Method not allowed' })
  } catch (e) {
    console.error('admin-orders 失败', e)
    return send(res, 500, { error: '订单管理接口出错' })
  }
}
