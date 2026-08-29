/**
 * §9 站内信的类型、可见范围和动作按钮。浏览器和 Serverless 函数共用一份。
 *
 * 最要紧的一条规则先说：**站内信是单向的**（§9 原文「站内信不可回复，属于单向信息传递」）。
 * 所以这里没有 reply 类的动作，也不会有。要双向沟通的场景走 §2 的客服会话，那是另一套东西。
 * 把它们混成一个「消息中心」是很自然的冲动，但结果是用户会在一个不会有人看的地方提问题。
 *
 * 动作按钮的形状校验放在这里而不是数据库：actions 是 jsonb 数组，schema.sql 只校验到
 * `jsonb_typeof(actions) = 'array'`。理由和优惠券那边一样（见 shared/coupons.mjs 开头），
 * 但这里还多一层——按钮的 action 值决定点下去调哪个接口，而那份映射天然属于代码而不是表结构。
 */

/**
 * §9.2 的站内信类型。这份列表和 schema.sql 里 notifications.kind 那条 check 必须逐字一致——
 * tests/api-smoke.mjs 对着断言，少一个值的后果是插入时被数据库拒掉，而调用方只看到一句约束名。
 */
export const NOTIFICATION_KINDS = ['system', 'admin', 'order', 'refund', 'refund_approval', 'session', 'ticket']

export const KIND_LABEL = {
  system: '系统通知', admin: '管理员通知', order: '订单通知',
  refund: '退款通知', refund_approval: '退款审批', session: '客服会话', ticket: '工单通知'
}

/**
 * §9.5 的可见范围。
 *
 * user 是点对点，其余三种是按角色广播。schema.sql 里有一条 check 约束把这件事钉住了：
 * scope='user' 当且仅当 recipient_id 不为空。少了那条约束，一条 scope='admin' 却带着 recipient_id
 * 的行会同时命中两套可见性判断，而结果取决于策略的求值顺序——那种 bug 只在特定数据上出现。
 */
export const NOTIFICATION_SCOPES = ['user', 'admin', 'cs', 'all']

export const SCOPE_LABEL = { user: '指定用户', admin: '全体管理员', cs: '全体客服', all: '所有人' }

/**
 * §9.6 的三态。null 表示这条通知不是待办，只是通知。
 *
 * 为什么用可空的三态而不是给每条通知都塞一个 state：一条「您的订单已支付」没有「已批准」的说法。
 * 强行给它一个状态，前端就得在每处渲染里判断这个状态该不该显示，而漏判的表现是通知列表里出现
 * 一堆莫名的「待处理」。
 */
export const NOTIFICATION_STATES = ['pending', 'approved', 'rejected']

export const STATE_LABEL = { pending: '待处理', approved: '已批准', rejected: '已拒绝' }

/**
 * 动作按钮的类型。每一个都对应一个接口，映射见下面的 ACTION_ENDPOINT。
 *
 * link 是唯一不调接口的：它只是跳转。分出来是因为「跳去订单页」和「批准退款」在权限、二次确认、
 * 幂等性上完全不是一回事，混成一种会让前端在渲染时才发现自己要判断这是不是个危险操作。
 */
export const ACTION_TYPES = ['link', 'approve_refund', 'reject_refund', 'transfer_refund', 'mark_read', 'open_session']

export const ACTION_LABEL = {
  link: '跳转', approve_refund: '批准', reject_refund: '拒绝',
  transfer_refund: '转交', mark_read: '知道了', open_session: '打开会话'
}

/**
 * 哪些动作需要管理员。这份名单必须和 API 侧的 requireUser(need) 一致——前端隐藏按钮只是体面，
 * 真正的判定在接口里。列在这里是为了不给用户显示一个点了必然 403 的按钮。
 */
export const ADMIN_ONLY_ACTIONS = ['approve_refund', 'reject_refund', 'transfer_refund']

/**
 * 哪些动作不可逆，必须走 §13.4 的二次确认。
 *
 * approve_refund 在列，reject_refund 不在：批准会触发打款流程，拒绝只是把订单退回 PAID
 * （§13 的状态图里那条 `PAID → PAID` 带原因的记录），后者可以重新发起。
 */
export const IRREVERSIBLE_ACTIONS = ['approve_refund']

/** 每个动作打到哪个接口。link 和 mark_read 不走这张表——前者只跳转，后者走通用的已读接口。 */
export const ACTION_ENDPOINT = {
  approve_refund: '/api/refund-approve',
  reject_refund: '/api/refund-reject',
  transfer_refund: '/api/refund-transfer',
  open_session: '/api/cs-session'
}

