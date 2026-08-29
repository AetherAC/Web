import { bodyOf, requireUser, send } from './_lib/server.mjs'
import { driverFor } from './_lib/payments.mjs'
const values = (order) => ({
  order_id: order.id, sku: order.sku, amount_minor: order.amount_minor,
  amount: (order.amount_minor / 100).toFixed(2), currency: order.currency
})
const render = (value, vars) => {
  if (typeof value === 'string') {
    const env = value.match(/^\$env:([A-Z][A-Z0-9_]*)$/)
    if (env) return process.env[env[1]] || ''
    return Object.entries(vars).reduce((text,[key,replacement]) => text.replaceAll(`{${key}}`, String(replacement)), value)
  }
  if (Array.isArray(value)) return value.map(item => render(item,vars))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,render(item,vars)]))
  return value
}
const atPath = (value, path) => String(path||'').split('.').filter(Boolean).reduce((current,key) => current?.[key], value)
export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    const input = await bodyOf(req)
    const [{ data: artifact }, { data: provider }] = await Promise.all([
      auth.db.from('artifacts').select('*').eq('id', input.artifact_id).eq('active', true).single(),
      auth.db.from('payment_providers').select('*').eq('id', input.provider).eq('enabled', true).single()
    ])
    if (!artifact || !provider) return send(res, 404, { error: 'Artifact or payment provider unavailable' })
    const { data: order, error } = await auth.db.from('orders').insert({
      user_id: auth.user.id, artifact_id: artifact.id, sku: artifact.sku, quantity: 1,
      amount_minor: artifact.price_minor, currency: artifact.currency, provider: provider.id
    }).select().single()
    if (error) throw error
    const config = provider.public_config || {}
    const siteUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`
    const vars = { ...values(order), callback_url: `${siteUrl}/v1/callback/${provider.id}` }
    const template = config.checkout_url_template
    const checkoutUrl = template ? template
      .replaceAll('{order_id}', encodeURIComponent(order.id)).replaceAll('{sku}', encodeURIComponent(order.sku))
      .replaceAll('{amount_minor}', String(order.amount_minor)).replaceAll('{currency}', encodeURIComponent(order.currency))
      .replaceAll('{callback_url}', encodeURIComponent(vars.callback_url)) : null
    let resolvedUrl = checkoutUrl
    let providerOrderId = null
    // A driver (Stripe, PayPal) needs more than one configurable request, so it takes precedence.
    const driver = driverFor(config)
    if (driver) {
      const created = await driver.create({ order, artifact, siteUrl, config })
      resolvedUrl = created.checkoutUrl
      providerOrderId = created.providerOrderId
    } else if (!resolvedUrl && config.create_url) {
      const endpoint = new URL(render(config.create_url,vars))
      if (endpoint.protocol !== 'https:') throw new Error('Payment create_url must use HTTPS')
      const response = await fetch(endpoint, {
        method: config.create_method || 'POST',
        headers: { 'Content-Type':'application/json', ...render(config.create_headers || {},vars) },
        body: JSON.stringify(render(config.create_body || vars,vars))
      })
      const result = await response.json().catch(()=>({}))
      if (!response.ok) throw new Error(result.message || `Payment API ${response.status}`)
      resolvedUrl = atPath(result,config.checkout_url_path || 'checkout_url')
      providerOrderId = atPath(result,config.provider_order_id_path || 'id')
    }
    if (resolvedUrl) await auth.db.from('orders').update({ checkout_url: resolvedUrl, provider_order_id: providerOrderId }).eq('id', order.id)
    return send(res, 201, { order: { ...order, checkout_url: resolvedUrl, provider_order_id: providerOrderId }, configured: Boolean(resolvedUrl) })
  } catch (error) { return send(res, 500, { error: error.message }) }
}
