// Stripe, PayPal, PayerURL and Alipay cannot ride the generic public_config path in checkout.mjs:
// Stripe's REST API only accepts application/x-www-form-urlencoded bodies (the generic path posts
// JSON), PayPal needs an OAuth2 token exchange before it will create an order, PayerURL needs an HMAC
// taken over the request body it is attached to, and Alipay RSA2-signs every call it accepts. None of
// the four is one configurable JSON POST.
//
// Stripe's and PayPal's callbacks are verified by re-reading the authoritative state from the
// provider rather than by HMAC. Vercel parses the request body before the handler runs, so a
// re-serialized body can never match a signature taken over the original bytes. A forged callback
// therefore costs one extra API read and cannot mark an unpaid order as paid — the provider's own
// answer decides. PayerURL and Alipay are the exceptions that can still be checked by signature,
// because they sign a canonical sorted form of the parameters instead of the raw bytes; see
// payerurlQuery and alipaySignContent below.

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

// Alipay（支付宝开放平台 v1.0 网关）。一个驱动同时覆盖「电脑网站支付」(alipay.trade.page.pay) 和
// 「手机网站支付」(alipay.trade.wap.pay)：两者的公共参数、签名规则、异步通知格式完全一样，只有 method
// 和 biz_content.product_code 两个字段不同，所以按 User-Agent 分流，而不是做成两个驱动。
//
// 为什么不能走 checkout.mjs 的通用 create_url 路径：支付宝的每一次调用都要 RSA2 签名，而通用路径只能发
// 一个模板化的 JSON POST。只把 ALIPAY_* 变量填好而没有驱动，得到的只会是网关的 Invalid signature——
// 这也是原来 schema 里那四个变量名的真实处境：一份没有任何代码读的清单。
//
// 这里一次网络请求都不发。page.pay / wap.pay 的正确用法是把签好名的参数拼成一条 GET URL 让买家跳过去
// （官方 SDK 的 pageExecute(request, "GET") 返回的就是这个），所以 create 只做拼装和签名，既不会因为
// 网关抖动而失败，也不会留下「订单已建好但没有 checkout_url」的中间态。
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

// out_trade_no 只允许字母、数字和下划线，而订单 id 是带连字符的 UUID。去掉连字符得到 32 位十六进制，
// 通知回来时再按 8-4-4-4-12 补回去；映射双向确定，所以不必为此多存一列。不是 32 位十六进制的原样返回，
// 这样即使以后订单 id 换了形态，orderId 也不会被读成 null。
export const alipayOutTradeNo = (orderId) => String(orderId || '').replace(/-/g, '')
export function alipayOrderId(outTradeNo) {
  const text = String(outTradeNo || '')
  if (!/^[0-9a-f]{32}$/i.test(text)) return text || null
  const grouped = [text.slice(0, 8), text.slice(8, 12), text.slice(12, 16), text.slice(16, 20), text.slice(20)]
  return grouped.join('-').toLowerCase()
}

// 支付宝国内商户只结算人民币，total_amount 的单位是元。拿一笔美元订单的数字去下单，收到的会是同样数字
// 的人民币——少收约 86%，而且从下单到通知没有任何一步会报错。所以币种不对就抛，绝不换算：汇率不在这里，
// 猜一个只会把一个能看见的错误变成一个看不见的错误。
export function alipayAmount(order) {
  const currency = String(order?.currency || '').toUpperCase()
  if (currency !== 'CNY') throw new Error(`支付宝只能收人民币，这笔订单的币种是 ${currency || '（空）'}`)
  const yuan = Number(order.amount_minor) / 100
  if (!Number.isFinite(yuan) || yuan < 0.01) throw new Error('支付宝的最小收款金额是 0.01 元')
  return yuan.toFixed(2)
}

// 手机浏览器要走 wap.pay：page.pay 在手机上会渲染成一个缩得很小的电脑收银台，也唤不起支付宝 App。
// 反过来 wap.pay 在电脑上只给一张二维码。public_config.product 写 page / wap 可以钉死这个判断。
const ALIPAY_MOBILE = /Android|iPhone|iPad|iPod|IEMobile|Windows Phone|HarmonyOS|Mobile/i
export const ALIPAY_PRODUCTS = {
  page: { method: 'alipay.trade.page.pay', productCode: 'FAST_INSTANT_TRADE_PAY' },
  wap: { method: 'alipay.trade.wap.pay', productCode: 'QUICK_WAP_WAY' }
}
export const alipayProduct = (config = {}, headers = {}) =>
  ALIPAY_PRODUCTS[String(config.product || '').toLowerCase()]
  || (ALIPAY_MOBILE.test(String(headers['user-agent'] || '')) ? ALIPAY_PRODUCTS.wap : ALIPAY_PRODUCTS.page)

// 按 UTF-8 字节裁剪，且不把一个多字节字符切成两半——切掉半个汉字会让收银台标题从那里开始变成乱码。
export function alipayBytes(text, limit) {
  const source = String(text || '')
  if (Buffer.byteLength(source, 'utf8') <= limit) return source
  let out = ''
  for (const char of source) {
    if (Buffer.byteLength(out + char, 'utf8') > limit) break
    out += char
  }
  return out
}

export function alipayRequestParams({ order, artifact, siteUrl, config = {}, headers = {}, now = new Date() }) {
  const product = alipayProduct(config, headers)
  const biz = {
    out_trade_no: alipayOutTradeNo(order.id),
    total_amount: alipayAmount(order),
    // subject 上限 256 字节，换行会让收银台标题串行，所以先折叠空白再按字节裁。
    subject: alipayBytes(String(artifact?.name || order.sku || '订单').replace(/\s+/g, ' ').trim(), 128),
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
    const params = alipayRequestParams({ order, artifact, siteUrl, config, headers })
    const checkoutUrl = alipayCheckoutUrl(params, env(config.private_key_env || 'ALIPAY_PRIVATE_KEY'), alipayGateway(config))
    // 买家付款之前，支付宝侧不存在任何单号，所以这里回的是商户订单号——它同时是支付宝后台「商户订单号」
    // 那一栏能搜到的值，出问题时有个东西可查。通知到达后会被换成 trade_no（支付宝自己的交易号）。
    return { checkoutUrl, providerOrderId: params.biz_content ? alipayOutTradeNo(order.id) : null }
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
    const orderId = alipayOrderId(body.out_trade_no)
    if (!orderId) return { ack, reject: { status: 400, error: 'Alipay callback carries no out_trade_no' } }
    const total = Number(body.total_amount)
    return {
      orderId,
      // TRADE_FINISHED 是「交易结束、不可退款」，钱早就到账了，不是失败。WAIT_BUYER_PAY 两个都不是，
      // 订单留在 pending，等 timeout_express 到点后的 TRADE_CLOSED 来收尾。
      paid: status === 'TRADE_SUCCESS' || status === 'TRADE_FINISHED',
      failed: status === 'TRADE_CLOSED',
      providerOrderId: body.trade_no ? String(body.trade_no) : alipayOutTradeNo(orderId),
      // total_amount 是这笔交易的订单总额（元）。少付一分就不放货：handler 会拿它跟订单行比。
      expect: Number.isFinite(total) && total > 0 ? { amountMinor: Math.round(total * 100), currency: 'CNY' } : null,
      payload: body,
      ack
    }
  }
}

export const DRIVERS = { stripe, paypal, payerurl, alipay }
export const driverFor = (config) => DRIVERS[String(config?.driver || '').toLowerCase()] || null
