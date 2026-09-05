// Every provider here needs a driver; none of them is one configurable JSON POST, which is what the
// generic public_config path in checkout.mjs can do. Stripe's REST API only accepts
// application/x-www-form-urlencoded bodies, PayPal needs an OAuth2 token exchange before it will
// create an order, PayerURL needs an HMAC over the request body it is attached to, Alipay RSA2-signs
// every call it accepts, 虎皮椒 (XunHuPay) needs an MD5 over a ksorted parameter string, and
// NOWPayments needs its key in a header the generic path does not send.
//
// A payment_providers row without a driver is therefore not a payment method: its callback falls
// through to the generic HMAC branch in payment-callback.mjs, which hashes a re-serialized body and so
// cannot match any real provider's signature. Adding a payment method means writing a driver.
//
// Two ways to verify a callback, and which one a provider gets is decided by one thing: whether its
// signature survives Vercel parsing the body before the handler runs.
//
//  * Re-query (Stripe, PayPal, NOWPayments). A re-serialized body can never match a signature taken
//    over the original bytes, so the callback is treated as a "go look" trigger and the authoritative
//    state is read back from the provider. A forged callback costs one extra API read and cannot mark
//    an unpaid order as paid — the provider's own answer decides.
//  * Signature (PayerURL, Alipay, 虎皮椒). These sign a canonical sorted form of the parameters rather
//    than the raw bytes, so the parsing is harmless. See payerurlQuery, alipaySignContent and
//    xunhupaySignContent below. 虎皮椒 does both: it verifies the hash and then re-queries, because its
//    notify is not documented to carry the amount.

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
const ZERO_DECIMAL = new Set(['HUF', 'JPY', 'TWD'])
export const decimalAmount = (minor, currency) =>
  ZERO_DECIMAL.has(String(currency).toUpperCase()) ? String(Math.round(minor)) : (minor / 100).toFixed(2)

// The inverse, for reading an amount a provider reports back. Multiplying by 100 unconditionally would
// turn a ¥2000 order (2000 minor) into 200000 and 409 a payment that was in fact exact.
export const minorAmount = (decimal, currency) => {
  const value = Number(decimal)
  if (!Number.isFinite(value)) return NaN
  return ZERO_DECIMAL.has(String(currency).toUpperCase()) ? Math.round(value) : Math.round(value * 100)
}

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

// Alipay（支付宝开放平台 v1.0 网关）。一个驱动同时覆盖「电脑网站支付」(alipay.trade.page.pay) 和
// 「手机网站支付」(alipay.trade.wap.pay)：两者的公共参数、签名规则、异步通知格式完全一样，只有 method
// 和 biz_content.product_code 两个字段不同，所以按 User-Agent 分流，而不是做成两个驱动。
//
// 为什么不能走 checkout.mjs 的通用 create_url 路径：支付宝的每一次调用都要 RSA2 签名，而通用路径只能发
// 一个模板化的 JSON POST。只把 ALIPAY_* 变量填好而没有驱动，得到的只会是网关的 Invalid signature——
// 这也是原来 schema 里那四个变量名的真实处境：一份没有任何代码读的清单。
//
// 支付宝网关这边一次请求都不发。page.pay / wap.pay 的正确用法是把签好名的参数拼成一条 GET URL 让买家
// 跳过去（官方 SDK 的 pageExecute(request, "GET") 返回的就是这个），所以 create 只做拼装和签名，既不会
// 因为网关抖动而失败，也不会留下「订单已建好但没有 checkout_url」的中间态。唯一的外部调用是非人民币
// 订单的汇率查询（见 cnyRate），人民币订单走不到那里。
//
// 密钥用「公钥模式」而不是「证书模式」：证书模式要三个 .crt 文件，塞不进一个环境变量。
// ALIPAY_PRIVATE_KEY 是商户自己的 RSA 私钥（签请求用），ALIPAY_PUBLIC_KEY 是支付宝公钥（验通知用），
// 两者不是一对密钥。支付宝的模型里没有共享密钥，所以 ALIPAY_WEBHOOK_SECRET 这个名字在这里没有含义。
export const ALIPAY_GATEWAY = 'https://openapi.alipay.com/gateway.do'
// 沙箱网关。alipaydev.com 只认沙箱应用的 APP_ID，正式应用打到这里会得到 40002。
export const ALIPAY_SANDBOX_GATEWAY = 'https://openapi-sandbox.dl.alipaydev.com/gateway.do'

const alipayGateway = (config) => config.gateway
  || (String(config.environment || '').toLowerCase() === 'sandbox' ? ALIPAY_SANDBOX_GATEWAY : ALIPAY_GATEWAY)