/**
 * 哪些动作必须填理由。§10.5 要求拒绝必须给出原因，转交也一样——转交不写原因，接手的人不知道为什么。
 */
export const REASON_REQUIRED_ACTIONS = ['reject_refund', 'transfer_refund']

const fail = error => ({ ok: false, error })
const pass = () => ({ ok: true })
const isStr = v => typeof v === 'string' && v.trim().length > 0

/**
 * 订单页链接。这是 docs/.vitepress/theme/routes.ts 里 orderPath() 的第二份实现，属于有意重复。
 *
 * 为什么不直接 import 那个：routes.ts 是 TypeScript，而这个文件要被 api/ 下的函数在 Vercel 的 Node
 * 运行时里 import。让运行时去剥类型是能跑通的，但那是给构建期设计的能力，押在一个线上支付相关路径上
 * 不划算。
 * 为什么这条规则不能随便写成 /order/{id}：VitePress 的路由表是构建期生成的哈希映射，路径里带 id 的
 * URL 在浏览器里会 404，尽管 curl 看到的是 200（这个坑踩过，见 routes.ts 里的注释）。所以 id 必须是
 * 查询参数。
 * 重复的代价由测试兜：tests/api-smoke.mjs 会断言这里和 orderPath() 给出同一个结果，改了一边就构建失败。
 */
export const orderHref = orderId => `/order?order_id=${encodeURIComponent(orderId)}`

/**
 * 校验一个动作按钮。
 *
 * label 必填且不给默认值：ACTION_LABEL 里的「批准」在退款审批的上下文里够用，但同一个 approve_refund
 * 出现在别的通知里可能需要写「批准这笔 128.00 USD 的退款」。让调用方每次都写一遍，是为了不让一个
 * 泛泛的按钮文案出现在需要具体信息的地方。
 */
export function validateAction(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return fail('动作必须是对象')
  if (!ACTION_TYPES.includes(a.type)) return fail(`未知的动作类型：${String(a.type)}`)
  if (!isStr(a.label)) return fail('动作必须有按钮文案')
  if (a.label.length > 40) return fail('按钮文案不要超过 40 字')
  if (a.type === 'link') {
    if (!isStr(a.href)) return fail('跳转动作必须有 href')
    // 只允许站内相对路径。允许外链的话，一条管理员发的站内信就成了一个带站点信誉的钓鱼入口，
    // 而站内信恰好是用户最容易信任的位置。真要跳外站，让用户自己复制链接。
    if (!/^\/[^/\\]/.test(a.href)) return fail('跳转只允许站内相对路径（以单个 / 开头）')
    if (/[\r\n\t]/.test(a.href)) return fail('href 不能包含控制字符')
    return pass()
  }
  if (a.type === 'mark_read') return pass()
  // 其余动作都作用在一个具体对象上，缺了 target 就是个点不动的按钮。
  if (!isStr(a.target)) return fail(`${ACTION_LABEL[a.type] ?? a.type} 动作必须指定 target（对象 id）`)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a.target)) {
    return fail('target 必须是 uuid')
  }
  return pass()
}

/**
 * 校验整条站内信。
 */
export function validateNotification(n) {
  if (!n || typeof n !== 'object') return fail('站内信必须是对象')
  if (!NOTIFICATION_KINDS.includes(n.kind)) return fail(`未知的类型：${String(n.kind)}`)
  if (!NOTIFICATION_SCOPES.includes(n.scope)) return fail(`未知的可见范围：${String(n.scope)}`)
  if (!isStr(n.title)) return fail('标题不能为空')
  if (n.title.length > 200) return fail('标题不要超过 200 字')
  if (!isStr(n.body)) return fail('正文不能为空')
  // scope='user' 和 recipient_id 必须同时在或同时不在。schema.sql 里有同样一条 check 约束，
  // 这里重复一遍是为了在提交前就说清楚，而不是让管理员收到一句数据库的约束名。
  if (n.scope === 'user' && !isStr(n.recipient_id)) return fail('指定用户的站内信必须有 recipient_id')
  if (n.scope !== 'user' && isStr(n.recipient_id)) return fail('广播范围的站内信不能带 recipient_id')
  if (n.state !== null && n.state !== undefined && !NOTIFICATION_STATES.includes(n.state)) {
    return fail(`未知的处理状态：${String(n.state)}`)
  }
  if (n.actions !== null && n.actions !== undefined) {
    if (!Array.isArray(n.actions)) return fail('actions 必须是数组')
    if (n.actions.length > 6) return fail('一条站内信最多 6 个按钮')
    for (const [i, a] of n.actions.entries()) {
      const r = validateAction(a)
      if (!r.ok) return fail(`第 ${i + 1} 个按钮：${r.error}`)
    }
  }
  return pass()
}

