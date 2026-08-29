// Stripe and PayPal cannot ride the generic public_config path in checkout.mjs: Stripe's REST API
// only accepts application/x-www-form-urlencoded bodies (the generic path posts JSON), and PayPal
// needs an OAuth2 token exchange before it will create an order, which a single fetch cannot do.
//
// Their callbacks are verified by re-reading the authoritative state from the provider rather than
// by HMAC. Vercel parses the request body before the handler runs, so a re-serialized body can
// never match a signature taken over the original bytes. A forged callback therefore costs one
// extra API read and cannot mark an unpaid order as paid — the provider's own answer decides.

const env = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

async function json(url, options) {
  const response = await fetch(url, options)
  const text = await response.text()
  let body = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  if (!response.ok) throw new Error(body.error?.message || body.message || `${new URL(url).host} returned ${response.status}`)
  return body
}

// PayPal wants decimal strings; these three currencies reject decimals outright.
const PAYPAL_ZERO_DECIMAL = new Set(['HUF', 'JPY', 'TWD'])
export const decimalAmount = (minor, currency) =>
  PAYPAL_ZERO_DECIMAL.has(String(currency).toUpperCase()) ? String(Math.round(minor)) : (minor / 100).toFixed(2)

// Stripe's form encoding: nested objects and arrays become bracketed keys.
export function formEncode(value, prefix = '', out = new URLSearchParams()) {
  if (value === undefined || value === null) return out
  if (Array.isArray(value)) { value.forEach((item, index) => formEncode(item, `${prefix}[${index}]`, out)); return out }
  if (typeof value === 'object') { for (const [key, item] of Object.entries(value)) formEncode(item, prefix ? `${prefix}[${key}]` : key, out); return out }
  out.append(prefix, String(value))
  return out
}

// Stripe's unit_amount is already the minor unit, the same integer the artifacts table stores.
export const stripeSessionForm = (order, artifact, siteUrl) => formEncode({
  mode: 'payment',
  client_reference_id: order.id,
  metadata: { order_id: order.id },
  success_url: `${siteUrl}/order/${order.id}?paid=1`,
  cancel_url: `${siteUrl}/order/${order.id}`,
  line_items: [{
    quantity: order.quantity || 1,
    price_data: {
      currency: String(order.currency).toLowerCase(),
      unit_amount: order.amount_minor,
      product_data: { name: artifact?.name || order.sku, ...(artifact?.description ? { description: artifact.description } : {}) }
    }
  }]
})

const stripe = {
  async create({ order, artifact, siteUrl, config }) {
    const key = env(config.secret_key_env || 'STRIPE_SECRET_KEY')
    const session = await json('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: stripeSessionForm(order, artifact, siteUrl)
    })
    return { checkoutUrl: session.url, providerOrderId: session.id }
  },
  // Stripe fires many event types at one endpoint; only Checkout Sessions map onto an order here.
  async verify({ payload, config }) {
    const sessionId = payload?.data?.object?.id
    if (!/^cs_/.test(String(sessionId))) return null
    const key = env(config.secret_key_env || 'STRIPE_SECRET_KEY')
    const session = await json(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${key}` }
    })
    return {
      orderId: session.client_reference_id || session.metadata?.order_id || null,
      paid: session.payment_status === 'paid',
      failed: session.status === 'expired',
      providerOrderId: session.id,
      payload: session
    }
  }
}

const paypalBase = (config) =>
  String(config.environment || process.env.PAYPAL_ENV || 'live').toLowerCase() === 'sandbox'
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com'

async function paypalToken(config) {
  const id = env(config.client_id_env || 'PAYPAL_CLIENT_ID')
  const secret = env(config.secret_env || 'PAYPAL_SECRET')
  const { access_token: token } = await json(`${paypalBase(config)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  })
  if (!token) throw new Error('PayPal did not return an access token')
  return token
}

// The v2 API calls the approval link `payer-action`; older responses still say `approve`.
export const approvalLink = (links) =>
  (links || []).find((link) => link.rel === 'payer-action' || link.rel === 'approve')?.href || null

// custom_id carries our order id back through the webhook; invoice_id makes PayPal reject a replay.
export const paypalOrderBody = (order, artifact, siteUrl) => ({
  intent: 'CAPTURE',
  purchase_units: [{
    reference_id: order.id,
    custom_id: order.id,
    invoice_id: order.id,
    description: String(artifact?.name || order.sku).slice(0, 127),
    amount: {
      currency_code: String(order.currency).toUpperCase(),
      value: decimalAmount(order.amount_minor, order.currency)
    }
  }],
  payment_source: {
    paypal: {
      experience_context: {
        user_action: 'PAY_NOW',
        return_url: `${siteUrl}/order/${order.id}?paid=1`,
        cancel_url: `${siteUrl}/order/${order.id}`
      }
    }
  }
})

const paypal = {
  async create({ order, artifact, siteUrl, config }) {
    const token = await paypalToken(config)
    const created = await json(`${paypalBase(config)}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': order.id },
      body: JSON.stringify(paypalOrderBody(order, artifact, siteUrl))
    })
    const checkoutUrl = approvalLink(created.links)
    if (!checkoutUrl) throw new Error('PayPal created the order but returned no approval link')
    return { checkoutUrl, providerOrderId: created.id }
  },
  // APPROVED only means the buyer agreed. The money moves on capture, so capture decides `paid`.
  async verify({ payload, config }) {
    const resource = payload?.resource || {}
    const remoteId = String(payload?.event_type || '').startsWith('CHECKOUT.ORDER')
      ? resource.id
      : resource.supplementary_data?.related_ids?.order_id
    if (!remoteId) return null
    const token = await paypalToken(config)
    const base = paypalBase(config)
    const headers = { Authorization: `Bearer ${token}` }
    const path = `${base}/v2/checkout/orders/${encodeURIComponent(remoteId)}`
    let remote = await json(path, { headers })
    // Read the order id before capturing: a capture response nests custom_id somewhere else.
    const orderId = remote.purchase_units?.[0]?.custom_id || resource.custom_id || null
    if (remote.status === 'APPROVED') {
      try {
        remote = await json(`${path}/capture`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json', 'PayPal-Request-Id': `capture-${remoteId}` },
          body: '{}'
        })
      } catch { /* declined instrument, or captured by a concurrent callback: keep the read status */ }
    }
    return {
      orderId,
      paid: remote.status === 'COMPLETED',
      failed: remote.status === 'VOIDED',
      providerOrderId: remote.id || remoteId,
      payload: remote
    }
  }
}

export const DRIVERS = { stripe, paypal }
export const driverFor = (config) => DRIVERS[String(config?.driver || '').toLowerCase()] || null
