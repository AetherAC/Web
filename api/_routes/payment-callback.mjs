import crypto from 'node:crypto'
import { bodyOf, send, serviceClient } from '../_lib/server.mjs'
import { driverFor } from '../_lib/payments.mjs'
const safeEqual = (a, b) => { try { const x=Buffer.from(a||''); const y=Buffer.from(b||''); return x.length===y.length && crypto.timingSafeEqual(x,y) } catch { return false } }
// 有的渠道只认一段固定的纯文本回执。支付宝要的是正文等于字面量 success：回 JSON——哪怕是一个
// {"ok":true}——都被读成「通知失败」，同一笔付款会按 1m/2m/10m/…/24h 重投 8 次，而每一次重投都会把
// 订单再改一遍。想回什么文本由驱动在 outcome.ack 里声明；没声明的照旧走 send()，回 JSON。
const reply = (res, status, body, text) => {
  if (typeof text !== 'string') return send(res, status, body)
  res.status(status)
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  return res.send(text)
}
export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
  const provider = String(req.query?.provider || '').toLowerCase()
  try {
    const payload = await bodyOf(req)
    const db = serviceClient()
    const { data: providerConfig } = await db.from('payment_providers').select('public_config').eq('id',provider).single()
    const config = providerConfig?.public_config || {}
    // Driver providers carry no shared webhook secret: Stripe and PayPal re-read their own API, and
    // PayerURL and Alipay sign a canonical form of the body that survives Vercel's parsing. Either way
    // a forged callback cannot mark an unpaid order as paid, and anything still in flight stays `pending`.
    const driver = driverFor(config)
    if (driver) {
      const outcome = await driver.verify({ payload, headers: req.headers, config })
      if (!outcome) return send(res, 200, { ok: true, ignored: true })
      const ack = outcome.ack || {}
      // 一条与订单无关的通知（支付宝的退款、对账通知就没有 trade_status）：什么都不改，但仍要回执，
      // 否则渠道会拿同一条重投一整天。
      if (outcome.ignore) return reply(res, 200, { ok: true, ignored: true }, ack.ok)
      if (outcome.reject) return reply(res, outcome.reject.status || 401, { error: outcome.reject.error || 'Callback rejected', ...(outcome.reject.response || {}) }, ack.fail)
      if (!outcome.orderId) return reply(res, 400, { error: 'Missing order_id' }, ack.fail)
      // When a provider reports how much it actually received, the order row decides: releasing an
      // underpaid order would hand over the artifact for less than its price.
      if (outcome.paid && outcome.expect) {
        const { data: row } = await db.from('orders').select('amount_minor,currency').eq('id', outcome.orderId).eq('provider', provider).maybeSingle()
        if (!row) return reply(res, 404, { error: 'Unknown order' }, ack.fail)
        const wrongCurrency = outcome.expect.currency && String(outcome.expect.currency).toUpperCase() !== String(row.currency).toUpperCase()
        if (wrongCurrency || outcome.expect.amountMinor < row.amount_minor) return reply(res, 409, { error: 'Callback amount does not match the order' }, ack.fail)
      }
      const update = { provider_order_id: outcome.providerOrderId, provider_payload: outcome.payload || {} }
      if (outcome.paid) { update.status = 'paid'; update.paid_at = new Date().toISOString() }
      else if (outcome.failed) update.status = 'failed'
      const { error: driverError } = await db.from('orders').update(update).eq('id', outcome.orderId).eq('provider', provider)
      if (driverError) throw driverError
      return reply(res, 200, { ok: true, paid: outcome.paid, ...(outcome.response || {}) }, ack.ok)
    }
    const secretName = config.webhook_secret_env || `${provider.toUpperCase().replace(/[^A-Z0-9]/g,'_')}_WEBHOOK_SECRET`
    const secret = process.env[secretName]
    if (!secret) return send(res, 503, { error: 'Webhook secret not configured' })
    const headerName = String(config.webhook_signature_header || 'x-webhook-signature').toLowerCase()
    const signature = String(req.headers[headerName] || req.headers['x-signature'] || '').replace(/^sha256=/,'')
    const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex')
    if (!safeEqual(signature, expected)) return send(res, 401, { error: 'Invalid callback signature' })
    const orderId = payload.order_id || payload.metadata?.order_id
    if (!orderId) return send(res, 400, { error: 'Missing order_id' })
    const paid = ['paid','completed','confirmed','success'].includes(String(payload.status).toLowerCase())
    const { error } = await db.from('orders').update({ status: paid ? 'paid' : 'failed', paid_at: paid ? new Date().toISOString() : null, provider_order_id: payload.provider_order_id || payload.id, provider_payload: payload }).eq('id', orderId).eq('provider', provider)
    if (error) throw error
    return send(res, 200, { ok: true })
  } catch (error) { return send(res, 500, { error: error.message }) }
}