/**
 * §9.6：需要审批的站内信强制置顶高亮。
 *
 * 这是判断而不是让调用方自己设 pinned/highlighted 两个布尔——两个布尔各写一遍，漏一个的结果是
 * 一条等着人批的退款躺在列表第二十行。所以规则写在这里，插入路径调它。
 */
export function presentationFor(n) {
  const needsApproval = n?.state === 'pending' && Array.isArray(n?.actions)
    && n.actions.some(a => ADMIN_ONLY_ACTIONS.includes(a?.type))
  return { pinned: needsApproval, highlighted: needsApproval }
}

/** 动作是否需要二次确认。前端拿这个决定弹不弹框，接口侧另有一道 confirm 参数校验。 */
export const needsConfirm = type => IRREVERSIBLE_ACTIONS.includes(type)

/** 动作是否需要填理由。 */
export const needsReason = type => REASON_REQUIRED_ACTIONS.includes(type)

/** 当前用户能不能看见这个按钮。真正的判定在接口里，这里只管别显示注定 403 的按钮。 */
export const canUseAction = (type, rank, adminRank = 999) =>
  !ADMIN_ONLY_ACTIONS.includes(type) || Number(rank) >= adminRank

/**
 * 构造一条退款审批站内信（§10.3）。
 *
 * 收敛成一个构造函数而不是让每个调用点自己拼：三个按钮、pending 状态、置顶高亮、正文里要有金额和
 * 原因——这几件事漏掉任何一件，审批流程都会在某个环节卡住而且不报错。批准按钮的文案带上金额，
 * 是因为管理员可能同时收到好几条待审批，而「批准」这两个字在列表里长得一模一样。
 */
export function refundApprovalNotification({ refundId, orderNo, amountText, reason, initiator }) {
  return {
    kind: 'refund_approval',
    scope: 'admin',
    recipient_id: null,
    title: `退款审批：订单 ${orderNo}（${amountText}）`,
    body: [
      `**发起人**：${initiator}`,
      `**订单号**：${orderNo}`,
      `**退款金额**：${amountText}`,
      '',
      '**退款原因**',
      reason
    ].join('\n'),
    state: 'pending',
    refund_id: refundId,
    actions: [
      { type: 'approve_refund', label: `批准退款 ${amountText}`, target: refundId },
      { type: 'reject_refund', label: '拒绝', target: refundId },
      { type: 'transfer_refund', label: '转交其他管理员', target: refundId }
    ]
  }
}

/**
 * §10.5 的超时升级提醒。
 *
 * 单独一条新通知，而不是改原来那条的标题。理由是「未读」是按通知算的：原地改标题的话，
 * 已经读过原通知的管理员不会再收到任何提示，而超时提醒的全部意义就是提示那个已经看过但没处理的人。
 */
export function refundEscalationNotification({ refundId, orderNo, amountText, hours }) {
  return {
    kind: 'refund_approval',
    scope: 'admin',
    recipient_id: null,
    title: `退款审批已超时 ${hours} 小时：订单 ${orderNo}`,
    body: `订单 ${orderNo} 的 ${amountText} 退款申请已等待 ${hours} 小时未处理，请尽快审批。`,
    state: 'pending',
    refund_id: refundId,
    actions: [
      { type: 'approve_refund', label: `批准退款 ${amountText}`, target: refundId },
      { type: 'reject_refund', label: '拒绝', target: refundId }
    ]
  }
}

/**
 * §13.3：退款完成后通知用户。
 *
 * 没有按钮，只有一个跳去订单页的链接。这里刻意不放「有疑问联系客服」之类的动作——站内信是单向的，
 * 而客服会话要有一个具体的订单上下文才开得起来，那个入口在订单页上（§2.1 的售后限定在 /order 内）。
 */
export function refundDoneNotification({ userId, orderNo, orderId, amountText, ok, note }) {
  return {
    kind: 'refund',
    scope: 'user',
    recipient_id: userId,
    title: ok ? `退款已完成：订单 ${orderNo}` : `退款未成功：订单 ${orderNo}`,
    body: ok
      ? `订单 ${orderNo} 的 ${amountText} 已退回。到账时间取决于支付渠道，加密货币通常在链上确认后可见。`
      : `订单 ${orderNo} 的退款未能完成${note ? `：${note}` : '。'}我们的客服会跟进处理。`,
    state: null,
    order_id: orderId,
    actions: [{ type: 'link', label: '查看订单', href: orderHref(orderId) }]
  }
}
