// Stripe, PayPal and PayerURL cannot ride the generic public_config path in checkout.mjs: Stripe's
// REST API only accepts application/x-www-form-urlencoded bodies (the generic path posts JSON),
// PayPal needs an OAuth2 token exchange before it will create an order, and PayerURL needs an HMAC
// taken over the request body it is attached to. None of the three is one configurable JSON POST.
//
// Stripe's and PayPal's callbacks are verified by re-reading the authoritative state from the
// provider rather than by HMAC. Vercel parses the request body before the handler runs, so a
// re-serialized body can never match a signature taken over the original bytes. A forged callback
// therefore costs one extra API read and cannot mark an unpaid order as paid — the provider's own
// answer decides. PayerURL is the exception that can still be checked by signature, because it signs
// a canonical sorted form of the parameters instead of the raw bytes; see payerurlQuery below.

import crypto from 'node:crypto'

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

// Where a provider sends the buyer back. The order id is a query parameter, not a path segment, and
// that is not cosmetic: VitePress resolves every route through a build-time hash map of its .md files,
// so `/order/<uuid>` has no entry and the client router replaces the page with its own 404 the moment
// JS boots. Vercel's rewrite made the server HTML correct and hid the bug from curl, but a real buyer
// returning from a completed payment saw "404" over money they had already handed over. `/order` is a
// real page, so the query form survives both a hard load and an in-app click.
export const orderUrl = (siteUrl, orderId, paid = false) =>
  `${siteUrl}/order?order_id=${encodeURIComponent(orderId)}${paid ? '&paid=1' : ''}`

