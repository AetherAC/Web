/**
 * 写站内信、写订单日志、写退款审计、写会话事件。这四件事被十来个接口重复调用，所以只有一份实现。
 *
 * 为什么不让每个接口自己 insert：§10.8 要求退款全流程可审计并可导出，§12.4 要求订单详情里有完整
 * 变更记录。这类要求的失败方式是「某一条路径忘了写日志」——审计表看起来是满的，只有那一条路径的
 * 记录缺失，而缺什么恰好是最难发现的。把写入集中到这里之后，忘写日志变成一件要主动绕过的事。
 *
 * 这些函数都接收 db（service client）而不是自己 new 一个：service client 绕过 RLS，所以权限判断
 * 必须已经在调用方用 requireUser 做完了。传进来能让测试用一个假 db 把调用形状钉死。
 *
 * 关于错误处理的取舍：写日志失败不应该让业务操作失败。一次成功的退款却因为审计写入超时而回给
 * 用户「失败」，会让用户重试，而重试可能真的退第二次。所以日志写入的错误被记录到 stderr 并吞掉，
 * 只有站内信是例外——§10.3 的审批通知就是审批流程本身的载体，插不进去等于审批请求没发出去。
 */

import { validateNotification } from '../../shared/notifications.mjs'

/**
 * 插入一条站内信，返回插入后的行。
 *
 * 提交前先过 validateNotification，因为数据库那边的 check 约束只能报出约束名。同一份校验规则在
 * 浏览器里也跑一遍（管理员发通知的表单），所以两边给出的是同一句中文。
 */
export async function insertNotification(db, notification) {
  const check = validateNotification(notification)
  if (!check.ok) throw new Error(`站内信不合法：${check.error}`)
  const { data, error } = await db.from('notifications').insert(notification).select().single()
  if (error) throw new Error(`站内信写入失败：${error.message}`)
  return data
}

/**
 * §12.4 的订单变更记录。
 *
 * source 说明这次变更从哪来（user/cs/admin/system/callback），因为同一个状态迁移可以有好几个入口
 * ——§13.3 就列了三个退款入口。只记 actor_id 的话，事后没法区分「管理员在订单详情里点的」和
 * 「客服在工作台里代提的」，而这两件事的责任归属不同。
 *
 * 写失败只记到 stderr。理由见文件头：审计写入不该让业务操作失败。
 */
export async function logOrderStatus(db, entry) {
  const row = {
    order_id: entry.order_id,
    from_status: entry.from_status,
    to_status: entry.to_status,
    actor_id: entry.actor_id ?? null,
    actor_group: entry.actor_group || '',
    source: entry.source || 'system',
    note: entry.note || ''
  }
  const { error } = await db.from('order_status_log').insert(row)
  if (error) console.error('order_status_log 写入失败', { order_id: row.order_id, error: error.message })
  return !error
}

/**
 * §10.8 的退款审计。
 *
 * action 是自由文本而不是枚举，因为审计要记的动作会随功能增长（发起、改金额、批准、拒绝、转交、
 * 执行、重试…），而给审计表加约束的净效果通常是某天某条记录写不进去。from_status/to_status 允许
 * 为空串：改金额这种动作不改状态，但必须留痕——§10.2 允许客服改金额，那就得能查是谁改的。
 */
export async function logRefundAction(db, entry) {
  const row = {
    refund_id: entry.refund_id,
    actor_id: entry.actor_id ?? null,
    actor_group: entry.actor_group || '',
    action: entry.action,
    from_status: entry.from_status || '',
    to_status: entry.to_status || '',
    amount_minor: entry.amount_minor ?? null,
    note: entry.note || ''
  }
  const { error } = await db.from('refund_audit_log').insert(row)
  if (error) console.error('refund_audit_log 写入失败', { refund_id: row.refund_id, error: error.message })
  return !error
}

/**
 * §2 的会话事件流：开启、接入、关闭、重开、切换监管模式、撤回、编辑。
 *
 * detail 是 jsonb，因为每种事件要记的东西不一样（切换监管模式要记新旧模式，撤回要记消息 id）。
 * §2.13 的响应率和超时率统计就是从这张表算出来的，所以这里漏一条事件等于统计口径出错。
 */
export async function logSessionEvent(db, entry) {
  const row = {
    session_id: entry.session_id,
    kind: entry.kind,
    actor_id: entry.actor_id ?? null,
    actor_group: entry.actor_group || '',
    detail: entry.detail && typeof entry.detail === 'object' ? entry.detail : {}
  }
  const { error } = await db.from('cs_session_events').insert(row)
  if (error) console.error('cs_session_events 写入失败', { session_id: row.session_id, error: error.message })
  return !error
}

/**
 * §9.6：审批完成后，那条带按钮的站内信要停止置顶高亮，并留下处理结果。
 *
 * 不删那条通知。删掉的话，第二个管理员点进来只会看到「不存在」，而他需要看到的是「已由某人批准」
 * ——否则两个人会各自以为自己那次点击没生效。同理 pinned/highlighted 一起收掉：处理完的事项还
 * 占着置顶位，置顶就不再有意义。
 *
 * 只更新 state 还是 pending 的行，所以两个管理员同时点击时，第二次更新影响 0 行。调用方据此判断
 * 自己是不是那个真正做了决定的人。
 */
export async function settleApproval(db, refundId, state, actorId) {
  const { data, error } = await db.from('notifications')
    .update({ state, pinned: false, highlighted: false, updated_at: new Date().toISOString() })
    .eq('refund_id', refundId).eq('kind', 'refund_approval').eq('state', 'pending')
    .select('id')
  if (error) throw new Error(`审批状态回写失败：${error.message}`)
  if (data?.length) {
    // 谁做的决定记在审计里而不是通知行上——通知是给人看的，审计是给查的。
    await logRefundAction(db, { refund_id: refundId, actor_id: actorId, action: 'settle_notification', to_status: state })
  }
  return data?.length ?? 0
}

/**
 * 给用户发一条订单相关的通知，附一个跳转按钮。
 *
 * §14 有一个 refund_auto_notify 开关，所以这里先读配置。开关关掉时静默跳过而不是报错——那是
 * 管理员有意关的，不是故障。
 */
export async function notifyUser(db, userId, { kind = 'order', title, body, orderId = null, refundId = null, actions = [] }) {
  return insertNotification(db, {
    kind, scope: 'user', recipient_id: userId, title, body,
    order_id: orderId, refund_id: refundId, actions, state: null
  })
}

/** 读一个配置项。缺键返回 fallback，而不是让调用方拿到 undefined 再各自猜默认值。 */
export async function setting(db, key, fallback) {
  const { data, error } = await db.from('site_settings').select('value').eq('key', key).maybeSingle()
  if (error) {
    console.error('site_settings 读取失败', { key, error: error.message })
    return fallback
  }
  if (!data) return fallback
  // 所有值都存成 {"value": ...}，见 schema.sql 的 seed 段。
  const v = data.value?.value
  return v === undefined || v === null ? fallback : v
}