// 开放平台的密钥工具给出的是不带头尾、不换行的一长串 base64；从 .pem 文件里复制出来的又带头尾。Node 的
// crypto 只认 PEM，所以两种都收：已经是 PEM 的原样用（顺带把环境变量里常见的字面量 \n 还原成换行），
// 裸 base64 补上头尾并每 64 字符断行。补头尾时按 PKCS#8 写，因为工具默认导出的就是 PKCS#8；真是 PKCS#1
// 的密钥自带 BEGIN RSA PRIVATE KEY 头，走上面那条分支。
export function alipayPem(raw, kind) {
  const text = String(raw || '').trim()
  if (!text) throw new Error(`Alipay ${kind} key is empty`)
  if (text.includes('-----BEGIN')) return text.replace(/\\n/g, '\n')
  const label = kind === 'private' ? 'PRIVATE KEY' : 'PUBLIC KEY'
  const body = text.replace(/[\s\\n]+/g, '').match(/.{1,64}/g)?.join('\n') || ''
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`
}

// 网关要求 timestamp 是 GMT+8 的 yyyy-MM-dd HH:mm:ss。偏移是算出来的，不是读本地时间：函数不在
// Asia/Shanghai 跑，用 toLocaleString() 会拿到 Vercel 所在时区的时间，而网关只接受与自己相差一小时
// 以内的时间戳，差得远了会被判为请求过期。
export const alipayTimestamp = (date = new Date()) =>
  new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')

// 待签名串：去掉 sign、去掉空值，键按 ASCII 升序，用 k=v& 拼起来——值不做 URL 编码。
//
// exclude 是请求与通知之间唯一的区别，也是这套协议最容易记反的一处：签「请求」时 sign_type 参与签名，
// 验「异步通知」时 sign_type 要和 sign 一起剔除（对应官方 SDK 的 getSignContent 与
// getSignCheckContentV1）。记反了不会报错，只会让每一笔付款的通知都验不过，订单永远停在 pending。
export function alipaySignContent(params, exclude = ['sign']) {
  return Object.keys(params || {})
    .filter((key) => !exclude.includes(key) && params[key] !== undefined && params[key] !== null && String(params[key]) !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&')
}

const alipayAlgorithm = (signType) => (String(signType).toUpperCase() === 'RSA' ? 'RSA-SHA1' : 'RSA-SHA256')

export const alipaySign = (params, privateKey, signType = 'RSA2') =>
  crypto.createSign(alipayAlgorithm(signType)).update(alipaySignContent(params), 'utf8')
    .sign(alipayPem(privateKey, 'private'), 'base64')

/**
 * 验一条支付宝发来的报文。
 *
 * 先按 V1 规则（剔除 sign 和 sign_type）验，不过再按 V2 规则（只剔除 sign）验一次。异步通知用的是 V1，
 * 同步跳转用的是 V2，而两者的字段长得几乎一样，光看正文分不出来。多一次 RSA 验签换掉的是一整类
 * 「参数看着都对但就是验不过」的故障，而那类故障的表现是买家付了钱拿不到货。放宽的只是 sign_type
 * 是否入串，两条规则验的都是支付宝私钥签出来的东西——「谁签的」这一条没有放宽。
 */
export function alipayVerify(params, publicKey) {
  const signature = String(params?.sign || '')
  if (!signature) return false
  const key = alipayPem(publicKey, 'public')
  const algorithm = alipayAlgorithm(params.sign_type)
  const check = (exclude) => {
    try {
      return crypto.createVerify(algorithm).update(alipaySignContent(params, exclude), 'utf8')
        .verify(key, signature, 'base64')
    } catch { return false }
  }
  return check(['sign', 'sign_type']) || check(['sign'])
}

// 只收人民币的渠道（支付宝、虎皮椒）共用的商户订单号编码。
//
// 这些渠道的商户单号一般只允许字母、数字和下划线，而订单 id 是带连字符的 UUID。去掉连字符得到 32 位
// 十六进制，通知回来时再按 8-4-4-4-12 补回去；映射双向确定，所以不必为此多存一列。不是 32 位十六进制的
// 原样返回，这样即使以后订单 id 换了形态，orderId 也不会被读成 null。
//
// 换算过的订单在后面接三段「订单货币_订单金额_人民币金额」。这是回调唯一能拿到下单那一刻汇率的地方：
// verify 只收到通知正文和 public_config，拿不到订单行，而通知里的金额是人民币，订单行上的是原币种，
// 两者得能对上。为什么不写进 orders：商户单号由渠道原样回传且在签名覆盖范围内（买家改不了一个字符，
// 改了整条通知就验不过），所以它已经是一条带签名的回执，再加一列一次查询只是把同一个事实多存一份。
// 支付宝那边上限 64 字节，这里最长 32+1+3+1+10+1+10 = 58。
export const fxMerchantNo = (orderId, fx = null) => {
  const base = String(orderId || '').replace(/-/g, '')
  return fx ? `${base}_${fx.currency}_${fx.amountMinor}_${fx.cnyMinor}` : base
}
export function fxOrderId(outTradeNo) {
  const raw = String(outTradeNo || '')
  const text = raw.split('_')[0]
  if (!/^[0-9a-f]{32}$/i.test(text)) return raw || null
  const grouped = [text.slice(0, 8), text.slice(8, 12), text.slice(12, 16), text.slice(16, 20), text.slice(20)]
  return grouped.join('-').toLowerCase()
}

/** 从商户订单号里取回下单时锁定的换算。三段缺一不可，形状不对就当没有换算（人民币订单）。 */
export function fxLocked(outTradeNo) {
  const parts = String(outTradeNo || '').split('_')
  if (parts.length !== 4) return null
  const [, currency, amount, cny] = parts
  const amountMinor = Number(amount)
  const cnyMinor = Number(cny)
  if (!/^[A-Z]{3}$/.test(currency)) return null
  if (!Number.isInteger(amountMinor) || amountMinor <= 0 || !Number.isInteger(cnyMinor) || cnyMinor <= 0) return null
  return { currency, amountMinor, cnyMinor }
}

/**
 * 非人民币订单的换算汇率：1 单位订单货币兑多少人民币。支付宝和虎皮椒共用。
 *
 * 这两个渠道都只结算人民币，金额字段的单位都是元，所以一笔美元订单要么换算要么根本发不出去——把 19.99
 * 直接当成 19.99 元，收到的是同样数字的人民币，少收约 86%，而从下单到通知没有一步会报错。
 *
 * 两个来源，顺序是有意的：
 * 1. public_config.fx_rates（如 {"USD": 7.15}）。管理员钉死的数字，一次网络请求都不发，也不会因为第三方
 *    停服而下不了单。想按某个内部结算价收款就填这里。
 * 2. 否则查 fx_url（默认 frankfurter.app，转的是欧洲央行每日参考汇率，免费、不要 key）。
 *
 * 查不到就抛，绝不回落到 1：回落把「不知道汇率」变成「按 1:1 收款」，而那正是这个函数存在的原因。抛出来
 * 的是一个买家在结账页上能看见的错误，比一笔静默少收八成的成交要好。
 *
 * 参考汇率是中间价，实际结汇有点差；public_config.fx_markup 填 0.02 就在汇率上加 2%，默认不加——擅自
 * 加价比少收一点更难向买家解释。
 */
export const CNY_FX_URL = 'https://api.frankfurter.app/latest'
const CNY_FX_TTL_MS = 10 * 60 * 1000
// 只在一个函数实例的生命周期内有效。Fluid Compute 会复用实例，所以这挡掉的是「同一分钟里每次下单都打一
// 次外部接口」；实例换了就重新查，不需要跨实例一致——汇率只要在下单那一刻是真的。缓存的是原始汇率而不是
// 加过点差的值，这样改 fx_markup 立刻生效。
const cnyFxCache = new Map()

export async function cnyRate(currency, config = {}, { now = Date.now(), fetchJson = json } = {}) {
  const code = String(currency || '').toUpperCase()
  if (!code || code === 'CNY') return 1
  const markup = Number(config.fx_markup)
  const factor = 1 + (Number.isFinite(markup) && markup > 0 && markup <= 0.2 ? markup : 0)

  const pinned = Number(config.fx_rates?.[code])
  if (Number.isFinite(pinned) && pinned > 0) return pinned * factor

  const cached = cnyFxCache.get(code)
  if (cached && now - cached.at < CNY_FX_TTL_MS) return cached.rate * factor

  const url = `${config.fx_url || CNY_FX_URL}?from=${encodeURIComponent(code)}&to=CNY`
  let rate = NaN
  try {
    const body = await fetchJson(url)
    rate = Number(body?.rates?.CNY ?? body?.CNY ?? body?.rate)
  } catch (error) {
    throw new Error(`拿不到 ${code} 兑人民币的汇率（${error.message}），请稍后重试，或在该支付方式的公开配置里用 fx_rates 钉一个汇率`)
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`汇率接口没有返回 ${code} 兑人民币的汇率，请在该支付方式的公开配置里用 fx_rates 钉一个`)
  }
  cnyFxCache.set(code, { rate, at: now })
  return rate * factor
}

/**
 * 订单金额 → 人民币收款金额（元，两位小数字符串），外加一份能在回调里复原的换算记录。
 * 支付宝的 total_amount 和虎皮椒的 total_fee 要的都是这个形状。
 *
 * rate 是 1 单位订单货币兑多少人民币，人民币订单不看它。分位向上取整：向下取整会让每一笔换算过的订单少
 * 收最多一分，而少收一分在回调里就是一个 409——payment-callback 拿通知金额跟订单行比，差一分就不放货。
 * 向上取整之后 floor(amountMinor × 实收人民币 ÷ 应收人民币) 必然回到订单金额本身，那条比较才恒真。
 */
export function cnyCharge(order, rate = 1) {
  const currency = String(order?.currency || '').toUpperCase()
  const minor = Math.round(Number(order?.amount_minor))
  if (!Number.isFinite(minor) || minor < 1) throw new Error('人民币渠道的最小收款金额是 0.01 元')
  if (currency === 'CNY') return { total: (minor / 100).toFixed(2), fx: null }
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`没有 ${currency || '（空）'} 兑人民币的汇率，这笔订单发不出去`)
  const cnyMinor = Math.ceil(minor * rate)
  return { total: (cnyMinor / 100).toFixed(2), fx: { currency, amountMinor: minor, cnyMinor } }
}

// 人民币渠道共用的手机端判断。手机和电脑要的是两个不同的收银台：支付宝的 page.pay 在手机上会渲染成一个
// 缩得很小的电脑页面且唤不起 App，反过来 wap.pay 在电脑上只给一张二维码；虎皮椒同理（见 xunhupayBody）。
// 各渠道的 public_config 都能钉死这个判断，不必依赖 UA。
export const MOBILE_UA = /Android|iPhone|iPad|iPod|IEMobile|Windows Phone|HarmonyOS|Mobile/i
export const isMobileUa = (headers = {}) => MOBILE_UA.test(String(headers['user-agent'] || ''))

export const ALIPAY_PRODUCTS = {
  page: { method: 'alipay.trade.page.pay', productCode: 'FAST_INSTANT_TRADE_PAY' },
  wap: { method: 'alipay.trade.wap.pay', productCode: 'QUICK_WAP_WAY' }
}
export const alipayProduct = (config = {}, headers = {}) =>
  ALIPAY_PRODUCTS[String(config.product || '').toLowerCase()]
  || (isMobileUa(headers) ? ALIPAY_PRODUCTS.wap : ALIPAY_PRODUCTS.page)

// 按 UTF-8 字节裁剪，且不把一个多字节字符切成两半——切掉半个汉字会让收银台标题从那里开始变成乱码。
export function utf8Clip(text, limit) {
  const source = String(text || '')
  if (Buffer.byteLength(source, 'utf8') <= limit) return source
  let out = ''
  for (const char of source) {
    if (Buffer.byteLength(out + char, 'utf8') > limit) break
    out += char
  }
  return out
}

// 收银台标题。换行会让标题串行，所以先把空白折叠成单个空格再按字节裁。支付宝 subject 上限 256 字节、
// 虎皮椒 title 没有公开上限，统一裁到 128 字节——够放商品名，也不会撞上任何一边的限制。
export const cnyTitle = (artifact, order, limit = 128) =>
  utf8Clip(String(artifact?.name || order?.sku || '订单').replace(/\s+/g, ' ').trim(), limit)

export function alipayRequestParams({ order, artifact, siteUrl, config = {}, headers = {}, now = new Date(), rate = 1 }) {
  const product = alipayProduct(config, headers)
  const charge = cnyCharge(order, rate)
  const biz = {
    out_trade_no: fxMerchantNo(order.id, charge.fx),
    total_amount: charge.total,
    subject: cnyTitle(artifact, order),
    product_code: product.productCode,
    // 收银台超时。支付宝在这之后自动关单并发一条 TRADE_CLOSED，订单因此不会永远挂在 pending。
    timeout_express: config.timeout_express || '30m'
  }
  // quit_url 是买家在支付宝里点「返回」时去的地址；不给的话他会退到一个空白页。只有 wap 认这个字段。
  if (product === ALIPAY_PRODUCTS.wap) biz.quit_url = orderUrl(siteUrl, order.id)
  return {
    app_id: env(config.app_id_env || 'ALIPAY_APP_ID'),
    method: product.method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: String(config.sign_type || 'RSA2').toUpperCase(),
    timestamp: alipayTimestamp(now),
    version: '1.0',
    notify_url: `${siteUrl}/v1/callback/alipay`,
    return_url: orderUrl(siteUrl, order.id, true),
    biz_content: JSON.stringify(biz)
  }
}

// GET 模式：网关地址 + 全部公共参数 + sign，整串做 URL 编码。等价于官方 SDK 的
// pageExecute(request, "GET")，返回值就是可以直接让浏览器跳转的收银台地址。参数在 URL 里的顺序无关，
// 因为签名是在排好序的待签名串上算的。
export function alipayCheckoutUrl(params, privateKey, gateway = ALIPAY_GATEWAY) {
  const query = new URLSearchParams({ ...params, sign: alipaySign(params, privateKey, params.sign_type) })
  return `${gateway}?${query.toString()}`
}

const alipay = {
  async create({ order, artifact, siteUrl, config = {}, headers = {} }) {
    // 人民币订单这里直接拿到 1，走不到汇率接口；非人民币订单在这一刻把汇率锁进 out_trade_no。
    const rate = await cnyRate(order?.currency, config)
    const params = alipayRequestParams({ order, artifact, siteUrl, config, headers, rate })
    const checkoutUrl = alipayCheckoutUrl(params, env(config.private_key_env || 'ALIPAY_PRIVATE_KEY'), alipayGateway(config))
    // 买家付款之前，支付宝侧不存在任何单号，所以这里回的是商户订单号——它同时是支付宝后台「商户订单号」
    // 那一栏能搜到的值，出问题时有个东西可查。通知到达后会被换成 trade_no（支付宝自己的交易号）。从
    // biz_content 里读回来而不是重算一遍：换算过的订单，单号尾部带着那三段汇率，重算会得到一个网关侧
    // 根本不存在的号。
    return { checkoutUrl, providerOrderId: JSON.parse(params.biz_content).out_trade_no }
  },
  /**
   * 异步通知。ack 里那两个字面量是硬要求：支付宝只认正文等于 success，任何别的正文（包括一个
   * {"ok":true} 的 JSON）都被判为通知失败，同一笔付款会按 1m/2m/10m/…/24h 重投 8 次。
   *
   * 通知是 application/x-www-form-urlencoded，而支付宝签的是排序后的参数而不是原始字节，所以
   * Vercel 先解析一遍 body 不影响验签（和 PayerURL 同理，和 Stripe / PayPal 不同）。
   */
  async verify({ payload, config = {} }) {
    const body = payload || {}
    const ack = { ok: 'success', fail: 'failure' }
    const appId = env(config.app_id_env || 'ALIPAY_APP_ID')
    if (!body.sign) return { ack, reject: { status: 401, error: 'Alipay callback carries no signature' } }
    // app_id 必须判：验签只证明「这是支付宝签的」，不证明「这是签给我们这个应用的」。第三方授权场景下
    // 真正的收款应用在 auth_app_id 里，所以两个字段都认。
    if (String(body.auth_app_id || body.app_id || '') !== appId)
      return { ack, reject: { status: 401, error: 'Alipay callback belongs to another app' } }
    if (!alipayVerify(body, env(config.public_key_env || 'ALIPAY_PUBLIC_KEY')))
      return { ack, reject: { status: 401, error: 'Alipay callback signature not matched' } }
    // 验签之后才读业务字段。trade_status 在签名覆盖范围内，先读它等于先信一个未经认证的字符串。
    const status = String(body.trade_status || '')
    // 退款、对账之类的通知没有 trade_status。它们动不到订单状态，但也必须回一句 success，否则支付宝会
    // 拿同一条通知重投一整天。
    if (!status) return { ack, ignore: true }
    const orderId = fxOrderId(body.out_trade_no)
    if (!orderId) return { ack, reject: { status: 400, error: 'Alipay callback carries no out_trade_no' } }
    const total = Number(body.total_amount)
    // total_amount 是这笔交易的订单总额，单位是元，币种恒为人民币。
    const paidCny = Number.isFinite(total) && total > 0 ? Math.round(total * 100) : 0
    // 换算过的订单，下单时那一刻的「原币金额 ↔ 人民币金额」被锁在 out_trade_no 里跟着通知回来了。
    const fx = fxLocked(body.out_trade_no)
    return {
      orderId,
      // TRADE_FINISHED 是「交易结束、不可退款」，钱早就到账了，不是失败。WAIT_BUYER_PAY 两个都不是，
      // 订单留在 pending，等 timeout_express 到点后的 TRADE_CLOSED 来收尾。
      paid: status === 'TRADE_SUCCESS' || status === 'TRADE_FINISHED',
      failed: status === 'TRADE_CLOSED',
      // 换算过的订单号带着尾部三段，原样回传的就是它；重新拼一个 32 位的会让后台搜不到。
      providerOrderId: body.trade_no ? String(body.trade_no) : String(body.out_trade_no || ''),
      // 少付一分就不放货：handler 会拿这里的数字跟订单行比。换算过的订单按下单时锁定的那一对金额成
      // 比例折回原币种，而不是用通知到达这一刻的汇率重算——汇率每天都在动，重算会把一笔足额付款变成
      // 409。整数运算，且下单时是向上取整的，所以足额付款折回来必然正好等于订单金额。
      expect: paidCny > 0
        ? (fx
            ? { amountMinor: Math.floor(fx.amountMinor * paidCny / fx.cnyMinor), currency: fx.currency }
            : { amountMinor: paidCny, currency: 'CNY' })
        : null,
      payload: body,
      ack
    }
  }
}

// 虎皮椒（XunHuPay，聚合支付）。一个驱动同时覆盖支付宝和微信两条通道：厂商自己的两个 WooCommerce 插件
// 除了 plugins 这一个字段和手机端那三个字段之外逐字节相同，是同一套协议，所以按 payment_providers 行分流
// （xunhupay_alipay / xunhupay_wechat 共用这个驱动），而不是写两个驱动。
//
// 为什么加这条渠道：支付宝和微信的官方网站支付都要「营业执照 + 已完成 ICP 备案的域名」，而本站域名是
// Cloudflare 上的 .it，在中国大陆备不了案——这不是缺个资料，是这条路根本走不通。聚合支付（小微商户模式）
// 是这个前提下唯一能收人民币的通道：收款主体是虎皮椒，本站只是它的一个商户号。
//
// 下面每一条协议细节都来自厂商插件源码本身（xunhu-alipay-payment-for-woocommerce 与
// xunhu-wechat-payment-for-woocommerce 的 src/PaymentGateway.php），不是文档也不是回忆。文档里没有的东西
// 在注释里写明「没有公开」，而不是猜一个。
export const XUNHUPAY_BASE = 'https://api.xunhupay.com'

// 待签名串：ksort 后跳过 hash 键、跳过 null 和空字符串，用 k=v& 拼起来，值不做任何编码；再 md5(串 + 密钥)。
//
// 密钥拼在后面而不是前面，所以这里不存在 MD5 长度扩展那一类问题。三处容易记错的地方：
// 1. 跳过的是 null 和 ''，不包括 0 和 '0'——把 0 一起跳掉会让任何带零值字段的报文验不过。
// 2. 值不 URL 编码。带中文的 title 是原样入串的，所以签名前后必须都用同一个字符串。
// 3. 排序按 ASCII 升序（PHP 的 ksort 对纯字符串键就是 ASCII 序），和 JS 的默认 sort 一致。
export function xunhupaySignContent(params) {
  return Object.keys(params || {})
    .filter((key) => key !== 'hash' && params[key] !== undefined && params[key] !== null && String(params[key]) !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&')
}

export const xunhupayHash = (params, appSecret) =>
  crypto.createHash('md5').update(`${xunhupaySignContent(params)}${appSecret}`, 'utf8').digest('hex')

// 厂商用 str_shuffle(time()) 生成 nonce_str，也就是一串纯数字。这里保持同一形态而不是换成 hex：这个字段
// 参与签名，而「服务端会不会对它做格式校验」没有任何公开说明，跟着已验证的实现走风险最低。
const xunhupayNonce = () => String(crypto.randomInt(1_000_000_000, 10_000_000_000))

const xunhupayKeys = (config) => ({
  appid: env(config.appid_env || 'XUNHUPAY_APPID'),
  appSecret: env(config.app_secret_env || 'XUNHUPAY_APP_SECRET')
})

const xunhupayBase = (config) => String(config.api_base || XUNHUPAY_BASE).replace(/\/+$/, '')

// plugins 是厂商用来区分接入方的标识，且会在异步通知里原样回传（插件拿它挡掉「另一个通道的通知打到这个
// 端点」）。厂商两个插件分别写死 woo-alipay / woo-wechat，这里默认用 payment_providers 的行 id，需要时用
// public_config.plugins 覆盖——万一服务端真的校验这个值，改一个键就能对上，不用改代码。
export const xunhupayPlugins = (order, config = {}) => String(config.plugins || order?.provider || 'aetherac')

/**
 * 下单请求体。
 *
 * total_fee 必须是字符串。这是整套协议里最容易踩的一处：签名串是在服务端 json_decode 之后重新拼的，如果
 * 这里发 JSON 数字 20.00，JSON.stringify 会写成 20，服务端拿到的是数字 20，拼出来的是 total_fee=20，而我们
 * 签的是 total_fee=20.00——每一笔两位小数末尾为 0 的订单都会验签失败。发字符串则原样往返。
 */
export function xunhupayBody({ order, artifact, siteUrl, config = {}, headers = {}, now = Date.now(), rate = 1, nonce = xunhupayNonce() }) {
  const charge = cnyCharge(order, rate)
  const body = {
    version: String(config.version || '1.1'),
    plugins: xunhupayPlugins(order, config),
    appid: env(config.appid_env || 'XUNHUPAY_APPID'),
    trade_order_id: fxMerchantNo(order.id, charge.fx),
    total_fee: charge.total,
    title: cnyTitle(artifact, order),
    // 服务端按这个时间戳判请求是否已超时，单位是秒。
    time: String(Math.floor(now / 1000)),
    // 通知地址带上 provider 行 id，所以支付宝行和微信行各收自己的通知，互不串线。
    notify_url: `${siteUrl}/v1/callback/${order.provider}`,
    return_url: orderUrl(siteUrl, order.id, true),
    // 买家在收银台点「取消 / 返回」时去的地址。
    callback_url: orderUrl(siteUrl, order.id),
    nonce_str: nonce
  }
  // 手机端三个字段：厂商的微信插件在手机 UA 下才加，支付宝插件从来不加。两边共用一套服务端，所以这里按
  // UA 统一加，public_config.wap 写 true / false 可以钉死。缺了它们，手机上唤不起 App。
  const wap = config.wap === undefined || config.wap === null ? isMobileUa(headers) : Boolean(config.wap)
  if (wap) {
    body.type = 'WAP'
    body.wap_url = siteUrl
    body.wap_name = String(config.wap_name || new URL(siteUrl).host)
  }
  return { body, fx: charge.fx }
}

// 下单和查单的 Content-Type 都跟着厂商走：它用 curl 的 CURLOPT_POSTFIELDS 传一个字符串，没设过 header，
// 所以两个接口收到的都是 application/x-www-form-urlencoded——下单那个的正文其实是 JSON，只是标签不对。
// 服务端明摆着不看这个头，但既然只有这一种组合被真实交易验证过，就照发。
const XUNHUPAY_CONTENT_TYPE = 'application/x-www-form-urlencoded'

async function xunhupayPost(url, body, contentType = XUNHUPAY_CONTENT_TYPE, fetchJson = json) {
  const result = await fetchJson(url, { method: 'POST', headers: { 'Content-Type': contentType }, body })
  // errcode 是字符串还是数字没有公开说明，厂商用的是 != 0 这种松比较，这里用 Number() 收敛。
  if (Number(result?.errcode) !== 0) throw new Error(result?.errmsg || `虎皮椒返回 errcode=${result?.errcode}`)
  return result
}

/** 查单。out_trade_order 是下单时的 trade_order_id（换算过的订单带着那三段尾巴，要原样传）。 */
export async function xunhupayQuery(tradeOrderId, config = {}, { now = Date.now(), nonce = xunhupayNonce(), fetchJson = json } = {}) {
  const { appid, appSecret } = xunhupayKeys(config)
  const request = { appid, out_trade_order: String(tradeOrderId), time: String(Math.floor(now / 1000)), nonce_str: nonce }
  request.hash = xunhupayHash(request, appSecret)
  // 查单是表单编码，不是 JSON——厂商这里用的是 http_build_query。
  const result = await xunhupayPost(`${xunhupayBase(config)}/payment/query.html`, new URLSearchParams(request).toString(), XUNHUPAY_CONTENT_TYPE, fetchJson)
  return result?.data || {}
}

// 厂商插件里 transacton_id 少一个 i，同一个文件里另一处又写对了 transaction_id。哪个是服务端真实字段名无从
// 判断，所以两个都读——读错的那个会是 undefined，读对的那个给出交易号。
const xunhupayTransactionId = (row = {}) => {
  const value = row.transaction_id ?? row.transacton_id ?? row.open_order_id
  return value ? String(value) : null
}

// 状态。OD 是唯一有公开依据的取值（厂商两个插件、通知和查单四处都只判它）。别的取值一律不当失败：把一个
// 没见过的字符串读成失败，会把一笔还在等买家扫码的订单直接判死。订单不会因此永远挂着——站点自己的过期
// 逻辑会收尾。
const xunhupayPaid = (status) => String(status || '').toUpperCase() === 'OD'

const xunhupay = {
  async create({ order, artifact, siteUrl, config = {}, headers = {}, fetchJson = json }) {
    const { appSecret } = xunhupayKeys(config)
    // 人民币订单这里直接拿到 1，走不到汇率接口；非人民币订单在这一刻把汇率锁进 trade_order_id。
    const rate = await cnyRate(order?.currency, config, { fetchJson })
    const { body } = xunhupayBody({ order, artifact, siteUrl, config, headers, rate })
    body.hash = xunhupayHash(body, appSecret)
    // 签名和正文必须来自同一个对象：先签再序列化，中间不动任何字段。
    const created = await xunhupayPost(`${xunhupayBase(config)}/payment/do.html`, JSON.stringify(body), XUNHUPAY_CONTENT_TYPE, fetchJson)
    // url 是收银台地址，url_qrcode 是一张二维码图片的地址。厂商插件只在手机端跳 url，电脑端把 url_qrcode
    // 渲染成 <img>——而驱动契约只能回一个 checkoutUrl，图片地址放进去买家会看到一张裸图。所以默认跳 url
    // （它是收银台页面，电脑上应当自己显示二维码），public_config.checkout_field 写 url_qrcode 可以改。
    // 「电脑端的 url 是不是可用的收银台」这一条没有任何官方说明能证实，只有一笔真实付款能定论。
    const field = String(config.checkout_field || 'url')
    const checkoutUrl = created[field] || created.url || created.url_qrcode || null
    if (!checkoutUrl) throw new Error('虎皮椒没有返回收银台地址')
    // 买家付款前虎皮椒侧没有交易号，所以先记商户单号——它同时是虎皮椒后台能搜到的那一栏。
    return { checkoutUrl, providerOrderId: body.trade_order_id }
  },

  /**
   * 异步通知。
   *
   * ack.ok 那个 success 是硬要求：厂商插件验完就 print 'success'，回别的正文（包括一个 {"ok":true}）会被
   * 判为通知失败并重投。payment-callback 的 catch 会把异常变成 500 + JSON，那正好也是「让它重投」。
   *
   * 通知是表单 POST，而签名算的是排序后的参数、不是原始字节，所以 Vercel 先解析一遍 body 不影响验签
   * （和支付宝、PayerURL 同理，和 Stripe / PayPal 不同）。
   */
  async verify({ payload, config = {}, provider = null, fetchJson = json }) {
    const body = payload || {}
    const ack = { ok: 'success', fail: 'failure' }
    const { appSecret } = xunhupayKeys(config)
    if (!body.hash) return { ack, reject: { status: 401, error: 'XunHuPay callback carries no hash' } }
    if (!body.trade_order_id) return { ack, reject: { status: 400, error: 'XunHuPay callback carries no trade_order_id' } }
    if (!sameDigest(String(body.hash).toLowerCase(), xunhupayHash(body, appSecret)))
      return { ack, reject: { status: 401, error: 'XunHuPay callback signature not matched' } }
    // plugins 在签名覆盖范围内，所以这一条挡的不是伪造，而是「支付宝行的通知打到了微信行的端点」——两行
    // 共用一个 appid 时，走错端点会把订单记到另一条渠道上。通知里没带 plugins 就不判（厂商也是这么做的）。
    const expectPlugins = xunhupayPlugins({ provider }, config)
    if (body.plugins && expectPlugins && String(body.plugins) !== expectPlugins)
      return { ack, reject: { status: 401, error: 'XunHuPay callback belongs to another channel' } }

    // 验签之后才读业务字段——先读等于先信一个未经认证的字符串。
    const tradeOrderId = String(body.trade_order_id)
    const orderId = fxOrderId(tradeOrderId)
    if (!orderId) return { ack, reject: { status: 400, error: 'XunHuPay callback carries no order id' } }
    let status = body.status
    let transactionId = xunhupayTransactionId(body)
    // 通知里带不带 total_fee 没有公开说明，厂商插件一处都没读过。带了就用（它在签名覆盖范围内），没带就
    // 靠下面这次查单补上——否则这笔付款就没有金额可比，少付也会放货。
    let paidFee = Number(body.total_fee)

    // 回查一次。验签已经是安全边界（算得出这个 hash 就等于握有密钥），这次查单换的是两件别的事：拿到
    // 权威金额，以及在通知字段缺失时兜底。查不通就退回已验签的通知，不阻塞发货——虎皮椒那边会重投，而
    // 把一笔已验签的足额付款卡在网络抖动上，代价是买家付了钱拿不到货。public_config.requery 写 false 可关。
    if (config.requery !== false) {
      try {
        const remote = await xunhupayQuery(tradeOrderId, config, { fetchJson })
        if (remote.status !== undefined) status = remote.status
        transactionId = xunhupayTransactionId(remote) || transactionId
        const remoteFee = Number(remote.total_fee)
        if (Number.isFinite(remoteFee) && remoteFee > 0) paidFee = remoteFee
      } catch { /* 通知已验签，查单只是补强：拿不到就用通知里的值 */ }
    }

    // total_fee 的单位是元，币种恒为人民币。
    const paidCny = Number.isFinite(paidFee) && paidFee > 0 ? Math.round(paidFee * 100) : 0
    const fx = fxLocked(tradeOrderId)
    return {
      orderId,
      paid: xunhupayPaid(status),
      // 没有任何一个取值有公开依据表示「交易失败」，所以从不主动判失败。
      failed: false,
      providerOrderId: transactionId || tradeOrderId,
      // 少付一分就不放货。换算过的订单按下单时锁在商户单号里的那一对金额折回原币种，而不是用通知到达这
      // 一刻的汇率重算——重算会把一笔足额付款变成 409。金额拿不到就不比（null），此时挡不住少付，这是
      // 「通知里到底有没有 total_fee」没有公开说明的直接后果，一笔真实付款就能定论。
      expect: paidCny > 0
        ? (fx
            ? { amountMinor: Math.floor(fx.amountMinor * paidCny / fx.cnyMinor), currency: fx.currency }
            : { amountMinor: paidCny, currency: 'CNY' })
        : null,
      payload: body,
      ack
    }
  }
}

// NOWPayments（加密货币）。PayerURL 之外的第二条加密通道，理由不是「多一个选择」：PayerURL 只在自己的
// 后台里存在一个 Payment Button，回调地址随单下发，出问题时没有任何可查的东西；NOWPayments 有 IPN 密钥、
// 有查单接口，也有沙箱。两条通道互为备份。
//
// 回调走「回查」而不是验签，和 Stripe / PayPal 同理。它的 IPN 签名是 HMAC-SHA512 over
// json_encode(ksort(body))——PHP 的 json_encode 会把 / 转义成 \/、非 ASCII 转成 \uXXXX，而 JS 的
// JSON.stringify 都不会，所以「照抄它的验签」在任何带 URL 的字段上都会失败。厂商自己的 WooCommerce 插件
// 就是这个处境：它一次算四种序列化变体去逐个比对（class-npwc-gateway.php 的 payload_variants）。而 Vercel
// 在 handler 之前就把 body 解析掉了，连原始字节都没有，第五种变体也补不回来。所以这里不看签名，只把回调
// 当一个「去查一下」的信号：伪造一条回调的代价是多一次 API 读，改不动订单状态。
//
// 协议出处：官方 SDK @nowpaymentsio/nowpayments-api-js 1.0.5 与官方插件
// nowpayments-for-woocommerce 1.4.1。沙箱域名 api-sandbox.nowpayments.io 是本机实测通的那一个——SDK 里
// 写的 api.sandbox.nowpayments.io 连 TLS 都握不上。
export const NOWPAYMENTS_BASE = 'https://api.nowpayments.io/v1'
export const NOWPAYMENTS_SANDBOX_BASE = 'https://api-sandbox.nowpayments.io/v1'

const nowpaymentsBase = (config = {}) => String(config.api_base
  || (String(config.environment || process.env.NOWPAYMENTS_ENV || 'live').toLowerCase() === 'sandbox'
    ? NOWPAYMENTS_SANDBOX_BASE
    : NOWPAYMENTS_BASE)).replace(/\/+$/, '')

// price_amount 是法币金额，是数字而不是字符串（SDK 的 ICreateInvoice 与插件的 (float) 转换都是数字），
// 零小数币种不能被除 100，所以走 decimalAmount 再转回数字。
export const nowpaymentsInvoiceBody = ({ order, artifact, siteUrl, config = {} }) => ({
  price_amount: Number(decimalAmount(order.amount_minor, order.currency)),
  price_currency: String(order.currency).toLowerCase(),
  order_id: order.id,
  order_description: cnyTitle(artifact, order, 256),
  ipn_callback_url: `${siteUrl}/v1/callback/${order.provider}`,
  success_url: orderUrl(siteUrl, order.id, true),
  cancel_url: orderUrl(siteUrl, order.id),
  // 钉死买家能用哪个币种。不填就是收银台上让买家自己挑，这是默认。
  ...(config.pay_currency ? { pay_currency: String(config.pay_currency).toLowerCase() } : {})
})

// 只有 finished 放货。confirming / confirmed / sending 都是链上还没落定的中间态，留在 pending 等下一条
// IPN；partially_paid 是「钱到了但不够」，绝不放货——它正是 expect 那一层要挡的东西。
export const NOWPAYMENTS_PAID = new Set(['finished'])
export const NOWPAYMENTS_FAILED = new Set(['failed', 'expired', 'refunded'])

const nowpayments = {
  async create({ order, artifact, siteUrl, config = {}, fetchJson = json }) {
    const key = env(config.api_key_env || 'NOWPAYMENTS_API_KEY')
    const invoice = await fetchJson(`${nowpaymentsBase(config)}/invoice`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(nowpaymentsInvoiceBody({ order, artifact, siteUrl, config }))
    })
    const checkoutUrl = invoice.invoice_url || null
    if (!checkoutUrl) throw new Error(invoice.message || 'NOWPayments returned no invoice URL')
    // 发票 id。付款发生后 IPN 里会带上真正的 payment_id，那时这一列被换掉。
    return { checkoutUrl, providerOrderId: invoice.id ? String(invoice.id) : null }
  },

  /**
   * IPN。不看签名（见上方注释），拿 payment_id 去 GET /payment/{id} 问权威状态。
   *
   * 没有 payment_id 的回调（只有 invoice_id 的发票级事件）无从查证：/invoice/{id} 这个读接口不存在——本机
   * 实测 404，而 /payment/{id} 是 403（未授权，即路由存在）。这种回调直接拒，而不是当成 ignore：ignore 会
   * 回 200 让对方不再重投，而它可能是唯一一次通知。
   */
  async verify({ payload, config = {}, fetchJson = json }) {
    const body = payload || {}
    const paymentId = body.payment_id ?? body.paymentId
    if (!paymentId) return { reject: { status: 400, error: 'NOWPayments callback carries no payment_id' } }
    const key = env(config.api_key_env || 'NOWPAYMENTS_API_KEY')
    const remote = await fetchJson(`${nowpaymentsBase(config)}/payment/${encodeURIComponent(String(paymentId))}`, {
      headers: { 'x-api-key': key }
    })
    const status = String(remote.payment_status || '')
    const priced = Number(remote.price_amount)
    return {
      // 订单 id 取自查单结果而不是回调正文：正文是未经认证的，而这条读是我们自己发起的。
      orderId: remote.order_id ? String(remote.order_id) : null,
      paid: NOWPAYMENTS_PAID.has(status),
      // refunded 只是把订单标回失败，不会收回已经发出去的授权——退款之后要不要吊销许可证是站点自己的事。
      failed: NOWPAYMENTS_FAILED.has(status),
      providerOrderId: String(remote.payment_id || paymentId),
      // 比的是发票的法币金额，不是链上到账数额：actually_paid 的单位是加密货币，跟订单行的货币不可比。
      // 这一层挡的是「回调指向另一笔更便宜的付款」——handler 拿它跟订单行比，少一分就 409。
      // partially_paid 不在 NOWPAYMENTS_PAID 里，所以「钱不够」在上一层就已经拦住了。
      expect: Number.isFinite(priced) && priced > 0
        ? { amountMinor: minorAmount(priced, remote.price_currency), currency: remote.price_currency ? String(remote.price_currency).toUpperCase() : null }
        : null,
      payload: remote
    }
  }
}

export const DRIVERS = { stripe, paypal, payerurl, alipay, xunhupay, nowpayments }
export const driverFor = (config) => DRIVERS[String(config?.driver || '').toLowerCase()] || null