// Stripe's unit_amount is already the minor unit, the same integer the artifacts table stores.
export const stripeSessionForm = (order, artifact, siteUrl) => formEncode({
  mode: 'payment',
  client_reference_id: order.id,
  metadata: { order_id: order.id },
  success_url: orderUrl(siteUrl, order.id, true),
  cancel_url: orderUrl(siteUrl, order.id),
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
        return_url: orderUrl(siteUrl, order.id, true),
        cancel_url: orderUrl(siteUrl, order.id)
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

// PayerURL's own Node SDK is the reference for everything below. It is published on npm under
// `binance-crypto-instant-payout-nodejs` (its README calls itself `@payerurl/crypto-checkout`, a name
// that is not actually on the registry), and this reimplements it rather than depending on it: that
// package declares ~40 build tools — esbuild, rollup, sucrase, chokidar — as *runtime* dependencies,
// all of which would be pulled into the function bundle. tests/api-smoke.mjs pins the exact query
// strings and digests the SDK produces, so drifting from it fails the build instead of a payment.
//
// Nothing about the callback is configured in the PayerURL dashboard — there is no setting for it.
// `notify_url` travels with each order, and the merchant's secret key is the HMAC key in both
// directions, which is why PayerURL never issues a separate webhook secret.

// The SDK's encoder: encodeURIComponent with %20 folded back to +. Deliberately *not* PHP's
// urlencode(), which also escapes ! ' ( ) * ~ — matching the SDK is what matches the server that
// recomputes these digests.
const payerurlEncode = (text) => encodeURIComponent(String(text)).replace(/%20/g, '+')

// Only the top level is sorted; nested items keep their own order, and null/undefined are dropped.
export function payerurlQuery(args) {
  const pairs = []
  const walk = (value, prefix) => {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${prefix}[${index}]`))
    if (typeof value === 'object') return Object.entries(value).forEach(([key, item]) => walk(item, `${prefix}[${key}]`))
    pairs.push(`${payerurlEncode(prefix)}=${payerurlEncode(value)}`)
  }
  for (const key of Object.keys(args || {}).sort()) walk(args[key], key)
  return pairs.join('&')
}

export const payerurlSign = (args, secretKey) =>
  crypto.createHmac('sha256', secretKey).update(payerurlQuery(args)).digest('hex')

export const payerurlAuth = (args, publicKey, secretKey) =>
  Buffer.from(`${publicKey}:${payerurlSign(args, secretKey)}`).toString('base64')

const sameDigest = (a, b) => {
  const x = Buffer.from(String(a || ''), 'utf8')
  const y = Buffer.from(String(b || ''), 'utf8')
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

const payerurlKeys = (config) => ({
  publicKey: env(config.public_key_env || 'PAYERURL_PUBLIC_KEY'),
  secretKey: env(config.secret_key_env || 'PAYERURL_SECRET_KEY')
})

// PayerURL insists on a billing identity; Supabase only guarantees an email, so a name is derived.
const payerurlBuyer = (user) => {
  const email = user?.email || ''
  const full = String(user?.user_metadata?.full_name || user?.user_metadata?.name || '').trim()
  const parts = full ? full.split(/\s+/) : [email.split('@')[0] || 'buyer']
  return { billing_fname: parts[0], billing_lname: parts.slice(1).join(' ') || parts[0], billing_email: email }
}

export const PAYERURL_BASE = 'https://api-v2.payerurl.com'

// `amount` is a DECIMAL, despite the SDK README's "Amount in smallest unit" and its example pairing
// `amount: 1000` with `price: '10.00'`. Measured against the live checkout: a 2000-minor (20.00 USD)
// order sent as `amount: 2000` was billed as 2000 USD — a 100x overcharge. The README is wrong about
// its own server, so the server wins. Both money fields are therefore decimal strings, and
// decimalAmount() keeps the zero-decimal currencies from being divided.
export const payerurlPaymentArgs = ({ order, artifact, siteUrl, user, config = {} }) => ({
  order_id: order.id,
  amount: decimalAmount(order.amount_minor, order.currency),
  currency: String(order.currency).toLowerCase(),
  // The SDK rewrites spaces in an item name to underscores, so PayerURL evidently rejects them. The
  // name is trimmed first, or a trailing space becomes a trailing underscore on the checkout page.
  items: [{
    name: String(artifact?.name || order.sku).trim().replace(/ /g, '_'),
    qty: order.quantity || 1,
    price: decimalAmount(Math.round(order.amount_minor / (order.quantity || 1)), order.currency)
  }],
  ...payerurlBuyer(user),
  redirect_to: orderUrl(siteUrl, order.id, true),
  notify_url: `${siteUrl}/v1/callback/payerurl`,
  cancel_url: orderUrl(siteUrl, order.id),
  // The SDK sends `nodejs`; kept configurable because it reads like a platform selector.
  type: config.type || 'nodejs'
})

// The callback signature covers exactly these ten fields, not the whole body — so a field outside the
// list (or one PayerURL adds later) must not be fed to the digest, or every callback would fail.
export const PAYERURL_SIGNED_FIELDS = [
  'order_id', 'ext_transaction_id', 'transaction_id', 'status_code', 'note',
  'confirm_rcv_amnt', 'confirm_rcv_amnt_curr', 'coin_rcv_amnt', 'coin_rcv_amnt_curr', 'txn_time'
]

export const payerurlSignedFields = (body) =>
  Object.fromEntries(PAYERURL_SIGNED_FIELDS.filter((key) => body?.[key] !== undefined).map((key) => [key, body[key]]))

const payerurl = {
  async create(args) {
    const config = args.config || {}
    const { publicKey, secretKey } = payerurlKeys(config)
    const body = payerurlPaymentArgs(args)
    const created = await json(`${config.api_base || PAYERURL_BASE}/api/payment`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${payerurlAuth(body, publicKey, secretKey)}`,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
      },
      // The signed string and the posted body must be byte-identical, so both come from payerurlQuery.
      body: payerurlQuery(body)
    })
    // The SDK treats only `redirectTO` as success; anything else is a failure however cheerful it looks.
    const checkoutUrl = created.redirectTO || null
    if (!checkoutUrl) throw new Error(created.message || 'PayerURL returned no redirect URL')
    return { checkoutUrl, providerOrderId: created.transaction_id || created.id || null }
  },
  // `authStr` is the documented fallback transport for the very token being checked, so it is never
  // part of what was signed. The signature is checked before the status is read: status_code is one of
  // the signed fields, so trusting it first would be trusting an unauthenticated number.
  async verify({ payload, headers, config }) {
    const { publicKey, secretKey } = payerurlKeys(config || {})
    const body = payload || {}
    const presented = String(headers?.authorization || '').replace(/^Bearer\s+/i, '').trim() || String(body.authStr || '').trim()
    // 2030 / 2050 / 20000 are PayerURL's own codes for these three cases, echoed back so its dashboard
    // reads the same reason we did.
    if (!presented) return { reject: { status: 401, error: 'Authorization not found', response: { status: 2030 } } }
    const decoded = Buffer.from(presented, 'base64').toString('utf8')
    const colon = decoded.indexOf(':')
    const claimedKey = colon === -1 ? '' : decoded.slice(0, colon)
    const signature = colon === -1 ? '' : decoded.slice(colon + 1)
    if (claimedKey !== publicKey)
      return { reject: { status: 401, error: "Public key doesn't match", response: { status: 2030 } } }
    if (!sameDigest(signature, payerurlSign(payerurlSignedFields(body), secretKey)))
      return { reject: { status: 401, error: 'Signature not matched', response: { status: 2030 } } }
    const orderId = body.order_id ? String(body.order_id) : null
    const transactionId = body.transaction_id ? String(body.transaction_id) : null
    if (!transactionId) return { reject: { status: 400, error: 'Transaction ID not found', response: { status: 2050 } } }
    if (!orderId) return { reject: { status: 400, error: 'Order ID not found', response: { status: 2050 } } }
    const statusCode = Number(body.status_code)
    // Only 200 releases the goods. The SDK calls everything else an error, but a crypto payment waiting
    // on blockchain confirmation is not a failure — it stays `pending` so a later callback can settle it.
    const paid = statusCode === 200
    const cancelled = statusCode === 20000
    const received = Number(body.confirm_rcv_amnt)
    return {
      orderId,
      paid,
      failed: cancelled,
      providerOrderId: transactionId,
      // PayerURL settles in crypto and reports what actually arrived, so an underpayment must not
      // release the order: the handler compares this against the order row before writing `paid`.
      // Read as a decimal, which is the unit the request side was measured to use. Were it ever the
      // minor unit this over-counts by 100x, which can only accept a full payment, never reject one.
      //
      // No currency is reported: the only currency in the signed set is `confirm_rcv_amnt_curr`, and
      // whether that carries the invoice's fiat code or the coin's ticker is not documented anywhere.
      // Guessing wrong would 409 a real payment, and the amount alone already blocks underpayment.
      expect: Number.isFinite(received) && received > 0 ? { amountMinor: Math.round(received * 100), currency: null } : null,
      payload: body,
      response: { status: paid ? 2040 : cancelled ? 20000 : 2050 }
    }
  }
}

export const DRIVERS = { stripe, paypal, payerurl }
export const driverFor = (config) => DRIVERS[String(config?.driver || '').toLowerCase()] || null
