import crypto from 'node:crypto'
import { bodyOf, send, serviceClient } from './_lib/server.mjs'
import { driverFor } from './_lib/payments.mjs'
const safeEqual = (a, b) => { try { const x=Buffer.from(a||''); const y=Buffer.from(b||''); return x.length===y.length && crypto.timingSafeEqual(x,y) } catch { return false } }
export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
  const provider = String(req.query?.provider || '').toLowerCase()
  try {
    const payload = await bodyOf(req)
    const db = serviceClient()
    const { data: providerConfig } = await db.from('payment_providers').select('public_config').eq('id',provider).single()
    const config = providerConfig?.public_config || {}
    // Driver providers carry no shared secret: their own API is re-read and decides the outcome, so a
    // forged callback cannot mark an unpaid order as paid. Anything still in flight stays `pending`.
    const driver = driverFor(config)
    if (driver) {
      const outcome = await driver.verify({ payload, config })
      if (!outcome) return send(res, 200, { ok: true, ignored: true })
      if (!outcome.orderId) return send(res, 400, { error: 'Missing order_id' })
      const update = { provider_order_id: outcome.providerOrderId, provider_payload: outcome.payload || {} }
      if (outcome.paid) { update.status = 'paid'; update.paid_at = new Date().toISOString() }
      else if (outcome.failed) update.status = 'failed'
      const { error: driverError } = await db.from('orders').update(update).eq('id', outcome.orderId).eq('provider', provider)
      if (driverError) throw driverError
      return send(res, 200, { ok: true, paid: outcome.paid })
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
