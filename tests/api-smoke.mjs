import handler from '../api/github-progress.mjs'
import usersHandler, { isBanned } from '../api/admin-users.mjs'
import {
  DRIVERS,
  approvalLink,
  decimalAmount,
  driverFor,
  orderUrl,
  payerurlAuth,
  payerurlPaymentArgs,
  payerurlQuery,
  payerurlSign,
  payerurlSignedFields,
  paypalOrderBody,
  stripeSessionForm
} from '../api/_lib/payments.mjs'
import {
  SCHEMA,
  defaultRecord,
  fieldHint,
  fromForm,
  rowMeta,
  toForm,
  toLocalInput
} from '../docs/.vitepress/theme/recordForm.ts'
import { preloadMarkdown, renderMarkdown, renderMarkdownInline } from '../docs/.vitepress/theme/markdown.ts'
import cancelHandler, { cancelPendingOrder } from '../api/cancel-order.mjs'
import { orderPath } from '../docs/.vitepress/theme/routes.ts'
import telemetryHandler from '../api/telemetry.mjs'
import {
  exportOrders, listOrders, maskEmail, orderDetail, toCsv, updateOrderStatus
} from '../api/admin-orders.mjs'
import {
  LICENSE_STATUS,
  RUNNING_WINDOW_MS,
  mergeSample,
  parseSample,
  summarise
} from '../api/_lib/telemetry.mjs'
import { readFileSync } from 'node:fs'
import {
  EDITOR_GROUPS,
  GROUP_LABEL,
  GROUP_ORDER,
  GROUP_RANK,
  RANK,
  isEditor,
  rankOf
} from '../shared/groups.mjs'
import {
  ACTION_TYPES,
  AMOUNT_OPERATORS,
  CONDITION_TYPES,
  SKU_OPERATORS,
  applyActions,
  checkAvailability,
  describeAction,
  describeCondition,
  evaluateCondition,
  evaluateConditions,
  formatMinor,
  quote,
  validateAction,
  validateCondition,
  validateCoupon
} from '../shared/coupons.mjs'
// 两个模块都有 ACTION_TYPES 和 validateAction，含义完全不同（券的动作是改金额，站内信的动作是按钮），
// 所以在这里起别名而不是在任一模块里改名——改名会让各自文件里的命名变得别扭。
import {
  ACTION_ENDPOINT,
  ADMIN_ONLY_ACTIONS,
  ACTION_TYPES as NOTIF_ACTION_TYPES,
  KIND_LABEL,
  NOTIFICATION_KINDS,
  NOTIFICATION_SCOPES,
  NOTIFICATION_SCOPE_RANK,
  broadcastScopesFor,
  canSeeNotification,
  canUseAction,
  needsConfirm,
  needsReason,
  orderHref,
  presentationFor,
  refundApprovalNotification,
  refundDoneNotification,
  refundEscalationNotification,
  validateAction as validateNotifAction,
  validateNotification
} from '../shared/notifications.mjs'
import {
  ORDER_STATUSES,
  ORDER_STATUS_LABEL,
  ORDER_TRANSITIONS,
  REFUND_APPROVER_GROUPS,
  REFUND_INITIATOR_ROLES,
  REFUND_PROXY_GROUPS,
  REFUND_STATUSES,
  REFUND_STATUS_LABEL,
  REFUND_TRANSITIONS,
  TERMINAL_ORDER_STATUSES,
  assertRefundTransition,
  assertTransition,
  canRefundTransition,
  canRequestRefund,
  canTransition,
  rejectionLogEntry,
  transitionLabel,
  validateRefundAmount
} from '../shared/orders.mjs'
import {
  insertNotification,
  logOrderStatus,
  logRefundAction,
  logSessionEvent,
  notifyUser,
  setting,
  settleApproval
} from '../api/_lib/notify.mjs'
import { orderNoOf, requestRefund } from '../api/refund-request.mjs'
import { approveRefund } from '../api/refund-approve.mjs'
import { rejectRefund } from '../api/refund-reject.mjs'
import { transferRefund } from '../api/refund-transfer.mjs'
import { executeRefund } from '../api/refund-execute.mjs'
import {
  archiveNotifications, inboxSettings, listNotifications, markRead, unreadCount
} from '../api/notifications.mjs'
// 从 server.mjs 转发出来的同一份表：断言转发没断，因为大部分调用方是从这里 import 的。
import { GROUP_RANK as API_RANK, requireUser } from '../api/_lib/server.mjs'
import syncHandler, { loginOf, resolveGroup } from '../api/sync-github-groups.mjs'

const originalRepository = process.env.GITHUB_REPOSITORY
const originalToken = process.env.GITHUB_TOKEN
delete process.env.GITHUB_REPOSITORY
delete process.env.GITHUB_TOKEN

let statusCode = 0
let body = null
const response = {
  status(code) { statusCode = code },
  setHeader() {},
  send(value) { body = JSON.parse(value) }
}

await handler({}, response)

if (statusCode !== 200 || body?.configured !== false) {
  throw new Error('Unconfigured GitHub endpoint must return a safe 200 fallback')
}

if (originalRepository) process.env.GITHUB_REPOSITORY = originalRepository
if (originalToken) process.env.GITHUB_TOKEN = originalToken

console.log('GitHub progress API fallback: OK')

let userStatus = 0
let userBody = null
const userResponse = {
  status(code) { userStatus = code },
  setHeader() {},
  send(value) { userBody = JSON.parse(value) }
}

await usersHandler({ method: 'GET', headers: {} }, userResponse)

if (userStatus !== 401 || !userBody?.error) {
  throw new Error('User management endpoint must reject unauthenticated requests')
}

console.log('Admin users API auth guard: OK')

const hour = 3600 * 1000
const banCases = [
  [null, false],
  [undefined, false],
  ['infinity', true],
  [new Date(Date.now() + hour).toISOString(), true],
  [new Date(Date.now() - hour).toISOString(), false]
]

for (const [value, expected] of banCases) {
  if (isBanned(value) !== expected) {
    throw new Error(`banned_until ${String(value)} must read as ${expected ? 'banned' : 'active'}`)
  }
}

console.log('Ban state derivation: OK')

// The /admin editor only counts as "ordinary fields" if these conversions are lossless: a DB row
// must survive row -> inputs -> upsert payload without changing type or losing columns.
const assert = (ok, what) => { if (!ok) throw new Error(what) }

const postRow = {
  id: '11111111-2222-3333-4444-555555555555',
  created_at: '2026-01-01T00:00:00.000Z',
  kind: 'news',
  status: 'published',
  title: '标题',
  slug: 'release-0-1-0',
  cover_url: null,
  tags: ['anticheat', 'release'],
  published_at: '2026-08-28T10:30:00.000Z',
  featured: true,
  summary: '摘要',
  body: '# 正文'
}

const postDraft = toForm(SCHEMA.posts, postRow)
assert(postDraft.tags === 'anticheat, release', 'text[] must render as comma-separated text')
assert(postDraft.cover_url === '', 'a null text column must render as an empty input, not the string "null"')
assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(postDraft.published_at), 'timestamptz must render as datetime-local')
assert(postDraft.featured === true, 'boolean must stay boolean so the checkbox binds')

const postPayload = fromForm(SCHEMA.posts, postDraft)
assert(Array.isArray(postPayload.tags) && postPayload.tags.length === 2, 'comma text must convert back to text[]')
assert(postPayload.cover_url === null, 'a blank nullable column must be written as null, never as ""')
assert(postPayload.published_at === postRow.published_at, `published_at must survive the round trip, got ${postPayload.published_at}`)
assert(
  postPayload.id === postRow.id && postPayload.created_at === postRow.created_at,
  'columns without a field must pass through, otherwise upsert inserts a duplicate instead of updating'
)

const blankDate = fromForm(SCHEMA.posts, { ...postDraft, published_at: '' })
assert(!('published_at' in blankDate), 'a blank datetime must drop the key so the not-null default now() applies')
assert(toLocalInput(null) === '' && toLocalInput('not a date') === '', 'an unparseable timestamp must leave the datetime input empty')

const artifactRow = {
  sku: 'AETHER-STARTER',
  name: '入门版',
  description: '',
  price_minor: 1999,
  currency: 'USD',
  active: true,
  metadata: { seats: 1 }
}

const artifactDraft = toForm(SCHEMA.artifacts, artifactRow)
assert(artifactDraft.metadata === JSON.stringify({ seats: 1 }, null, 2), 'jsonb must render as pretty JSON')
assert(artifactDraft.price_minor === 1999, 'integer columns must stay numbers')
assert(toForm(SCHEMA.artifacts, { metadata: null }).metadata === '{}', 'a null jsonb column must render as {} rather than "null"')

const artifactPayload = fromForm(SCHEMA.artifacts, artifactDraft)
assert(artifactPayload.metadata.seats === 1, 'pretty JSON must parse back into a jsonb object')
assert(artifactPayload.price_minor === 1999, 'the number input must not stringify the price')

let jsonError = null
try { fromForm(SCHEMA.artifacts, { ...artifactDraft, metadata: '{oops' }) } catch (error) { jsonError = error }
assert(jsonError?.message?.includes('附加元数据'), 'a JSON parse failure must name the field it came from')

const providerDraft = toForm(SCHEMA.payment_providers, defaultRecord('payment_providers'))
providerDraft.secret_env_names = ' ALIPAY_KEY , , ALIPAY_SECRET '
const providerPayload = fromForm(SCHEMA.payment_providers, providerDraft)
assert(providerPayload.secret_env_names.join('|') === 'ALIPAY_KEY|ALIPAY_SECRET', 'tag input must trim entries and drop empty ones')

const pkField = SCHEMA.payment_providers.find((f) => f.key === 'id')
assert(fieldHint(pkField, providerDraft, false).includes('主键不可修改'), 'editing an existing primary key must be warned about, since upsert would insert a new row')
assert(fieldHint(pkField, providerDraft, true) === pkField.hint, 'a brand-new record must still explain what the primary key does')
assert(fieldHint(SCHEMA.artifacts.find((f) => f.key === 'price_minor'), artifactDraft, false).includes('19.99 USD'), 'the price hint must show the human-readable amount')

assert(rowMeta('posts', postRow) === 'news · published · release-0-1-0', 'post rows must be identifiable in the list')
assert(rowMeta('artifacts', artifactRow) === 'AETHER-STARTER · 19.99 USD', 'artifact rows must show the formatted price')
assert(rowMeta('progress_entries', { stage: '00', status: 'active', percent: 40 }) === '阶段 00 · active · 40%', 'progress rows must show stage and percent')

for (const table of Object.keys(SCHEMA)) {
  const payload = fromForm(SCHEMA[table], toForm(SCHEMA[table], defaultRecord(table)))
  for (const field of SCHEMA[table]) {
    if (field.type === 'datetime') continue
    assert(field.key in payload, `${table}.${field.key} must be present in the payload built from its default record`)
  }
  // Every input must explain itself: an unlabelled box is the thing this editor exists to remove.
  for (const field of SCHEMA[table]) {
    assert(typeof field.hint === 'string' && field.hint.length >= 8, `${table}.${field.key} needs a hint describing what the value does`)
    assert(fieldHint(field, payload, true), `${table}.${field.key} must render a description under the input`)
  }
}

console.log('Record form conversions: OK')

// The three built-in drivers post shapes the generic create_url path cannot express, so the request
// bodies are asserted directly: a wrong key name here is a payment that silently never happens.
const order = {
  id: 'a1b2c3d4-0000-4000-8000-000000000001',
  sku: 'AETHER-STARTER',
  quantity: 1,
  amount_minor: 1999,
  currency: 'USD'
}
const artifact = { name: '入门版', description: '单机授权' }
const site = 'https://aetherac.abnt.it'

// The order route. VitePress resolves routes against a build-time hash map of its .md files, so an id in
// the path — `/order/<uuid>` — has no entry and the client router replaces the page with its own 404 the
// instant JS boots. That is what buyers hit returning from a completed payment: a 404 over money already
// paid. A server rewrite cannot fix it, because it only corrects the HTML that the router then throws
// away. These assertions pin the query form on both halves, and pin them to each other: the browser
// builds the link, payments.mjs builds the providers' return_url, and a fix applied to one only is the
// exact way this breaks again.
assert(orderPath('abc') === '/order?order_id=abc', 'the id must be a query parameter — as a path segment the client router 404s')
assert(!/\/order\/[^?]/.test(orderUrl(site, 'abc')), 'the id must never appear as a path segment')
assert(orderUrl(site, 'abc') === site + orderPath('abc'), 'client and server must build the same order URL')
assert(orderUrl(site, 'abc', true) === `${site}/order?order_id=abc&paid=1`, 'the paid flag is what starts the callback poll, so it must survive')
assert(orderPath('a b&c=d') === '/order?order_id=a%20b%26c%3Dd' && orderUrl(site, 'a b&c=d') === site + orderPath('a b&c=d'),
  'an id is encoded, so a stray & cannot inject another parameter')

const stripeForm = stripeSessionForm(order, artifact, site)
assert(stripeForm instanceof URLSearchParams, 'Stripe only accepts application/x-www-form-urlencoded')
assert(stripeForm.get('line_items[0][price_data][unit_amount]') === '1999', 'unit_amount must stay the minor unit the artifacts table stores')
assert(stripeForm.get('line_items[0][price_data][currency]') === 'usd', 'Stripe rejects an upper-case currency')
assert(stripeForm.get('line_items[0][price_data][product_data][name]') === '入门版', 'the buyer must see the artifact name, not the SKU')
assert(stripeForm.get('client_reference_id') === order.id && stripeForm.get('metadata[order_id]') === order.id, 'the callback finds our order through client_reference_id / metadata')
assert(stripeForm.get('success_url') === `${site}/order?order_id=${order.id}&paid=1`, 'success_url must return to the order page')
assert(!stripeSessionForm(order, { name: 'x', description: '' }, site).has('line_items[0][price_data][product_data][description]'), 'Stripe rejects an empty description, so a blank one must be omitted')
assert(stripeSessionForm(order, null, site).get('line_items[0][price_data][product_data][name]') === order.sku, 'a missing artifact must fall back to the SKU rather than sending "undefined"')

const paypalBody = paypalOrderBody(order, artifact, site)
assert(paypalBody.intent === 'CAPTURE', 'the order must be capturable, otherwise the money never moves')
assert(paypalBody.purchase_units[0].amount.value === '19.99', 'PayPal wants a decimal string, not the minor unit')
assert(paypalBody.purchase_units[0].amount.currency_code === 'USD', 'PayPal rejects a lower-case currency code')
assert(paypalBody.purchase_units[0].custom_id === order.id, 'custom_id is how the webhook maps a PayPal order back to ours')
assert(paypalBody.payment_source.paypal.experience_context.return_url === `${site}/order?order_id=${order.id}&paid=1`, 'the buyer must land back on the order page')

assert(decimalAmount(1999, 'USD') === '19.99', 'two-decimal currencies divide by 100')
assert(decimalAmount(1999, 'JPY') === '1999', 'JPY is already whole; dividing it would undercharge by 100x')
assert(decimalAmount(1999, 'jpy') === '1999', 'the zero-decimal check must not depend on letter case')
assert(decimalAmount(0, 'USD') === '0.00', 'a free artifact must still form a valid amount')

assert(approvalLink([{ rel: 'self', href: 'a' }, { rel: 'payer-action', href: 'b' }]) === 'b', 'the buyer is sent to the payer-action link')
assert(approvalLink([{ rel: 'approve', href: 'c' }]) === 'c', 'older PayPal responses name that link approve')
assert(approvalLink([{ rel: 'self', href: 'a' }]) === null && approvalLink(undefined) === null, 'a missing approval link must be detectable, not returned as undefined')

// PayerURL signs a canonical copy of the parameters rather than the bytes on the wire. Every string
// below was produced by running the official SDK's own buildQueryString over the same input
// (binance-crypto-instant-payout-nodejs@1.0.0, dist/index.js) and pasting what it returned. They are
// pinned rather than derived so that drifting from the SDK fails the build instead of a live payment.
assert(payerurlQuery({ b: '1', a: '2' }) === 'a=2&b=1', 'only the top-level keys are sorted before signing')
assert(payerurlQuery({ items: [{ name: 'x', qty: 1 }] }) === 'items%5B0%5D%5Bname%5D=x&items%5B0%5D%5Bqty%5D=1', 'nested items become bracketed keys and keep their own order')
assert(payerurlQuery({ a: 'x y' }) === 'a=x+y', 'a space is folded to + rather than left as %20')
assert(payerurlQuery({ a: "~!*'()" }) === "a=~!*'()", 'encodeURIComponent leaves these alone — escaping them like PHP urlencode() would break the digest')
assert(payerurlQuery({ a: '1', b: null, c: undefined }) === 'a=1', 'null and undefined are dropped instead of sent empty')
assert(payerurlQuery({ a: '入门版' }) === 'a=%E5%85%A5%E9%97%A8%E7%89%88', 'a non-ASCII value is UTF-8 percent-encoded')

const payerurlArgs = payerurlPaymentArgs({ order, artifact: { name: '入门版 Starter' }, siteUrl: site, user: { email: 'buyer@example.com' } })
assert(payerurlArgs.order_id === order.id, 'the callback maps back to our order through order_id')
// Measured against the live checkout, not taken from the SDK README: sending the minor unit here
// billed a 20.00 USD order as 2000 USD. The README says "smallest unit" and is wrong about its own
// server, so this asserts what the server actually charges.
assert(payerurlArgs.amount === '19.99', 'amount is a decimal — the minor unit here overcharges by 100x')
assert(payerurlArgs.currency === 'usd', 'PayerURL lower-cases the currency')
assert(payerurlArgs.items[0].price === '19.99', "an item's price is a decimal too, and must agree with the total")
assert(
  payerurlPaymentArgs({ order: { ...order, amount_minor: 1999, currency: 'JPY' }, artifact, siteUrl: site, user: {} }).amount === '1999',
  'a zero-decimal currency must not be divided by 100'
)
assert(
  payerurlPaymentArgs({ order: { ...order, amount_minor: 2000, quantity: 3 }, artifact, siteUrl: site, user: {} }).items[0].price === '6.67',
  'a per-unit price that does not divide evenly must still be a valid decimal'
)
assert(payerurlArgs.items[0].name === '入门版_Starter', 'a space in an item name becomes an underscore')
assert(payerurlArgs.type === 'nodejs', 'the SDK identifies itself as nodejs')
// The whole request, byte for byte as the SDK builds it.
assert(
  payerurlQuery(payerurlArgs) === 'amount=19.99&billing_email=buyer%40example.com&billing_fname=buyer&billing_lname=buyer'
    + '&cancel_url=https%3A%2F%2Faetherac.abnt.it%2Forder%3Forder_id%3Da1b2c3d4-0000-4000-8000-000000000001&currency=usd'
    + '&items%5B0%5D%5Bname%5D=%E5%85%A5%E9%97%A8%E7%89%88_Starter&items%5B0%5D%5Bqty%5D=1&items%5B0%5D%5Bprice%5D=19.99'
    + '&notify_url=https%3A%2F%2Faetherac.abnt.it%2Fv1%2Fcallback%2Fpayerurl&order_id=a1b2c3d4-0000-4000-8000-000000000001'
    + '&redirect_to=https%3A%2F%2Faetherac.abnt.it%2Forder%3Forder_id%3Da1b2c3d4-0000-4000-8000-000000000001%26paid%3D1&type=nodejs',
  'the signed payment request must match the SDK byte for byte'
)
assert(payerurlArgs.notify_url === `${site}/v1/callback/payerurl`, 'the callback must reach our own endpoint')
assert(payerurlArgs.billing_email === 'buyer@example.com' && payerurlArgs.billing_fname && payerurlArgs.billing_lname, 'PayerURL refuses an order without a complete billing identity')

process.env.PAYERURL_PUBLIC_KEY = 'pk_smoke_public'
process.env.PAYERURL_SECRET_KEY = 'sk_smoke_secret'
// A callback is signed over the ten-field whitelist only, so the test signs the same way the merchant
// server does rather than over the whole body.
const sign = (data) => payerurlAuth(payerurlSignedFields(data), process.env.PAYERURL_PUBLIC_KEY, process.env.PAYERURL_SECRET_KEY)
const callback = {
  order_id: order.id,
  transaction_id: 'tx_smoke_1',
  status_code: '200',
  note: 'ok note',
  confirm_rcv_amnt: '19.99',
  confirm_rcv_amnt_curr: 'USD',
  coin_rcv_amnt: '19.99',
  coin_rcv_amnt_curr: 'USDT',
  txn_time: '2026-08-29 10:00:00',
  // Not in the whitelist: present to prove it is excluded from the digest.
  status: 'paid'
}
const signed = sign(callback)

// Pinned from the SDK's own signPayload over the same whitelist with the same key.
assert(
  payerurlSign(payerurlSignedFields(callback), 'sk_smoke_secret') === '20357731ad2f22022486f0a66d6ba9dbd774ec87b305601a90a64fbbe3e11a3a',
  'the callback digest must match the one the SDK computes'
)

const viaBody = await DRIVERS.payerurl.verify({ payload: { ...callback, authStr: signed }, headers: {}, config: {} })
assert(viaBody.paid === true && viaBody.orderId === order.id, 'a correctly signed callback in the authStr field must be accepted')
assert(viaBody.expect.amountMinor === 1999, 'the received amount is compared against the order in minor units')
assert(viaBody.expect.currency === null, 'no currency is claimed: confirm_rcv_amnt_curr may be a coin ticker, and guessing would 409 a real payment')
assert(viaBody.response.status === 2040, "a settled callback is answered with PayerURL's own success code")
const viaHeader = await DRIVERS.payerurl.verify({ payload: callback, headers: { authorization: `Bearer ${signed}` }, config: {} })
assert(viaHeader.paid === true, 'the same token in the Authorization header must verify identically')
// authStr transports the token being checked, so it cannot be part of what was signed.
assert((await DRIVERS.payerurl.verify({ payload: { ...callback, authStr: signed }, headers: { authorization: `Bearer ${signed}` }, config: {} })).paid === true, 'the token must verify whether it arrives in the header, the body, or both')
const unlisted = await DRIVERS.payerurl.verify({ payload: { ...callback, status: 'anything', extra_field: 'added later', authStr: signed }, headers: {}, config: {} })
assert(unlisted.paid === true, 'a field outside the ten signed ones must not enter the digest, or a new PayerURL field would break every callback')
const tampered = await DRIVERS.payerurl.verify({ payload: { ...callback, confirm_rcv_amnt: '0.01', authStr: signed }, headers: {}, config: {} })
assert(tampered.reject?.status === 401 && tampered.reject.response.status === 2030, 'editing any signed field must fail the digest, not lower the price')
const unsigned = await DRIVERS.payerurl.verify({ payload: callback, headers: {}, config: {} })
assert(unsigned.reject?.status === 401 && unsigned.reject.response.status === 2030, 'a callback carrying no token at all must be refused')
const foreignKey = await DRIVERS.payerurl.verify({ payload: { ...callback, authStr: payerurlAuth(payerurlSignedFields(callback), 'pk_someone_else', 'sk_smoke_secret') }, headers: {}, config: {} })
assert(foreignKey.reject?.status === 401, "another merchant's public key must be refused even when the digest itself is well formed")
// status_code is one of the signed fields, so it can only be read after the signature has been checked.
const settling = { ...callback, status_code: '100' }
const unsettled = await DRIVERS.payerurl.verify({ payload: { ...settling, authStr: sign(settling) }, headers: {}, config: {} })
assert(unsettled.paid === false && unsettled.failed === false, 'a crypto payment still confirming must stay pending, not be guessed as failed')
assert(unsettled.response.status === 2050, 'an unsettled callback is answered with 2050, the code the SDK uses for "Order not complete"')
const cancelled = { ...callback, status_code: '20000' }
const abandoned = await DRIVERS.payerurl.verify({ payload: { ...cancelled, authStr: sign(cancelled) }, headers: {}, config: {} })
assert(abandoned.failed === true && abandoned.paid === false && abandoned.response.status === 20000, 'a cancelled order must be marked failed rather than left pending forever')
const noTxn = { ...callback, transaction_id: '' }
const missingTxn = await DRIVERS.payerurl.verify({ payload: { ...noTxn, authStr: sign(noTxn) }, headers: {}, config: {} })
assert(missingTxn.reject?.response.status === 2050, 'a callback without a transaction id cannot be reconciled and must be refused')

assert(driverFor({ driver: 'stripe' }) === DRIVERS.stripe && driverFor({ driver: 'PayPal' }) === DRIVERS.paypal, 'the driver name in public_config must resolve case-insensitively')
assert(driverFor({}) === null && driverFor(null) === null && driverFor({ driver: 'alipay' }) === null, 'the remaining eight providers must keep using the generic create_url path')
for (const [name, driver] of Object.entries(DRIVERS)) {
  assert(typeof driver.create === 'function' && typeof driver.verify === 'function', `${name} driver must be able to create a checkout and verify a callback`)
}

console.log('Payment drivers: OK')

// CMS Markdown. These strings go through v-html, so the escaping and the link policy are the two
// things that must not regress; the newline behaviour is the bug users actually reported.

// First, the fallback that is on screen before the renderer chunk arrives — and for the whole page
// load if it never does. It has to be exactly as safe as the real thing, and it has to keep line
// breaks, or the reported bug comes back during the gap.
assert(renderMarkdown('第一行\n第二行') === '第一行<br>\n第二行', 'the fallback keeps line breaks')
assert(renderMarkdown('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;',
  'the fallback escapes HTML — it must not be a hole that opens for a few milliseconds on every load')
assert(renderMarkdownInline('**粗**') === '**粗**', 'the fallback leaves syntax literal rather than dropping text')
assert(renderMarkdown('') === '' && renderMarkdown(null) === '', 'the fallback renders nothing for empty input')

// A single call, awaited once: every assertion below runs against the real renderer.
await preloadMarkdown()

assert(renderMarkdown('第一行\n第二行') === '<p>第一行<br>\n第二行</p>\n',
  'a single newline must become <br> — an author typing two lines in a textarea means two lines')
assert(renderMarkdown('上\n\n下') === '<p>上</p>\n<p>下</p>\n', 'a blank line still separates paragraphs')
assert(renderMarkdown('**粗** 和 `代码`').includes('<strong>粗</strong>')
  && renderMarkdown('**粗** 和 `代码`').includes('<code>代码</code>'), 'basic emphasis and code spans must render')
assert(renderMarkdown('## 小标题').trim() === '<h2>小标题</h2>', 'the syntax /admin advertises for posts.body must work')
assert(renderMarkdown('- 甲\n- 乙').includes('<li>甲</li>'), 'list items must render as a real list')

// html:false — a description is not a place to inject markup.
assert(renderMarkdown('<script>alert(1)</script>').includes('&lt;script&gt;')
  && !renderMarkdown('<script>alert(1)</script>').includes('<script>'), 'raw HTML must be escaped, not executed')
assert(renderMarkdown('<img src=x onerror=alert(1)>').includes('&lt;img'), 'an inline HTML tag must be escaped too')

// validateLink allowlist: only web, mail and same-origin targets survive.
assert(renderMarkdown('[x](https://example.com)').includes('href="https://example.com"'), 'https links must be kept')
assert(renderMarkdown('[x](/buy)').includes('href="/buy"'), 'site-relative links must be kept')
assert(renderMarkdown('[x](mailto:a@b.c)').includes('href="mailto:a@b.c"'), 'mailto links must be kept')
assert(!renderMarkdown('[x](javascript:alert(1))').includes('href='), 'a javascript: URL must not survive as a link')
assert(!renderMarkdown('[x](data:text/html;base64,PHN2Zz4=)').includes('href='), 'a data: URL must not survive as a link')
const external = renderMarkdown('[x](https://example.com)')
assert(external.includes('target="_blank"') && external.includes('rel="noopener noreferrer"'),
  'off-site links open in a new tab and must not hand over window.opener')
assert(!renderMarkdown('[x](/buy)').includes('target='), 'a same-site link must stay in the current tab')

// Inline renderer: the fixed-height cards on / and /buy must not be handed block elements.
assert(renderMarkdownInline('**粗**') === '<strong>粗</strong>', 'inline rendering must not wrap text in <p>')
assert(!renderMarkdownInline('## 标题').includes('<h2'), 'a heading must stay literal inside a fixed-height card')
assert(renderMarkdownInline('<script>x</script>').includes('&lt;script&gt;'), 'the inline renderer escapes HTML as well')

assert(renderMarkdown('') === '' && renderMarkdown(null) === '' && renderMarkdown(undefined) === ''
  && renderMarkdownInline(null) === '', 'an empty or absent description must render nothing, not "null"')

console.log('CMS Markdown: OK')

// Order cancellation. This route runs on the service client, which bypasses RLS — so the filters on
// the update are the entire authorization check. Losing one would let any buyer cancel anyone's order,
// or cancel an order that has already been paid. A recording fake asserts they are all still there.
const fakeDb = (updateResult, selectResult) => {
  const calls = { update: null, updateFilters: {}, selectFilters: {}, selected: null }
  const chain = (bucket, result) => {
    const link = {
      eq(column, value) { bucket[column] = value; return link },
      select(columns) { calls.selected = columns ?? '*'; return link },
      maybeSingle: async () => result
    }
    return link
  }
  return {
    calls,
    from(table) {
      assert(table === 'orders', 'cancellation must only ever touch the orders table')
      return {
        update(patch) { calls.update = patch; return chain(calls.updateFilters, updateResult) },
        select(columns) { calls.selected = columns; return chain(calls.selectFilters, selectResult) }
      }
    }
  }
}
const OWNER = '11111111-1111-4111-8111-111111111111'
const ORDER = '22222222-2222-4222-8222-222222222222'

let db = fakeDb({ data: { id: ORDER, status: 'cancelled' } }, { data: null })
let result = await cancelPendingOrder(db, OWNER, ORDER)
assert(result.status === 200 && result.body.order.status === 'cancelled', 'cancelling a pending order succeeds')
assert(db.calls.updateFilters.id === ORDER, 'the update must target the requested order')
assert(db.calls.updateFilters.user_id === OWNER, 'the update must be scoped to the caller — this is the ownership check')
assert(db.calls.updateFilters.status === 'pending', 'the update must require the order to still be pending')
assert(db.calls.update.status === 'cancelled' && db.calls.update.checkout_url === null,
  'cancelling clears checkout_url so a stale hosted payment page is no longer offered')
assert(Object.keys(db.calls.update).length === 2, 'nothing but status and checkout_url may be written')

// Nothing updated because the row belongs to someone else, or does not exist.
db = fakeDb({ data: null }, { data: null })
result = await cancelPendingOrder(db, OWNER, ORDER)
assert(result.status === 404, 'an order that is not the caller\'s answers 404')
assert(db.calls.selectFilters.user_id === OWNER,
  'the follow-up lookup stays scoped to the caller — probing must not distinguish a real order from a missing one')

// Nothing updated because the status moved on. Cancelling a paid order would strand the buyer's money.
for (const status of ['paid', 'cancelled', 'refunded', 'failed', 'refund_pending']) {
  const guard = fakeDb({ data: null }, { data: { id: ORDER, status } })
  const answer = await cancelPendingOrder(guard, OWNER, ORDER)
  assert(answer.status === 409 && answer.body.error.includes(status), `a ${status} order cannot be cancelled`)
}

for (const bad of ['', null, undefined, 'not-a-uuid', '22222222-2222-4222-8222', "' or 1=1--"]) {
  const answer = await cancelPendingOrder(fakeDb({ data: null }, { data: null }), OWNER, bad)
  assert(answer.status === 400, `a malformed order_id (${JSON.stringify(bad)}) answers 400, not 500`)
}

let cancelStatus = 0
let cancelBody = null
const cancelResponse = { status(code) { cancelStatus = code }, setHeader() {}, send(value) { cancelBody = JSON.parse(value) } }
await cancelHandler({ method: 'GET', headers: {} }, cancelResponse)
assert(cancelStatus === 405, 'cancellation must be POST-only')
await cancelHandler({ method: 'POST', headers: {} }, cancelResponse)
assert(cancelStatus === 401 && cancelBody?.error, 'cancellation must reject an unauthenticated request')

console.log('Order cancellation: OK')

// --- Telemetry samples ---------------------------------------------------------------------------
// The wire format is the contract between the plugin and the database, and both halves are far away
// from these tests, so what is checked here is that a sample is either accepted whole or rejected
// whole, that counters accumulate across restarts, and that the endpoint's guards run before any
// database work — a sample that got half-stored would be counted in 装机量 while describing nothing.
const HW = 'a'.repeat(64)
const goodSample = { hwid: HW, mcver: '1.21.4', loader: 'paper', modver: '2.6.0', licensestatus: 'active' }

assert(parseSample(goodSample).sample?.hwid === HW, 'a minimal valid sample is accepted')
assert(parseSample({ ...goodSample, hwid: HW.toUpperCase() }).sample?.hwid === HW, 'hwid is normalised to lower case')
assert(parseSample({ ...goodSample, licensestatus: 'ACTIVE' }).sample?.licensestatus === 'active', 'licensestatus is case-insensitive')

for (const bad of [null, undefined, 'string', 42, []]) {
  assert(parseSample(bad).error, `a ${JSON.stringify(bad)} body is rejected`)
}
for (const bad of ['', 'short', HW.slice(1), HW + 'a', 'z'.repeat(64), `${HW.slice(0, 63)}!`]) {
  assert(parseSample({ ...goodSample, hwid: bad }).error, `hwid ${JSON.stringify(bad)} is rejected`)
}
for (const key of ['mcver', 'loader', 'modver']) {
  assert(parseSample({ ...goodSample, [key]: '' }).error, `${key} cannot be empty`)
  assert(parseSample({ ...goodSample, [key]: '   ' }).error, `${key} cannot be whitespace`)
  assert(parseSample({ ...goodSample, [key]: undefined }).error, `${key} cannot be absent`)
  assert(parseSample({ ...goodSample, [key]: 'x'.repeat(300) }).error, `an oversized ${key} is rejected`)
}
assert(parseSample({ ...goodSample, licensestatus: 'lapsed' }).error, 'an unknown licensestatus is rejected')
assert(parseSample({ ...goodSample, licensestatus: '' }).error, 'a missing licensestatus is rejected')
// unknown must stay separate from invalid: conflating them would make a network outage to the licence
// server read as a customer's licence being revoked.
assert(LICENSE_STATUS.includes('unknown') && LICENSE_STATUS.includes('invalid'), 'unknown and invalid are distinct statuses')

// Optional fields: absent and empty both mean "this install did not say", and only a present-and-wrong
// value is an error.
const bare = parseSample(goodSample).sample
assert(bare.os === '' && bare.osver === '' && bare.osarch === '', 'absent optional descriptors store as empty')
assert(bare.licensecode === null, 'an unreported licencecode stores as null, not empty string')
assert(parseSample({ ...goodSample, licensecode: '' }).sample.licensecode === null, 'a blank licencecode stores as null')
assert(parseSample({ ...goodSample, licensecode: 'AAA-BBB' }).sample.licensecode === 'AAA-BBB', 'a reported licencecode is kept')
assert(parseSample({ ...goodSample, licensecode: 42 }).error, 'a non-string licencecode is rejected')
assert(parseSample({ ...goodSample, licensecode: 'x'.repeat(200) }).error, 'an oversized licencecode is rejected')
assert(parseSample({ ...goodSample, osarch: 'x'.repeat(40) }).error, 'an oversized osarch is rejected')
assert(parseSample({ ...goodSample, retry_license_after: 'soon' }).error, 'a non-timestamp retry_license_after is rejected')
assert(
  parseSample({ ...goodSample, retry_license_after: '2026-09-01T00:00:00Z' }).sample.retry_license_after === '2026-09-01T00:00:00.000Z',
  'retry_license_after is normalised to ISO 8601'
)
assert(parseSample({ ...goodSample, retry_license_after: '' }).sample.retry_license_after === null, 'a blank retry_license_after stores as null')

// Counters arrive as deltas, so they must be non-negative integers and bounded — an install cannot
// have crashed a billion times since its last heartbeat, and a figure that large is a bug or an attack.
for (const key of ['errors', 'crashes', 'warns']) {
  assert(parseSample(goodSample).sample[key] === 0, `${key} defaults to 0`)
  assert(parseSample({ ...goodSample, [key]: 3 }).sample[key] === 3, `${key} is carried through`)
  assert(parseSample({ ...goodSample, [key]: -1 }).error, `a negative ${key} is rejected`)
  assert(parseSample({ ...goodSample, [key]: 1.5 }).error, `a fractional ${key} is rejected`)
  assert(parseSample({ ...goodSample, [key]: '3' }).error, `a string ${key} is rejected`)
  assert(parseSample({ ...goodSample, [key]: 9e9 }).error, `an absurd ${key} is rejected`)
}

// mergeSample: descriptors overwrite, counters add. A client that restarts has forgotten its own
// tallies, which is exactly why the total is kept server-side.
const first = mergeSample(null, parseSample({ ...goodSample, errors: 2 }).sample, new Date('2026-08-01T00:00:00Z'))
assert(first.samples === 1 && first.errors === 2, 'a first sample starts the tallies')
assert(first.first_seen === '2026-08-01T00:00:00.000Z' && first.last_seen === first.first_seen, 'a first sample sets both timestamps')
const second = mergeSample(first, parseSample({ ...goodSample, modver: '2.7.0', errors: 3, crashes: 1 }).sample, new Date('2026-08-02T00:00:00Z'))
assert(second.errors === 5 && second.crashes === 1, 'counters accumulate across samples')
assert(second.modver === '2.7.0', 'a descriptor is overwritten by the newest sample')
assert(second.first_seen === first.first_seen, 'first_seen never moves')
assert(second.last_seen === '2026-08-02T00:00:00.000Z', 'last_seen follows the newest sample')
assert(second.samples === 2, 'the sample count increments')
// A restarted client reports 0 rather than replaying its history; the total must not drop.
const third = mergeSample(second, parseSample(goodSample).sample, new Date('2026-08-03T00:00:00Z'))
assert(third.errors === 5 && third.crashes === 1, 'a restarted client reporting zero deltas does not reset the totals')

// summarise: 装机量 is every install, 运行量 only those inside the window, and the breakdowns describe
// what is running now — a version retired a year ago must not sit in the list forever.
const NOW = Date.parse('2026-08-29T12:00:00Z')
const ago = (ms) => new Date(NOW - ms).toISOString()
const fleet = [
  { last_seen: ago(60_000), mcver: '1.21.4', loader: 'paper', licensestatus: 'active', osarch: 'amd64', errors: 4, crashes: 1, warns: 7 },
  { last_seen: ago(120_000), mcver: '1.21.4', loader: 'paper', licensestatus: 'active', osarch: 'aarch64', errors: 0, crashes: 0, warns: 0 },
  { last_seen: ago(90_000), mcver: '1.20.6', loader: 'fabric', licensestatus: 'expired', osarch: 'amd64', errors: 2, crashes: 0, warns: 1 },
  { last_seen: ago(30 * 24 * 3600_000), mcver: '1.19.2', loader: 'spigot', licensestatus: 'expired', osarch: 'amd64', errors: 9, crashes: 3, warns: 2 }
]
const summary = summarise(fleet, NOW)
assert(summary.installed_hwid === 4, '装机量 counts every install ever seen')
assert(summary.running_hwid === 3, '运行量 counts only installs inside the running window')
assert(summary.errors === 15 && summary.crashes === 4 && summary.warns === 10, 'counters total across the whole fleet, including long-silent installs')
assert(!('1.19.2' in summary.by_mcver), 'a breakdown excludes installs outside the running window')
assert(summary.by_mcver['1.21.4'] === 2 && summary.by_mcver['1.20.6'] === 1, 'installs are tallied by version')
assert(Object.keys(summary.by_mcver)[0] === '1.21.4', 'a breakdown is ordered largest first')
assert(summary.by_loader.paper === 2 && summary.by_licensestatus.active === 2 && summary.by_osarch.amd64 === 2, 'every required breakdown is produced')
assert(summarise([], NOW).installed_hwid === 0 && Object.keys(summarise([], NOW).by_mcver).length === 0, 'an empty fleet summarises to zeroes, not a crash')
assert(summarise(null, NOW).installed_hwid === 0, 'a missing fleet is treated as empty')
assert(summarise([{ last_seen: ago(1000), errors: 0 }], NOW).by_osarch['未知'] === 1, 'an install that reported no osarch is labelled rather than dropped')
// The window is deliberately several times the heartbeat interval: at exactly one interval a sample a
// second late would drop a live server out of the count and make the figure flicker.
assert(RUNNING_WINDOW_MS >= 3 * 5 * 60 * 1000, 'the running window is several heartbeat intervals wide')

// Endpoint guards. Every one of these answers before the service client is constructed, so they hold
// with no Supabase credentials in the environment.
let tStatus = 0
let tBody = null
const tRes = { status(code) { tStatus = code }, setHeader() {}, send(value) { tBody = JSON.parse(value) } }
const savedKey = process.env.TELEMETRY_INGEST_KEY

delete process.env.TELEMETRY_INGEST_KEY
await telemetryHandler({ method: 'GET', headers: {} }, tRes)
assert(tStatus === 405, 'telemetry ingest is POST-only')
await telemetryHandler({ method: 'POST', headers: {}, body: goodSample }, tRes)
assert(tStatus === 503, 'an unconfigured endpoint refuses rather than accepting anonymously')

process.env.TELEMETRY_INGEST_KEY = 'test-ingest-key'
await telemetryHandler({ method: 'POST', headers: {}, body: goodSample }, tRes)
assert(tStatus === 401, 'a sample with no key is rejected')
await telemetryHandler({ method: 'POST', headers: { 'x-aether-key': 'wrong' }, body: goodSample }, tRes)
assert(tStatus === 401, 'a sample with the wrong key is rejected')
// The comparison hashes both sides before comparing, so a key that is merely a prefix of the real one
// must not pass — that is the failure mode a length-dependent compare would have.
await telemetryHandler({ method: 'POST', headers: { 'x-aether-key': 'test-ingest' }, body: goodSample }, tRes)
assert(tStatus === 401, 'a key that is a prefix of the real one is rejected')
await telemetryHandler({ method: 'POST', headers: { 'x-aether-key': 'test-ingest-key' }, body: { hwid: 'nope' } }, tRes)
assert(tStatus === 400 && tBody?.error, 'a malformed sample answers 400 before touching the database')
await telemetryHandler({ method: 'POST', headers: { authorization: 'Bearer test-ingest-key' }, body: { hwid: 'nope' } }, tRes)
assert(tStatus === 400, 'the key is also accepted as a bearer token')

if (savedKey === undefined) delete process.env.TELEMETRY_INGEST_KEY
else process.env.TELEMETRY_INGEST_KEY = savedKey

console.log('Telemetry samples: OK')

// --- §6 权限组与 GitHub 团队映射 ------------------------------------------------------------------
// rank 表有两份：shared/groups.mjs（浏览器和接口共用）和 schema.sql 里的 private.group_rank()（管 RLS，
// 没法从 JS 引用）。两边不一致的后果是「界面显示能做但接口拒绝」，或者反过来——后者是个安全洞。
// 所以这里把 JS 那份和那段 SQL 对着断言，而不是各自单测。
const GROUPS = GROUP_ORDER
const schemaSql = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8')

for (const group of GROUPS) {
  assert(GROUP_RANK[group] !== undefined, `${group} needs a rank in shared/groups.mjs`)
  assert(API_RANK[group] === GROUP_RANK[group], `${group} must reach the API with the same rank the UI shows`)
  assert(GROUP_LABEL[group], `${group} needs a Chinese label, or the admin select shows a bare slug`)
  // schema.sql 的 group_rank() 用 g::text 比较，所以每个组名都该以字符串出现在那个 case 里。
  assert(new RegExp(`when '${group}' then ${GROUP_RANK[group]}`).test(schemaSql) || group === 'default',
    `private.group_rank() must rank '${group}' as ${GROUP_RANK[group]} to match shared/groups.mjs`)
}
assert(new Set(GROUP_ORDER).size === GROUP_ORDER.length, 'GROUP_ORDER must list every group exactly once')
assert(Object.keys(GROUP_RANK).length === GROUP_ORDER.length, 'every ranked group must be assignable from the admin select')
// 未知组必须是 0，不是 undefined：一个将来加进枚举但忘了排名的组要无权，而不是意外获得权限。
assert(rankOf('nonexistent') === 0 && rankOf(null) === 0 && rankOf(undefined) === 0,
  'an unranked group must read as 0, never as undefined — undefined >= 777 is false but undefined < 111 is also false')
assert(/else 0 end/.test(schemaSql), 'private.group_rank() must fall through to 0 for the same reason')

// §6 的优先级：admin 999 > cs 888 > postsale = presale 777 > coworker 555 > read 111 > default 0
assert(GROUP_RANK.admin > GROUP_RANK.cs && GROUP_RANK.cs > GROUP_RANK.postsale, '§6 ranks admin above cs above the single-team agents')
assert(GROUP_RANK.presale === GROUP_RANK.postsale, 'presale and postsale share §6 priority 777')
assert(GROUP_RANK.default === 0, 'an ordinary buyer must rank 0')
assert(RANK.ADMIN === GROUP_RANK.admin && RANK.STAFF === GROUP_RANK.presale && RANK.MEMBER === GROUP_RANK.read,
  'the named thresholds must line up with the ranks they are meant to name')

// 编辑权限不是 rank 阈值。售前客服在 §6 里高于文案（777 > 555），但不该因此能发文章——这条如果退化成
// rank >= 555，客服就能改站点内容，而 §2 从没给过这个权限。
assert(isEditor('coworker') && isEditor('admin'), '文案 and 管理员 are the two groups that may publish')
for (const group of ['presale', 'postsale', 'cs']) {
  assert(!isEditor(group), `${group} outranks 文案 in ticket dispatch but must not be able to publish content`)
  assert(GROUP_RANK[group] > GROUP_RANK.coworker, `${group} does outrank 文案 — which is exactly why editing cannot be a rank threshold`)
}
assert(!isEditor('read') && !isEditor('default'), 'neither read nor default may publish')
assert(EDITOR_GROUPS.length === 2, 'the editor list is an enumeration, not a threshold')
assert(/private\.is_editor\(\)/.test(schemaSql), 'schema.sql must gate posts/progress on is_editor(), not on a rank')
assert(!/my_rank\(\)\) >= 555/.test(schemaSql), 'no policy may use 555 as an editing threshold')

// §12.2：read 及以上能看全部订单，已确认是有意的。
assert(rankOf('read') >= RANK.MEMBER, 'read must clear the order-visibility floor')
assert(rankOf('default') < RANK.MEMBER, 'an ordinary buyer must not clear it, or every buyer sees every order')
assert(/create policy own_orders_read[\s\S]{0,200}can_view_orders\(\)/.test(schemaSql),
  'the orders read policy must go through can_view_orders(), which is where §12.2 is decided')

// 枚举事务陷阱：alter type ... add value 之后，同一事务里不能把新值当字面量用，而 schema.sql 是整段跑的。
// 所以三个新组名不能出现在任何 = 'xxx' 或 in ('xxx') 的比较里——只能经过 g::text。
assert(/add value if not exists 'presale'/.test(schemaSql), 'the three new groups must be added with ALTER for pre-existing databases')
for (const group of ['presale', 'postsale', 'cs']) {
  const asEnumLiteral = new RegExp(`current_user_group\\(\\)\\)?\\s*(=|in\\s*\\()\\s*[^)]*'${group}'`)
  assert(!asEnumLiteral.test(schemaSql),
    `'${group}' must not be compared as an enum literal — same transaction as its ALTER, so Postgres refuses with "unsafe use of new value"`)
}
// github_team_map 是这个文件自己 seed 的，所以它的 group_name 必须是 text：写 'cs' 作为枚举字面量会在
// 刚 ALTER 过这个类型的库上失败。user_profiles.group_name 用枚举没问题——它不在这个文件里被 seed。
const teamMapDdl = schemaSql.slice(schemaSql.indexOf('create table if not exists public.github_team_map'))
assert(/group_name text not null check/.test(teamMapDdl.slice(0, 400)),
  'github_team_map.group_name must be a text column with a check constraint, not the enum, for the transaction reason')
// 旧的 ='admin' 比较同样是被 ALTER 过的类型的字面量，必须全部换成 helper。
assert(!/current_user_group\(\)\)\s*=\s*'admin'/.test(schemaSql), "no policy may still compare current_user_group() = 'admin'")

// resolveGroup：§6 里「同时在售前和售后团队」→ cs，这不是取最高能算出来的（两个都是 777）。
assert(resolveGroup(['presale', 'postsale']) === 'cs', 'membership of both CS teams maps to cs, per §6')
assert(resolveGroup(['postsale', 'presale']) === 'cs', 'the order the teams come back in must not matter')
assert(resolveGroup(['presale']) === 'presale' && resolveGroup(['postsale']) === 'postsale', 'a single CS team maps to itself')
// cs 是 777 档内部的升级，不是一条盖过 admin 的规则：既在 devs 又在两个客服团队里的人是 admin，不是 cs。
assert(resolveGroup(['admin', 'presale', 'postsale']) === 'admin', 'devs/testers outrank the cs promotion')
assert(resolveGroup(['cs', 'presale']) === 'cs', 'an explicit cs team membership stands on its own')
assert(resolveGroup(['coworker', 'presale']) === 'presale', 'the highest §6 priority wins when the cs rule does not apply')
assert(resolveGroup(['coworker']) === 'coworker' && resolveGroup(['admin']) === 'admin', 'a lone team maps to its own group')
assert(resolveGroup([]) === null, 'no team match must be distinguishable from a match, so the caller can fall back to read')
assert(resolveGroup(['presale', 'presale']) === 'presale', 'a duplicated team must not change the outcome')

// §6 的团队 slug 全部登记在表里，而不是硬编码在端点里——slug 是唯一无法从代码验证的部分。
for (const [slug, group] of [['devs', 'admin'], ['testers', 'admin'], ['pre-sales', 'presale'], ['post-sales', 'postsale'], ['copywriter', 'coworker']]) {
  assert(new RegExp(`\\('${slug}','${group}'`).test(schemaSql), `§6 maps @AetherAC/${slug} to ${group}; github_team_map must seed it`)
}
assert(/github_team_map/.test(schemaSql), 'the team map must be a table so a wrong slug can be fixed without a deploy')

assert(loginOf({ user_metadata: { user_name: 'octocat' } }) === 'octocat', 'GitHub OAuth stores the login in user_name')
assert(loginOf({ user_metadata: { preferred_username: 'octocat' } }) === 'octocat', 'the OIDC spelling must also be read')
assert(loginOf({ user_metadata: {} }) === null && loginOf({}) === null && loginOf(null) === null,
  'an account with no GitHub identity must report null rather than "undefined" as a login')

let syncStatus = 0
let syncBody = null
const syncRes = { status(code) { syncStatus = code }, setHeader() {}, send(value) { syncBody = JSON.parse(value) } }
const savedOrgToken = process.env.GITHUB_ORG_TOKEN

// 没配 token：必须 200 + configured:false。前端登录后会无条件打这个接口，回 5xx 会在每个买家的控制台刷红。
delete process.env.GITHUB_ORG_TOKEN
await syncHandler({ method: 'GET', headers: {} }, syncRes)
assert(syncStatus === 200 && syncBody?.configured === false, 'an unconfigured sync endpoint must answer 200, not an error')
assert(/GITHUB_ORG_TOKEN/.test(syncBody.message) && /read:org/.test(syncBody.message), 'the fallback must name the variable and the scope it needs')

// 配了 token 但没登录：401。这一步在构造 Supabase 客户端之前答完，所以不需要数据库凭证。
process.env.GITHUB_ORG_TOKEN = 'ghp_smoke_not_a_real_token'
await syncHandler({ method: 'GET', headers: {} }, syncRes)
assert(syncStatus === 401 && syncBody?.error, 'a configured sync endpoint must still require a session')
await syncHandler({ method: 'POST', headers: {} }, syncRes)
assert(syncStatus === 401, 'the admin POST path must reject an unauthenticated request before reading the body')
await syncHandler({ method: 'DELETE', headers: {} }, syncRes)
assert(syncStatus === 405, 'only GET and POST are defined')

if (savedOrgToken === undefined) delete process.env.GITHUB_ORG_TOKEN
else process.env.GITHUB_ORG_TOKEN = savedOrgToken

// requireUser 的第三参从 boolean 改成了最低 rank。旧调用方写 true 表示「只有 admin」，那个含义必须保留，
// 否则任何漏改的调用点会静默地把接口开放给所有登录用户。
let guardStatus = 0
const guardRes = { status(code) { guardStatus = code }, setHeader() {}, send() {} }
for (const need of [true, false, 0, RANK.ADMIN, RANK.STAFF, undefined]) {
  guardStatus = 0
  assert(await requireUser({ headers: {} }, guardRes, need) === null && guardStatus === 401,
    `requireUser(need=${String(need)}) must reject a request with no token`)
}

console.log('Permission groups and GitHub team sync: OK')

// §1 优惠券。这一段测的几乎全是「不会抛异常、只会算错钱」的情形——那类 bug 在生产上的第一个症状
// 通常是支付渠道的对账差异，离原因已经很远了，所以在这里钉死。

// 取整方向。折扣额 floor，也就是零头归商家；这一条要是被改成 ceil，每笔多折一分，测试必须失败。
// 注意单位：这里的 101 是 101 个最小单位（分），不是 101 元。9.5 折的折扣是 amount/20，所以要触发取整，
// 金额必须不能被 20 整除——写成 10100（101 元）就除得尽，那样这条断言测不到任何取整行为。
assert(applyActions([{ type: 'percent', value: 9500 }], 101).discountMinor === 5,
  '101 分打 9.5 折应折 5.05 分，实折必须是 5 分（折扣额向下取整）')
assert(applyActions([{ type: 'percent', value: 9500 }], 101).amountMinor === 96,
  '折后金额必须是原价减实际折扣，不能对金额单独取整')
assert(applyActions([{ type: 'percent', value: 9500 }], 1).discountMinor === 0,
  '1 分钱打 9.5 折的折扣被抹成 0，是取整方向的已知代价，改动这个行为要同时改注释')
// discountMinor 和 amountMinor 必须始终互补，否则「原价 - 实付」和记账里的折扣额对不上。
for (const [amount, pct] of [[1, 9500], [7, 3333], [99, 6667], [10000, 100], [123456, 8889]]) {
  const r = applyActions([{ type: 'percent', value: pct }], amount)
  assert(r.amountMinor + r.discountMinor === amount, `折扣与实付必须互补（${amount} @ ${pct}）`)
  assert(Number.isInteger(r.amountMinor) && r.amountMinor >= 0, '实付必须是非负整数')
}

// 顺序敏感是有意的：先减后折和先折后减结果不同，配置数组的顺序就是执行顺序。
const cutThenPct = applyActions([{ type: 'fixed', value: 1000 }, { type: 'percent', value: 9000 }], 10000)
const pctThenCut = applyActions([{ type: 'percent', value: 9000 }, { type: 'fixed', value: 1000 }], 10000)
assert(cutThenPct.amountMinor === 8100 && pctThenCut.amountMinor === 8000,
  '动作顺序必须影响结果，合并同类项或排序都会算错')

// 逐步夹到 0，而不是只夹最后一次。
assert(applyActions([{ type: 'fixed', value: 20000 }, { type: 'delta', value: 10000 }], 10000).amountMinor === 10000,
  '中间夹 0 之后的加价从 0 起算')
assert(applyActions([{ type: 'percent', value: 0 }], 12345).amountMinor === 0, 'value=0 是全免')
assert(applyActions([{ type: 'percent', value: 10000 }], 12345).amountMinor === 12345, 'value=10000 是原价')
// 非整数金额必须抛，而不是静默地按浮点算。
let threw = false
try { applyActions([], 10.5) } catch { threw = true }
assert(threw, '浮点金额必须抛异常，钱不能走浮点路径')
// 形状非法的动作被跳过而不是让整笔结算失败。
assert(applyActions([{ type: 'percent', value: 20000 }, { type: 'fixed', value: 100 }], 1000).amountMinor === 900,
  '越界的动作跳过，合法的照常执行')

// 币种不匹配判条件不成立，而不是报错——多币种站点上一张配错币种的券不该让结算 500。
const amountCond = { type: 'amount', op: 'gte', value: 10000, currency: 'USD' }
assert(evaluateCondition(amountCond, { amountMinor: 20000, currency: 'USD' }) === true, '同币种且满额应成立')
assert(evaluateCondition(amountCond, { amountMinor: 20000, currency: 'JPY' }) === false, '异币种必须判不成立')
assert(evaluateCondition(amountCond, { amountMinor: 20000, currency: 'usd' }) === true, '币种比较不区分大小写')
assert(evaluateCondition(amountCond, { amountMinor: 10000, currency: 'USD' }) === true, 'gte 含端点')
assert(evaluateCondition({ ...amountCond, op: 'gt' }, { amountMinor: 10000, currency: 'USD' }) === false, 'gt 不含端点')

// SKU 六种匹配全覆盖。
const skuCases = [
  ['is', 'aetherac-pro', true], ['is', 'aetherac', false],
  ['is_not', 'aetherac', true], ['is_not', 'aetherac-pro', false],
  ['contains', 'ether', true], ['contains', 'zzz', false],
  ['not_contains', 'zzz', true], ['not_contains', 'ether', false],
  ['starts_with', 'aether', true], ['starts_with', 'pro', false],
  ['ends_with', 'pro', true], ['ends_with', 'aether', false]
]
for (const [op, value, expected] of skuCases) {
  assert(evaluateCondition({ type: 'sku', op, value }, { sku: 'aetherac-pro' }) === expected,
    `SKU ${op} ${value} 的判定错了`)
}

// 历史订单条件按状态求和，不是逐个比较。
const hist = { counts: { paid: 2, refunded: 1, cancelled: 5 } }
assert(evaluateCondition({ type: 'order_history', statuses: ['paid', 'refunded'], op: 'gte', count: 3 }, { history: hist }) === true,
  '多状态必须求和（2 + 1 >= 3）')
assert(evaluateCondition({ type: 'order_history', statuses: ['paid'], op: 'gte', count: 3 }, { history: hist }) === false,
  '单状态不该借到别的状态的计数')
assert(evaluateCondition({ type: 'order_history', statuses: ['paid'], op: 'gte', count: 1 }, {}) === false,
  '缺 history 时计数按 0 算，条件不成立而不是崩')

// 首单按「付过钱」判，不是按「下过单」判：下单未付、过期作废的用户仍算首单。
assert(evaluateCondition({ type: 'first_order', value: true }, { history: { counts: { pending: 3, expired: 2 } } }) === true,
  '只下过未付款的单仍算首单')
assert(evaluateCondition({ type: 'first_order', value: true }, { history: { counts: { paid: 1 } } }) === false,
  '付过款就不是首单')
assert(evaluateCondition({ type: 'first_order', value: true }, { history: { counts: { refunded: 1 } } }) === false,
  '退过款也算付过，不是首单')

// 未知条件类型判不成立，绝不能「忽略后继续」——那会让同一张券在旧版代码上更容易满足。
assert(evaluateCondition({ type: 'no_such_thing' }, {}) === false, '未知条件类型必须判不成立')
assert(validateCondition({ type: 'no_such_thing' }).ok === false, '未知条件类型必须校验失败')
assert(evaluateCondition({ type: 'amount', op: 'gte', value: 1 }, { amountMinor: 100, currency: 'USD' }) === false,
  '缺币种的金额条件形状非法，判不成立')

// 全部条件 AND，且要能指出是哪几条不成立。
const conds = [amountCond, { type: 'sku', op: 'contains', value: 'pro' }]
assert(evaluateConditions(conds, { amountMinor: 20000, currency: 'USD', sku: 'aetherac-pro' }).ok === true, '全部满足')
const partial = evaluateConditions(conds, { amountMinor: 100, currency: 'USD', sku: 'aetherac-pro' })
assert(partial.ok === false && partial.failed.length === 1 && partial.failed[0].type === 'amount',
  '不成立的条件必须能被指认出来')
assert(evaluateConditions([], {}).ok === true, '无条件的券对任何订单都成立')
assert(evaluateConditions(null, {}).ok === true, 'conditions 为 null 时不能崩')

// 券形状校验。
assert(validateCoupon({ code: 'save10', conditions: [], actions: [{ type: 'fixed', value: 100 }] }).code === 'SAVE10',
  '券码必须归一成大写，因为唯一索引建在 upper(code) 上')
assert(validateCoupon({ code: 'ab', conditions: [], actions: [{ type: 'fixed', value: 1 }] }).ok === false, '券码太短')
assert(validateCoupon({ code: 'has space', conditions: [], actions: [{ type: 'fixed', value: 1 }] }).ok === false, '券码不允许空格')
assert(validateCoupon({ code: 'ok1', conditions: [], actions: [] }).ok === false, '没有动作的券什么都不做，应拒')
assert(validateCoupon({ code: 'ok1', conditions: [], actions: [{ type: 'fixed', value: 1 }], allowed_user_ids: [] }).ok === false,
  '空的可用名单等于谁都不能用，是个容易配错的形状，必须拒并说明')
assert(validateCoupon({ code: 'ok1', conditions: [], actions: [{ type: 'fixed', value: 1 }], allowed_user_ids: null }).ok === true,
  'null 才是「不限」')
assert(validateCoupon({ code: 'ok1', conditions: [], actions: [{ type: 'fixed', value: 1 }], per_user_limit: 0 }).ok === true,
  '0 是合法的 per_user_limit（一次都不能用），不能和 null 混为一谈')
assert(validateCoupon({
  code: 'ok1', conditions: [], actions: [{ type: 'fixed', value: 1 }],
  starts_at: '2026-02-01T00:00:00Z', ends_at: '2026-01-01T00:00:00Z'
}).ok === false, '生效时间晚于失效时间应拒')
// 错误信息要指出是第几条，否则管理员配了十条条件后无从下手。
const badAt = validateCoupon({ code: 'ok1', conditions: [amountCond, { type: 'sku', op: 'nope', value: 'x' }], actions: [{ type: 'fixed', value: 1 }] })
assert(badAt.ok === false && /第 2 条条件/.test(badAt.error), '校验错误必须定位到第几条条件')

// 可用性里不依赖数据库的那一半。per_user_limit 不在这里判，它必须由 redeem_coupon 原子地判。
const now = new Date('2026-06-01T00:00:00Z')
assert(checkAvailability({ enabled: false }, { now }).ok === false, '停用的券不可用')
assert(checkAvailability({ enabled: true, starts_at: '2026-07-01T00:00:00Z' }, { now }).ok === false, '未开始')
assert(checkAvailability({ enabled: true, ends_at: '2026-05-01T00:00:00Z' }, { now }).ok === false, '已过期')
assert(checkAvailability({ enabled: true, total_limit: 5, used_count: 5 }, { now }).ok === false, '总量用尽')
assert(checkAvailability({ enabled: true, total_limit: null, used_count: 99999 }, { now }).ok === true, 'null 总量 = 不限')
assert(checkAvailability({ enabled: true, allowed_user_ids: ['u1'] }, { now, userId: 'u2' }).ok === false, '不在名单里')
assert(checkAvailability({ enabled: true, allowed_user_ids: ['u1'] }, { now, userId: 'u1' }).ok === true, '在名单里')

// quote 把两半合起来，失败时要带上人能读的原因。
const coupon = { enabled: true, conditions: [amountCond], actions: [{ type: 'percent', value: 9000 }] }
const good = quote(coupon, { amountMinor: 20000, currency: 'USD', now, userId: 'u1' })
assert(good.ok === true && good.discountMinor === 2000 && good.amountMinor === 18000, 'quote 的折扣算错了')
const bad = quote(coupon, { amountMinor: 100, currency: 'USD', now, userId: 'u1' })
assert(bad.ok === false && bad.discountMinor === 0 && bad.amountMinor === 100 && /不低于/.test(bad.error),
  '不满足条件时折扣必须是 0，且原因要说得出来')

// 零小数位币种不能除 100。把 1000 日元显示成 10 日元是会被用户当成标错价的。
assert(formatMinor(1000, 'JPY') === '1000 JPY', '日元没有小数位')
assert(formatMinor(1000, 'USD') === '10.00 USD', '美元有两位小数')
assert(formatMinor(1000) === '10.00', '不给币种时只给数字')

// 描述文本：后台和结算页共用，不能两处各写一份中文。
assert(describeAction({ type: 'percent', value: 9000 }) === '打 9 折（减 10%）', '整折的文案')
assert(describeAction({ type: 'percent', value: 9500 }) === '打 9.5 折（减 5%）', '半折的文案')
assert(describeAction({ type: 'percent', value: 10000 }) === '不打折', '原价的文案')
assert(describeAction({ type: 'percent', value: 0 }) === '全额免除', '全免的文案')
assert(describeAction({ type: 'delta', value: -500 }) === '减 5.00', '负 delta 读作减价')
assert(describeAction({ type: 'delta', value: 500 }) === '加 5.00', '正 delta 读作加价')
assert(/不低于 100.00 USD/.test(describeCondition(amountCond)), '金额条件要带币种')
assert(describeCondition({ type: 'first_order', value: true }) === '仅限首次购买', '首单条件的文案')
assert(describeCondition(null) === '（无效条件）', '坏数据要有兜底文案，不能崩在渲染里')

// 枚举本身：这些数组是前端下拉框的数据源，少一项就是一种规则配不出来。
assert(CONDITION_TYPES.length === 5 && SKU_OPERATORS.length === 6 && AMOUNT_OPERATORS.length === 6 && ACTION_TYPES.length === 3,
  '条件/动作枚举的数量变了，前端下拉框和这里要一起改')
for (const op of AMOUNT_OPERATORS) {
  assert(validateCondition({ type: 'amount', op, value: 1, currency: 'USD' }).ok, `${op} 必须是合法的金额比较`)
}
for (const t of ACTION_TYPES) {
  assert(validateAction({ type: t, value: t === 'percent' ? 9000 : 100 }).ok, `${t} 必须是合法的动作`)
}

console.log('Coupon conditions and actions: OK')

// §9 站内信。

// 两份订单路径实现必须一致。shared/notifications.mjs 里的 orderHref 是 routes.ts 里 orderPath 的第二份
// 实现（理由写在那边的注释里），这条断言是那份重复的全部安全保障。
for (const id of ['11111111-2222-3333-4444-555555555555', 'abc', '需要转义的 id']) {
  assert(orderHref(id) === orderPath(id), `orderHref 与 orderPath 必须给出同一个结果（${id}）`)
}

// 站内信是单向的，所以不该有任何回复类动作。这条断言是把 §9 那句「不可回复」钉在代码里——
// 将来有人想加 reply，会先撞到这里，而不是等到用户在一个没人看的地方提了问题。
assert(!NOTIF_ACTION_TYPES.some(t => /reply|respond|answer/i.test(t)), '站内信是单向的，不能有回复类动作')

// scope 和 recipient_id 必须同生共死，schema.sql 里那条 check 约束是同一件事。
const baseNotif = { kind: 'system', scope: 'all', title: '标题', body: '正文' }
assert(validateNotification(baseNotif).ok === true, '最小合法站内信')
assert(validateNotification({ ...baseNotif, scope: 'user' }).ok === false, 'scope=user 缺 recipient_id 应拒')
assert(validateNotification({ ...baseNotif, scope: 'user', recipient_id: 'u1' }).ok === true, 'scope=user 带 recipient_id')
assert(validateNotification({ ...baseNotif, recipient_id: 'u1' }).ok === false, '广播范围带 recipient_id 应拒')
assert(validateNotification({ ...baseNotif, kind: 'nope' }).ok === false, '未知类型应拒')
assert(validateNotification({ ...baseNotif, scope: 'nope' }).ok === false, '未知范围应拒')
assert(validateNotification({ ...baseNotif, title: '' }).ok === false, '空标题应拒')
assert(validateNotification({ ...baseNotif, body: '  ' }).ok === false, '空白正文应拒')
assert(validateNotification({ ...baseNotif, state: null }).ok === true, 'state 可以是 null（不是待办）')
assert(validateNotification({ ...baseNotif, state: 'nope' }).ok === false, '未知 state 应拒')

// kind 的两份声明必须一致：JS 这份决定能不能提交，schema.sql 那条 check 决定能不能落库。
// 只有 JS 多一个值的时候，validateNotification 会放行、数据库会拒——而调用方只看到一句约束名，
// 于是「通知一条都发不出去」被当成偶发故障。所以两边逐值双向对齐。
const kindCheck = schemaSql.match(/kind text not null default 'system' check \(kind in \(([^)]*)\)\)/)
assert(kindCheck, 'schema.sql 里必须有 notifications.kind 的 check 约束，否则任何字符串都能落库')
const sqlKinds = kindCheck[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''))
for (const kind of NOTIFICATION_KINDS) {
  assert(sqlKinds.includes(kind), `notifications.kind 的 check 缺 '${kind}'——这种类型的站内信会被数据库拒掉`)
  assert(KIND_LABEL[kind], `${kind} 需要中文标签，否则收件箱里显示成裸 slug`)
}
for (const kind of sqlKinds) {
  assert(NOTIFICATION_KINDS.includes(kind), `schema.sql 允许 '${kind}' 但 NOTIFICATION_KINDS 没有——库里会出现前端认不出的行`)
}
// §9.6 的强制置顶靠 kind 区分，所以 refund 和 refund_approval 不能合成一个值。
assert(NOTIFICATION_KINDS.includes('refund') && NOTIFICATION_KINDS.includes('refund_approval'),
  '退款告知和退款审批必须是两种类型，否则普通告知也会占住置顶位')

// 外链必须拒。一条管理员发的站内信如果能挂外链，就是个带站点信誉的钓鱼入口，而站内信恰好是
// 用户最容易信任的位置。
const linkCases = [
  ['/order?order_id=x', true],
  ['/admin', true],
  ['https://example.com', false],
  ['//example.com', false],
  ['/\\example.com', false],
  ['javascript:alert(1)', false],
  ['order', false],
  ['/ok\nX-Injected: 1', false]
]
for (const [href, expected] of linkCases) {
  assert(validateNotifAction({ type: 'link', label: '去', href }).ok === expected,
    `link href 的判定错了：${JSON.stringify(href)}`)
}
assert(validateNotifAction({ type: 'link', href: '/ok' }).ok === false, '按钮必须有文案')

// 作用在对象上的动作必须带合法 uuid，否则就是个点不动的按钮。
const rid = '11111111-2222-3333-4444-555555555555'
assert(validateNotifAction({ type: 'approve_refund', label: '批准', target: rid }).ok === true, '合法的批准按钮')
assert(validateNotifAction({ type: 'approve_refund', label: '批准' }).ok === false, '缺 target 应拒')
assert(validateNotifAction({ type: 'approve_refund', label: '批准', target: 'not-a-uuid' }).ok === false, 'target 必须是 uuid')
assert(validateNotifAction({ type: 'mark_read', label: '知道了' }).ok === true, 'mark_read 不需要 target')
assert(validateNotifAction({ type: 'nope', label: 'x' }).ok === false, '未知动作类型应拒')
const tooMany = { ...baseNotif, actions: Array.from({ length: 7 }, () => ({ type: 'mark_read', label: 'x' })) }
assert(validateNotification(tooMany).ok === false, '按钮太多应拒')
const badBtn = { ...baseNotif, actions: [{ type: 'mark_read', label: 'ok' }, { type: 'link', label: '去', href: 'http://x' }] }
assert(validateNotification(badBtn).ok === false && /第 2 个按钮/.test(validateNotification(badBtn).error),
  '按钮校验错误必须定位到第几个')

// §9.6：待审批的通知强制置顶高亮。漏掉的表现是一条等着人批的退款躺在列表第二十行。
const approval = refundApprovalNotification({
  refundId: rid, orderNo: 'AE-2026-0001', amountText: '128.00 USD',
  reason: '重复支付', initiator: 'cs@example.com'
})
assert(validateNotification(approval).ok === true, '构造出来的审批通知本身必须合法')
assert(approval.state === 'pending' && approval.scope === 'admin' && approval.refund_id === rid, '审批通知的关键字段')
assert(presentationFor(approval).pinned === true && presentationFor(approval).highlighted === true,
  '待审批必须置顶高亮')
assert(presentationFor({ ...baseNotif, state: null }).pinned === false, '普通通知不置顶')
assert(presentationFor({ state: 'pending', actions: [{ type: 'mark_read', label: 'x' }] }).pinned === false,
  '只有含管理员动作的待办才置顶，一个「知道了」不算待审批')
// 三个按钮齐全，且批准按钮的文案带金额——管理员可能同时收到好几条，「批准」两个字在列表里长得一样。
assert(approval.actions.map(a => a.type).join(',') === 'approve_refund,reject_refund,transfer_refund',
  '§10.3 要求批准/拒绝/转交三个按钮')
assert(/128\.00 USD/.test(approval.actions[0].label), '批准按钮的文案要带金额')
assert(approval.body.includes('重复支付') && approval.body.includes('AE-2026-0001'), '正文要带原因和订单号')

// 超时升级是新的一条，不是改旧的那条。原地改标题的话，已读过原通知的管理员不会再收到任何提示，
// 而超时提醒的全部意义就是提示那个看过但没处理的人。
const esc = refundEscalationNotification({ refundId: rid, orderNo: 'AE-2026-0001', amountText: '128.00 USD', hours: 48 })
assert(validateNotification(esc).ok === true, '升级提醒必须合法')
assert(/48 小时/.test(esc.title) && esc.state === 'pending', '升级提醒要写明超时时长且仍是待办')
assert(!esc.actions.some(a => a.type === 'transfer_refund'), '升级提醒不给转交，此时要的是尽快决定')

// 退款结果通知：单向、只带一个跳转，且成功和失败的文案不同。
const done = refundDoneNotification({ userId: 'u1', orderNo: 'AE-1', orderId: rid, amountText: '10.00 USD', ok: true })
assert(validateNotification(done).ok === true && done.scope === 'user' && done.state === null, '退款完成通知不是待办')
assert(done.actions.length === 1 && done.actions[0].type === 'link' && done.actions[0].href === orderPath(rid),
  '退款完成通知只给一个订单页跳转，且路径必须和 orderPath 一致')
const failed = refundDoneNotification({ userId: 'u1', orderNo: 'AE-1', orderId: rid, amountText: '10.00 USD', ok: false, note: '渠道拒绝' })
assert(/未成功/.test(failed.title) && /渠道拒绝/.test(failed.body), '失败通知要说明原因')

// 权限与确认：这三份名单必须和接口侧一致，列在这里只是为了不显示注定 403 的按钮。
assert(ADMIN_ONLY_ACTIONS.every(t => NOTIF_ACTION_TYPES.includes(t)), '管理员动作必须都是已知动作')
assert(needsConfirm('approve_refund') === true, '批准退款不可逆，必须二次确认')
assert(needsConfirm('reject_refund') === false, '拒绝可以重新发起，不需要不可逆确认')
assert(needsReason('reject_refund') === true && needsReason('transfer_refund') === true, '拒绝和转交都必须填原因')
assert(needsReason('approve_refund') === false, '批准不强制填原因')
assert(canUseAction('approve_refund', RANK.STAFF) === false, '客服看不到批准按钮')
assert(canUseAction('approve_refund', RANK.ADMIN) === true, '管理员看得到批准按钮')
assert(canUseAction('link', 0) === true, '跳转按钮对谁都可见')
// 每个需要打接口的动作都要有 endpoint，否则前端拿到一个不知道往哪发的按钮。
for (const t of NOTIF_ACTION_TYPES) {
  if (t === 'link' || t === 'mark_read') continue
  assert(typeof ACTION_ENDPOINT[t] === 'string' && ACTION_ENDPOINT[t].startsWith('/api/'),
    `${t} 缺少接口映射`)
}

console.log('Notification shapes and refund approval: OK')

// --- §13 订单与退款状态机 ---------------------------------------------------------------------------
// 三份声明必须一致：shared/orders.mjs（界面和接口共用）、public.order_status 枚举、
// refund_requests_status_check。JS 多一个值时的后果最隐蔽——校验放行、Postgres 拒收。
const orderEnum = schemaSql.match(/create type public\.order_status as enum \(([^)]*)\)/)
assert(orderEnum, 'schema.sql 必须声明 public.order_status')
const sqlOrderStatuses = orderEnum[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''))
assert(sqlOrderStatuses.length === ORDER_STATUSES.length,
  `order_status 枚举有 ${sqlOrderStatuses.length} 个值，ORDER_STATUSES 有 ${ORDER_STATUSES.length} 个`)
for (const s of ORDER_STATUSES) {
  assert(sqlOrderStatuses.includes(s), `public.order_status 缺 '${s}'`)
  assert(ORDER_STATUS_LABEL[s], `${s} 需要中文标签`)
  assert(Array.isArray(ORDER_TRANSITIONS[s]), `${s} 必须在迁移表里有一条（终态写空数组）`)
}
for (const s of sqlOrderStatuses) {
  assert(ORDER_STATUSES.includes(s), `枚举允许 '${s}' 但 ORDER_STATUSES 没有——库里会出现前端认不出的订单`)
}
// expired 曾经在 JS 那份里，枚举里从来没有。这条断言防止它被谁又加回来。
assert(!ORDER_STATUSES.includes('expired'), '没有 expired 这个状态，废弃结账单落到 cancelled')

const refundCheck = schemaSql.match(/refund_requests_status_check\s*\n?\s*check \(status in \(([^)]*)\)\)/)
assert(refundCheck, 'schema.sql 必须有 refund_requests_status_check')
const sqlRefundStatuses = refundCheck[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''))
for (const s of REFUND_STATUSES) {
  assert(sqlRefundStatuses.includes(s), `refund_requests_status_check 缺 '${s}'`)
  assert(REFUND_STATUS_LABEL[s], `${s} 需要中文标签`)
  assert(Array.isArray(REFUND_TRANSITIONS[s]), `${s} 必须在退款迁移表里有一条`)
}
for (const s of sqlRefundStatuses) {
  assert(REFUND_STATUSES.includes(s), `check 允许 '${s}' 但 REFUND_STATUSES 没有`)
}

// 迁移表不能指向不存在的状态——一条指向 typo 的出边会让按钮亮着但接口永远拒。
for (const [from, outs] of Object.entries(ORDER_TRANSITIONS)) {
  for (const to of outs) assert(ORDER_STATUSES.includes(to), `ORDER_TRANSITIONS.${from} 指向未知状态 ${to}`)
}
for (const [from, outs] of Object.entries(REFUND_TRANSITIONS)) {
  for (const to of outs) assert(REFUND_STATUSES.includes(to), `REFUND_TRANSITIONS.${from} 指向未知状态 ${to}`)
}

// §13.1：退款只能从 PAID 出发。这是整节的地基，所以逐个状态钉一遍而不是只测 paid。
for (const s of ORDER_STATUSES) {
  assert(canTransition(s, 'refund_pending') === (s === 'paid'),
    `只有已支付订单能进入退款中，${s} 不该能`)
}
// §13 状态图里那个「无法退款」按钮：退款中要能退回已支付，否则订单永久卡住。
assert(canTransition('refund_pending', 'paid'), '退款中必须能退回已支付（无法退款）')
assert(canTransition('refund_pending', 'refunded'), '退款中必须能到已退款')
// paid → paid 不是合法迁移，尽管 §13.5 要求记一条 PAID → PAID 的日志。
assert(!canTransition('paid', 'paid'), 'paid → paid 是审计记录而不是迁移，否则幂等检查全部失效')
assert(!canTransition('refunded', 'paid') && !canTransition('cancelled', 'paid'), '终态不能回头')
assert(canTransition('unknown', 'paid') === false, '未知状态返回 false 而不是抛——调用方在决定按钮亮不亮')
assert(TERMINAL_ORDER_STATUSES.includes('refunded') && TERMINAL_ORDER_STATUSES.includes('cancelled'), '终态列表')
assert(!TERMINAL_ORDER_STATUSES.includes('paid'), '已支付不是终态')

// §13.4 的日志形式。库里存小写，渲染时才大写——两者分开是有意的。
assert(transitionLabel('paid', 'refund_pending') === 'PAID → REFUND_PENDING', '§13.4 的日志形式')

// 非法迁移的错误信息要说清合法的下一步，否则管理员只知道被拒不知道能干什么。
const terminalErr = assertTransition('cancelled', 'paid')
assert(terminalErr.ok === false && terminalErr.error.includes('终态'), '终态的错误信息要说明它是终态')
const illegalErr = assertTransition('pending', 'refunded')
assert(illegalErr.ok === false && illegalErr.error.includes('已支付') && illegalErr.error.includes('已取消'),
  '非法迁移要列出合法的下一步')
assert(assertTransition('paid', 'refund_pending').ok === true, '合法迁移放行')
assert(assertTransition('nope', 'paid').error.includes('未知的订单状态'), '未知状态单独一句')

// §13.2：灰按钮的悬浮文案。每种拒绝理由都要不同，否则用户看到同一句话却是不同原因。
const paidOrder = { status: 'paid', paid_amount_minor: 9900 }
const okRefund = canRequestRefund(paidOrder)
assert(okRefund.ok === true && okRefund.maxAmountMinor === 9900, '已支付订单可退，上限是实付金额')
const reasons = new Set()
for (const s of ORDER_STATUSES) {
  const r = canRequestRefund({ status: s, paid_amount_minor: 9900 })
  assert(r.ok === (s === 'paid'), `${s} 的可退性`)
  if (!r.ok) { assert(r.reason.length > 0, `${s} 必须有悬浮文案`); reasons.add(r.reason) }
}
assert(reasons.size === ORDER_STATUSES.length - 1, '每种不可退的原因要有各自的文案')
assert(canRequestRefund(null).ok === false, '订单不存在')
// 在途申请要拦。申请刚提交时订单还是 paid，光看状态会让同一单被提两次。
assert(canRequestRefund(paidOrder, { status: 'pending' }).ok === false, '已有待审批申请时不能再提')
assert(canRequestRefund(paidOrder, { status: 'executing' }).ok === false, '执行中不能再提')
assert(canRequestRefund(paidOrder, { status: 'rejected' }).ok === true, '被拒过可以重提')
assert(canRequestRefund(paidOrder, { status: 'completed' }).ok === true, '已完成的旧申请不拦新的')
assert(canRequestRefund({ status: 'paid', paid_amount_minor: 0 }).ok === false, '零金额订单没有可退金额')
// 老订单没有 paid_amount_minor（那是这次加的列），要退回 amount_minor。
assert(canRequestRefund({ status: 'paid', amount_minor: 500 }).maxAmountMinor === 500, '老订单退回 amount_minor')

// §10.2：金额可改但不得超过实付，且只收整数。
assert(validateRefundAmount(paidOrder, 9900).ok === true, '全额退款')
assert(validateRefundAmount(paidOrder, 1).ok === true, '部分退款')
assert(validateRefundAmount(paidOrder, 9901).ok === false, '超过实付应拒')
assert(validateRefundAmount(paidOrder, 0).ok === false, '零金额应拒')
assert(validateRefundAmount(paidOrder, -1).ok === false, '负金额应拒')
assert(validateRefundAmount(paidOrder, 99.5).ok === false, '浮点金额应拒——钱只走最小货币单位的整数')
assert(validateRefundAmount(paidOrder, '99').ok === false, '字符串金额应拒')

// §10.4 的退款迁移。转交绕回待审批，因为接手的人还得批或拒。
assert(canRefundTransition('transferred', 'pending'), '转交后回到待审批')
assert(canRefundTransition('failed', 'executing'), '失败可重试——新建申请会丢掉整条审批链')
assert(!canRefundTransition('pending', 'completed'), '不能跳过执行段')
assert(!canRefundTransition('rejected', 'pending'), '已拒绝是终态')
assert(assertRefundTransition('completed', 'executing').error.includes('终态'), '已完成是终态')

// §10.7：能代提的是售后、客服、管理员。presale 的 rank 和 postsale 一样，所以这里必须是名单不是阈值。
assert(!REFUND_PROXY_GROUPS.includes('presale'), '售前不该碰钱，尽管 rank 和售后相同')
assert(rankOf('presale') === rankOf('postsale'), '这两个组同 rank——正是不能用阈值的原因')
for (const g of REFUND_PROXY_GROUPS) assert(rankOf(g) >= RANK.STAFF, `${g} 至少是员工级`)
// 用户本人不在代提名单里，但必须能给自己的订单提——§13.3 的第一个入口就是用户订单页。
assert(!REFUND_PROXY_GROUPS.includes('user') && !REFUND_PROXY_GROUPS.includes('default'),
  '代提名单不含用户本人，那是另一条路径')
assert(REFUND_INITIATOR_ROLES.includes('user'), 'initiator_role 必须能记「用户自己提的」')
const roleCheck = schemaSql.match(/refund_requests_initiator_role_check\s*\n?\s*check \(initiator_role in \(([^)]*)\)\)/)
assert(roleCheck, 'schema.sql 必须有 initiator_role 的 check')
const sqlRoles = roleCheck[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''))
assert(sqlRoles.length === REFUND_INITIATOR_ROLES.length, 'initiator_role 的取值数量两边要一致')
for (const r of REFUND_INITIATOR_ROLES) assert(sqlRoles.includes(r), `initiator_role 的 check 缺 '${r}'`)
assert(REFUND_APPROVER_GROUPS.length === 1 && REFUND_APPROVER_GROUPS[0] === 'admin', '只有管理员能审批')

// §13.5 的拒绝日志。
const rej = rejectionLogEntry('o1', 'a1', 'admin', '证据不足')
assert(rej.from_status === 'paid' && rej.to_status === 'paid', '拒绝记 PAID → PAID')
assert(rej.note.includes('证据不足'), '拒绝理由必须进日志——§10.3 要求拒绝必须填理由')
assert(transitionLabel(rej.from_status, rej.to_status) === 'PAID → PAID', '渲染成 §13.5 要求的形式')

console.log('Order and refund state machine: OK')

// --- api/_lib/notify.mjs ---------------------------------------------------------------------------
// 这四个写入函数跑在 service client 上，所以 update 上的过滤条件就是全部的并发保护——
// settleApproval 少一个 .eq('state','pending')，两个管理员同时点批准就会各自以为自己做了决定。
// 一个会录下所有调用的假 db 把这些条件钉住。
const recorder = (results = {}) => {
  const calls = []
  const rec = { calls, tables: [] }
  rec.from = table => {
    rec.tables.push(table)
    const entry = { table, op: null, payload: null, filters: {}, selected: null }
    calls.push(entry)
    // 同一张表的结果可以有三种给法：
    //   - 一个对象：这张表的每次调用都给它
    //   - 一个数组：按调用顺序消费（refund-request 先查在途申请再插入），用完重复最后一个
    //   - 一个函数：拿到 entry 自己决定，用于 site_settings 这种要按 key 分别作答的
    // 三种都需要，因为审批那条链路会在同一张表上做完全不同的几次调用。
    const slot = results[table]
    const resolveResult = () => {
      if (typeof slot === 'function') return slot(entry) ?? { data: null, error: null }
      if (Array.isArray(slot)) return (slot.length > 1 ? slot.shift() : slot[0]) ?? { data: null, error: null }
      return slot ?? { data: null, error: null }
    }
    const link = {
      eq(col, val) { entry.filters[col] = val; return link },
      select(cols) { entry.selected = cols ?? '*'; return link },
      // order 可以链两次（收件箱是「置顶优先、再按时间倒序」），所以记成数组而不是覆盖一个字段。
      order(col, opts) { (entry.orders ??= []).push({ col, ...opts }); entry.order = { col, ...opts }; return link },
      limit(n) { entry.limit = n; return link },
      // or 的参数是一整条拼出来的字符串，原样留着——收件箱的可见性就靠它收窄，测试要能看出
      // 里面到底放进了哪些 scope。
      or(expr) { entry.or = expr; return link },
      in(col, vals) { (entry.in ??= {})[col] = vals; return link },
      lt(col, val) { (entry.lt ??= {})[col] = val; return link },
      not(col, op, val) { (entry.not ??= []).push({ col, op, val }); return link },
      // §12.3 的两段时间筛选：四个边界各自独立，测试要能分别看到订单管理接口把哪个列夹在了
      // 哪两个值之间。记成 map 而不是数组，因为同一列不会有两个同向边界。
      gte(col, val) { (entry.gte ??= {})[col] = val; return link },
      lte(col, val) { (entry.lte ??= {})[col] = val; return link },
      // range 是分页的落点。offset 算错在界面上表现为「第二页少一条」，是那种要有人数一遍才会
      // 发现的错，所以两个端点都记下来。
      range(from, to) { entry.range = { from, to }; return link },
      // 求值放在这里而不是上面：函数式给法要读 entry.filters，而那是 .eq() 之后才填好的。
      single: async () => resolveResult(),
      maybeSingle: async () => resolveResult(),
      then: (resolve, reject) => Promise.resolve(resolveResult()).then(resolve, reject)
    }
    return {
      insert(payload) { entry.op = 'insert'; entry.payload = payload; return link },
      update(payload) { entry.op = 'update'; entry.payload = payload; return link },
      // upsert 的第二个参数要记下来：收件箱靠 onConflict 走主键冲突更新，漏掉它会变成重复插入
      // 然后撞主键，而那是只有在「第二次读同一条通知」时才出现的错。
      upsert(payload, opts) { entry.op = 'upsert'; entry.payload = payload; entry.upsertOpts = opts; return link },
      // 第二个参数要记：订单列表靠 { count: 'exact' } 拿总数，漏掉它 total 会退化成「本页条数」，
      // 于是分页控件只画出一页，而后面还有几千条订单。
      select(cols, opts) { entry.op = 'select'; entry.selected = cols; entry.selectOpts = opts; return link }
    }
  }
  return rec
}
const lastCall = rec => rec.calls[rec.calls.length - 1]

// 站内信要先过校验再落库，因为数据库的 check 只能报出约束名。
const NOTIF_ROW = { id: 'n1', kind: 'system', scope: 'all', title: '标题', body: '正文' }
let ndb = recorder({ notifications: { data: NOTIF_ROW, error: null } })
const inserted = await insertNotification(ndb, { kind: 'system', scope: 'all', title: '标题', body: '正文' })
assert(inserted.id === 'n1', '插入后返回落库的行')
assert(lastCall(ndb).table === 'notifications' && lastCall(ndb).op === 'insert', '写 notifications 表')
let notifyThrew = ''
try { await insertNotification(recorder(), { kind: 'nope', scope: 'all', title: 't', body: 'b' }) }
catch (e) { notifyThrew = e.message }
assert(notifyThrew.includes('站内信不合法'), '不合法的站内信在打库之前就被拒')
assert(recorder().calls.length === 0, '被拒的站内信不该产生任何数据库调用')
// 站内信的写入失败必须抛。§10.3 的审批通知就是审批流程本身的载体，静默失败等于审批请求没发出去。
notifyThrew = ''
try { await insertNotification(recorder({ notifications: { data: null, error: { message: 'boom' } } }), NOTIF_ROW) }
catch (e) { notifyThrew = e.message }
assert(notifyThrew.includes('站内信写入失败'), '站内信写入失败必须抛，不能吞')

// 反过来，三个日志函数的失败必须被吞掉。一次成功的退款因为审计超时而回「失败」，用户会重试，
// 而重试可能真的退第二次。
//
// 下面几条断言会让 notify.mjs 往 stderr 打四行「写入失败」——那是被测行为本身（吞掉错误但留下
// 痕迹），不是测试出了问题。真正的失败会让整个套件以非零退出，而不是打一行日志。
const failing = table => recorder({ [table]: { data: null, error: { message: 'boom' } } })
assert(await logOrderStatus(failing('order_status_log'), { order_id: 'o1', from_status: 'paid', to_status: 'refund_pending' }) === false,
  '订单日志写失败返回 false 而不抛')
assert(await logRefundAction(failing('refund_audit_log'), { refund_id: 'r1', action: 'approve' }) === false,
  '退款审计写失败返回 false 而不抛')
assert(await logSessionEvent(failing('cs_session_events'), { session_id: 's1', kind: 'open' }) === false,
  '会话事件写失败返回 false 而不抛')

// 日志行的形状：缺省字段要落成空串/null，不能是 undefined——undefined 会被 PostgREST 丢掉，
// 于是 not null 的列用上默认值，而 source 的默认值未必是这次操作的真实来源。
ndb = recorder()
await logOrderStatus(ndb, { order_id: 'o1', from_status: 'paid', to_status: 'refund_pending', actor_group: 'admin', source: 'cs' })
let row = lastCall(ndb).payload
assert(row.actor_id === null && row.note === '', '缺省字段落成 null/空串')
assert(row.source === 'cs', 'source 必须原样带过去——同一个迁移有三个入口，责任归属不同')
assert(Object.values(row).every(v => v !== undefined), '任何字段都不能是 undefined')
ndb = recorder()
await logOrderStatus(ndb, { order_id: 'o1', from_status: 'paid', to_status: 'paid' })
assert(lastCall(ndb).payload.source === 'system', '没给 source 时落到 system')

// §10.2：改金额不改状态，但必须留痕，所以 from/to 允许为空而 amount_minor 要带上。
ndb = recorder()
await logRefundAction(ndb, { refund_id: 'r1', action: 'edit_amount', amount_minor: 5000, actor_group: 'cs' })
row = lastCall(ndb).payload
assert(row.from_status === '' && row.to_status === '', '改金额这类动作不改状态')
assert(row.amount_minor === 5000, '改后的金额必须进审计')
ndb = recorder()
await logRefundAction(ndb, { refund_id: 'r1', action: 'approve' })
assert(lastCall(ndb).payload.amount_minor === null, '没有金额时落 null 而不是 undefined')

// detail 必须是对象。传字符串进来会让 jsonb 列收到一个 JSON 字符串标量，之后统计查询取不到字段。
ndb = recorder()
await logSessionEvent(ndb, { session_id: 's1', kind: 'mode', detail: 'oops' })
assert(typeof lastCall(ndb).payload.detail === 'object', '非对象的 detail 落成空对象')

// settleApproval：并发保护全在过滤条件上。
ndb = recorder({ notifications: { data: [{ id: 'n1' }], error: null } })
const settled = await settleApproval(ndb, 'r1', 'approved', 'admin1')
assert(settled === 1, '真正做了决定的那次返回 1')
const upd = ndb.calls.find(c => c.table === 'notifications')
assert(upd.filters.refund_id === 'r1', '只动这条退款的通知')
assert(upd.filters.kind === 'refund_approval', '只动审批类通知，普通退款告知不该被改')
assert(upd.filters.state === 'pending', '只动还没被处理的——少了这条，第二个管理员也会以为自己做了决定')
assert(upd.payload.pinned === false && upd.payload.highlighted === false,
  '处理完要收掉置顶高亮，否则置顶位不再有意义')
assert(upd.payload.state === 'approved', '结果留在通知上')
assert(!('id' in upd.payload), '不能改通知的 id')
// 第二个管理员：影响 0 行，且不写审计——他没做决定。
ndb = recorder({ notifications: { data: [], error: null } })
assert(await settleApproval(ndb, 'r1', 'rejected', 'admin2') === 0, '慢的那次返回 0')
assert(!ndb.tables.includes('refund_audit_log'), '没做决定就不该留下一条决定的审计')
notifyThrew = ''
try { await settleApproval(recorder({ notifications: { data: null, error: { message: 'boom' } } }), 'r1', 'approved', 'a1') }
catch (e) { notifyThrew = e.message }
assert(notifyThrew.includes('审批状态回写失败'), '审批回写失败必须抛——它是审批流程的一部分')

// notifyUser 走 scope='user'，所以必须带 recipient_id，否则 schema 那条 check 会拒。
ndb = recorder({ notifications: { data: NOTIF_ROW, error: null } })
await notifyUser(ndb, 'u1', { title: '退款已完成', body: '款项已退回' })
row = lastCall(ndb).payload
assert(row.scope === 'user' && row.recipient_id === 'u1', 'scope 和 recipient_id 必须同时在')
assert(row.state === null, '给用户的告知不是待办事项，state 必须是 null 而不是 pending')

// setting()：缺键要给 fallback，不能让调用方各自猜默认值。
assert(await setting(recorder({ site_settings: { data: null, error: null } }), 'nope', 48) === 48, '缺键返回 fallback')
assert(await setting(recorder({ site_settings: { data: { value: { value: 24 } }, error: null } }), 'k', 48) === 24, '取 value.value')
assert(await setting(recorder({ site_settings: { data: { value: { value: false } }, error: null } }), 'k', true) === false,
  'false 是有效值，不能被当成缺失而落到 fallback')
assert(await setting(recorder({ site_settings: { data: { value: { value: 0 } }, error: null } }), 'k', 30) === 0,
  '0 同理——audit_log_retention_days 的 0 表示永久保留')
assert(await setting(recorder({ site_settings: { data: null, error: { message: 'boom' } } }), 'k', 48) === 48, '读失败也给 fallback')

console.log('Notification and audit writes: OK')

// --- §10.2 / §13.3 发起退款 ------------------------------------------------------------------------
// 这个接口跑在 service client 上，所以「谁的订单」「金额上限」「只允许一条在途」三件事全靠这里的
// 代码，没有 RLS 兜底。下面按这三条各钉一遍。
const BUYER = '33333333-3333-4333-8333-333333333333'
const AGENT = '44444444-4444-4444-8444-444444444444'
const RORDER = '55555555-5555-4555-8555-555555555555'
// 真 uuid 而不是 'r1'：审批通知的按钮 target 要过 uuid 校验，假数据得和真实的 refund.id 同形，
// 否则测试会在一个真实环境里不存在的地方失败。
const REFUND = '66666666-6666-4666-8666-666666666666'
const paidRow = {
  id: RORDER, user_id: BUYER, status: 'paid',
  amount_minor: 10000, paid_amount_minor: 9500, currency: 'USD', paid_currency: 'USD'
}
// 一个能跑通全程的 db：查订单 → 查在途申请（无）→ 插入 → 写审计 → 插通知。
const refundDb = (order = paidRow, existing = null, insert = { data: { id: REFUND }, error: null }) => recorder({
  orders: { data: order, error: null },
  refund_requests: [{ data: existing, error: null }, insert],
  notifications: { data: { id: 'n1' }, error: null }
})

let rdb = refundDb()
let out = await requestRefund(rdb, { userId: BUYER, group: 'default' }, {
  order_id: RORDER, reason_code: 'not_working', reason_detail: '装不上'
})
assert(out.status === 201, '用户给自己的已支付订单提退款应成功')
assert(out.body.notified === true, '审批通知发出去了')
let ins = rdb.calls.find(c => c.table === 'refund_requests' && c.op === 'insert').payload
assert(ins.status === 'pending', '新申请落在待审批')
assert(ins.initiator_role === 'user', '用户自己提的记成 user')
assert(ins.user_id === BUYER, 'user_id 记订单的主人，不是发起人——代提时这两者不同')
assert(ins.amount_minor === 9500, '没给金额时取实付金额，不是下单金额')
assert(ins.currency === 'USD', '币种跟实付走')
// 订单状态不能在这里被改。§13.3 规定审批通过才进 REFUND_PENDING。
assert(!rdb.calls.some(c => c.table === 'orders' && c.op === 'update'), '提交申请不改订单状态')
assert(!rdb.tables.includes('order_status_log'), '没有状态变更就不该写状态日志，否则 §12.4 里出现假条目')
assert(rdb.tables.includes('refund_audit_log'), '申请本身的痕迹要进审计')

// §10.2：原因必填。
for (const detail of ['', '   ', undefined, null]) {
  const answer = await requestRefund(refundDb(), { userId: BUYER, group: 'default' },
    { order_id: RORDER, reason_detail: detail })
  assert(answer.status === 400 && answer.body.error.includes('原因'), `空原因（${JSON.stringify(detail)}）应拒`)
}
// 订单号格式不对要答 400 而不是 500，同 cancel-order 的处理。
for (const badId of ['', null, 'not-a-uuid', "' or 1=1--", `${RORDER}x`]) {
  const answer = await requestRefund(refundDb(), { userId: BUYER, group: 'default' },
    { order_id: badId, reason_detail: '理由' })
  assert(answer.status === 400, `订单号 ${JSON.stringify(badId)} 应答 400`)
}

// 别人的订单：普通用户要拿到和「订单不存在」一模一样的答复，否则这就是个订单号探测接口。
const otherAnswer = await requestRefund(refundDb(), { userId: AGENT, group: 'default' },
  { order_id: RORDER, reason_detail: '理由' })
const missingAnswer = await requestRefund(refundDb(null), { userId: BUYER, group: 'default' },
  { order_id: RORDER, reason_detail: '理由' })
assert(otherAnswer.status === missingAnswer.status && otherAnswer.body.error === missingAnswer.body.error,
  '别人的订单和不存在的订单必须给同一个答复')
assert(otherAnswer.status === 404, '两者都是 404')

// §10.7：代提。售前不在名单里，尽管 rank 和售后相同。
for (const group of ['postsale', 'cs', 'admin']) {
  const answer = await requestRefund(refundDb(), { userId: AGENT, group }, { order_id: RORDER, reason_detail: '客诉' })
  assert(answer.status === 201, `${group} 可以代提`)
}
for (const group of ['presale', 'coworker', 'read', 'default']) {
  const answer = await requestRefund(refundDb(), { userId: AGENT, group }, { order_id: RORDER, reason_detail: '客诉' })
  assert(answer.status === 404, `${group} 不能代提别人的订单`)
}
rdb = refundDb()
await requestRefund(rdb, { userId: AGENT, group: 'cs' }, { order_id: RORDER, reason_detail: '客诉' })
ins = rdb.calls.find(c => c.table === 'refund_requests' && c.op === 'insert').payload
assert(ins.initiator_role === 'cs' && ins.initiated_by === AGENT, '代提要记下是谁以什么身份提的')
assert(ins.user_id === BUYER, '代提时 user_id 仍是订单主人')

// §10.2 的金额上限。这条是整个接口里最贵的一条：过不了就是能退出比实付更多的钱。
const overAnswer = await requestRefund(refundDb(), { userId: AGENT, group: 'cs' },
  { order_id: RORDER, reason_detail: '理由', amount_minor: 9501 })
assert(overAnswer.status === 400 && overAnswer.body.error.includes('不得超过实付'), '超过实付金额必须拒')
// 上限是实付而不是下单金额——用了券的订单这两者不同，按下单金额退就是白送折扣那部分。
assert(paidRow.amount_minor > paidRow.paid_amount_minor, '这个用例的订单用过券，两个金额不同')
const listAnswer = await requestRefund(refundDb(), { userId: AGENT, group: 'cs' },
  { order_id: RORDER, reason_detail: '理由', amount_minor: 10000 })
assert(listAnswer.status === 400, '按下单金额退款必须被拒——差额就是券的折扣')
for (const amount of [0, -1, 95.5, '9500', NaN]) {
  const answer = await requestRefund(refundDb(), { userId: AGENT, group: 'cs' },
    { order_id: RORDER, reason_detail: '理由', amount_minor: amount })
  assert(answer.status === 400, `金额 ${JSON.stringify(amount)} 应拒`)
}
rdb = refundDb()
out = await requestRefund(rdb, { userId: AGENT, group: 'cs' },
  { order_id: RORDER, reason_detail: '只退一半', amount_minor: 4750 })
assert(out.status === 201, '合法的部分退款可以提')
assert(rdb.calls.find(c => c.table === 'refund_requests' && c.op === 'insert').payload.amount_minor === 4750, '部分金额落库')

// 用户不能自己挑金额，且必须是明确拒绝而不是静默忽略——静默忽略会让用户以为部分退款提上去了。
const userAmount = await requestRefund(refundDb(), { userId: BUYER, group: 'default' },
  { order_id: RORDER, reason_detail: '理由', amount_minor: 100 })
assert(userAmount.status === 403 && userAmount.body.error.includes('客服'), '用户指定金额要被明确拒绝')

// §14 的 refund_cs_can_edit_amount 开关：关掉时客服不能改，管理员不受影响。
const noEdit = table => recorder({
  orders: { data: paidRow, error: null },
  refund_requests: [{ data: null, error: null }, { data: { id: REFUND }, error: null }],
  notifications: { data: { id: 'n1' }, error: null },
  site_settings: { data: { value: { value: false } }, error: null }
})
const csBlocked = await requestRefund(noEdit(), { userId: AGENT, group: 'cs' },
  { order_id: RORDER, reason_detail: '理由', amount_minor: 4000 })
assert(csBlocked.status === 403 && csBlocked.body.error.includes('不允许客服修改'), '开关关掉时客服不能改金额')
const adminAllowed = await requestRefund(noEdit(), { userId: AGENT, group: 'admin' },
  { order_id: RORDER, reason_detail: '理由', amount_minor: 4000 })
assert(adminAllowed.status === 201, '那个开关的字面意思是「客服是否可改」，管理员不受约束')
// 开关只在真要改金额时才读——不改金额的申请不该被一个无关开关挡住。
const untouched = noEdit()
await requestRefund(untouched, { userId: AGENT, group: 'cs' }, { order_id: RORDER, reason_detail: '理由' })
assert(!untouched.tables.includes('site_settings'), '不改金额时不必读那个开关')

// §13.2 的不可退状态。
for (const status of ['pending', 'failed', 'cancelled', 'refund_pending', 'refunded']) {
  const answer = await requestRefund(refundDb({ ...paidRow, status }), { userId: BUYER, group: 'default' },
    { order_id: RORDER, reason_detail: '理由' })
  assert(answer.status === 409, `${status} 的订单不能提退款`)
  assert(answer.body.error.length > 0, `${status} 要给出说明——§13.2 的悬浮文案就是这句`)
}

// 在途申请要拦住第二次提交。申请提交时订单还是 paid，所以光看订单状态查不出来。
for (const status of ['pending', 'approved', 'transferred', 'executing']) {
  const answer = await requestRefund(refundDb(paidRow, { id: 'r0', status }), { userId: BUYER, group: 'default' },
    { order_id: RORDER, reason_detail: '理由' })
  assert(answer.status === 409, `已有${status}的申请时不能再提`)
}
for (const status of ['rejected', 'completed']) {
  const answer = await requestRefund(refundDb(paidRow, { id: 'r0', status }), { userId: BUYER, group: 'default' },
    { order_id: RORDER, reason_detail: '理由' })
  assert(answer.status === 201, `${status} 的旧申请不该挡住新申请——§10.3 要求拒绝必须填理由，隐含理由被解决后可重提`)
}
// 并发：两个请求同时读到零行、同时插入，只有索引能挡住。23505 要翻译成 409 而不是 500。
const raced = await requestRefund(
  refundDb(paidRow, null, { data: null, error: { code: '23505', message: 'duplicate key' } }),
  { userId: BUYER, group: 'default' }, { order_id: RORDER, reason_detail: '理由' })
assert(raced.status === 409 && raced.body.error.includes('在途'), '唯一约束冲突要答 409')
const insFailed = await requestRefund(
  refundDb(paidRow, null, { data: null, error: { code: 'XX000', message: 'boom' } }),
  { userId: BUYER, group: 'default' }, { order_id: RORDER, reason_detail: '理由' })
assert(insFailed.status === 500, '其他写入错误仍是 500')

// 证据路径只做形状检查——归属由 storage 的 RLS 策略在上传时管。
const tooManyFiles = await requestRefund(refundDb(), { userId: BUYER, group: 'default' },
  { order_id: RORDER, reason_detail: '理由', evidence_paths: Array(11).fill('a/b.png') })
assert(tooManyFiles.status === 400, '证据文件数量要有上限')
const traversal = await requestRefund(refundDb(), { userId: BUYER, group: 'default' },
  { order_id: RORDER, reason_detail: '理由', evidence_paths: ['../../etc/passwd'] })
assert(traversal.status === 400, '带 .. 的路径要拒')
rdb = refundDb()
await requestRefund(rdb, { userId: BUYER, group: 'default' },
  { order_id: RORDER, reason_detail: '理由', evidence_paths: ['a/b.png', '', '  ', 'c/d.png'] })
assert(rdb.calls.find(c => c.table === 'refund_requests' && c.op === 'insert').payload.evidence_paths.length === 2,
  '空路径被过滤掉，不该留下空串')

// §10.3 的审批通知：插不进去时申请仍然算成功，但要如实告知。管理员还能从待审批列表看到。
const notifyBroken = recorder({
  orders: { data: paidRow, error: null },
  refund_requests: [{ data: null, error: null }, { data: { id: REFUND }, error: null }],
  notifications: { data: null, error: { message: 'boom' } }
})
out = await requestRefund(notifyBroken, { userId: BUYER, group: 'default' }, { order_id: RORDER, reason_detail: '理由' })
assert(out.status === 201 && out.body.notified === false, '通知失败不该让已落库的申请回报失败')
// 通知必须是 refund_approval，否则 §9.6 的强制置顶不会生效。
rdb = refundDb()
await requestRefund(rdb, { userId: BUYER, group: 'default' }, { order_id: RORDER, reason_detail: '装不上' })
const notif = rdb.calls.find(c => c.table === 'notifications' && c.op === 'insert').payload
assert(notif.kind === 'refund_approval' && notif.state === 'pending', '审批通知的类型和状态')
assert(notif.scope === 'admin' && notif.recipient_id === null, '发给全体管理员，不是某一个')
assert(notif.actions.length === 3, '三个按钮：批准、拒绝、转交')
assert(notif.body.includes('装不上'), '退款原因要出现在通知正文里，否则审批人得再点一次才能看到')

assert(orderNoOf(RORDER) === '55555555', '订单号取 id 前 8 位')
assert(orderNoOf(null) === '', 'id 缺失时不要渲染出 "null"')

console.log('Refund requests: OK')

// --- §10.3 批准退款 + §13.4 PAID → REFUND_PENDING ---------------------------------------------------
// 这一段的核心是并发：两个管理员同时点不同按钮时，只能有一个人的决定生效。保护全在 update 的
// .eq('status', …) 上，所以下面逐条钉住那些条件，以及「抢不到时不能继续往下写」。
const ADMIN1 = '77777777-7777-4777-8777-777777777777'
const pendingRefund = {
  id: REFUND, order_id: RORDER, user_id: BUYER, status: 'pending',
  amount_minor: 9500, currency: 'USD', reason_detail: '装不上', initiated_by: BUYER, initiator_role: 'user'
}
// 配置按 key 作答：二次确认默认开，自动执行默认关。
const settings = overrides => entry => {
  const key = entry.filters.key
  const table = { refund_require_second_confirm: true, refund_auto_execute: false, ...overrides }
  return { data: key in table ? { value: { value: table[key] } } : null, error: null }
}
const approveDb = (opts = {}) => recorder({
  refund_requests: [
    { data: opts.refund === undefined ? pendingRefund : opts.refund, error: null },
    { data: opts.moved === 0 ? [] : [{ id: REFUND, status: 'approved' }], error: null }
  ],
  orders: [
    { data: opts.order === undefined ? { ...paidRow, status: 'paid' } : opts.order, error: null },
    opts.orderMoveError
      ? { data: null, error: { message: 'boom' } }
      : { data: opts.orderMoved === 0 ? [] : [{ id: RORDER }], error: null }
  ],
  site_settings: settings(opts.settings),
  notifications: { data: [{ id: 'n1' }], error: null }
})

let adb = approveDb()
let ok = await approveRefund(adb, { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND, confirm: true })
assert(ok.status === 200, '管理员批准应成功')
assert(ok.body.status === 'approved' && ok.body.order_status === 'refund_pending', '§13.4 的两个状态')
assert(ok.body.amount_minor === 9500, '没改金额时沿用申请上的金额')
let refundUpd = adb.calls.find(c => c.table === 'refund_requests' && c.op === 'update')
assert(refundUpd.filters.status === 'pending', '申请的 update 必须要求它还在待审批——这是并发保护')
assert(refundUpd.filters.id === REFUND, '只动这一条申请')
assert(refundUpd.payload.decided_by === ADMIN1 && refundUpd.payload.decided_at, '记下是谁什么时候批的')
let orderUpd = adb.calls.find(c => c.table === 'orders' && c.op === 'update')
assert(orderUpd.filters.status === 'paid', '订单的 update 必须要求它还是已支付——§13.1')
assert(orderUpd.payload.status === 'refund_pending', '订单进退款中')
assert(!('paid_amount_minor' in orderUpd.payload) && !('amount_minor' in orderUpd.payload),
  '批准不该动订单金额——那会让实付金额和支付渠道的记录不一致')
// 状态日志要记成 §13.4 要求的那条边。
const statusLog = adb.calls.find(c => c.table === 'order_status_log').payload
assert(statusLog.from_status === 'paid' && statusLog.to_status === 'refund_pending', 'PAID → REFUND_PENDING')
assert(statusLog.source === 'admin', '来源是管理员，不是 system')

// 只有管理员能批。这里用名单而不是 rank，所以逐个组试一遍。
for (const group of ['cs', 'postsale', 'presale', 'coworker', 'read', 'default']) {
  const answer = await approveRefund(approveDb(), { userId: ADMIN1, group }, { refund_id: REFUND, confirm: true })
  assert(answer.status === 403, `${group} 不能批准退款`)
}
// 权限要在读库之前判掉，否则一个无权的人也能靠答复差异问出申请是否存在。
const early = approveDb()
await approveRefund(early, { userId: ADMIN1, group: 'cs' }, { refund_id: REFUND, confirm: true })
assert(early.calls.length === 0, '无权时不该产生任何数据库调用')

// §14 的强制二次确认：开着时缺 confirm 要拒，而且不能已经写过任何东西。
const unconfirmed = approveDb()
const needsConfirmAnswer = await approveRefund(unconfirmed, { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND })
assert(needsConfirmAnswer.status === 428 && needsConfirmAnswer.body.requires_confirm === true, '缺二次确认应拒')
assert(!unconfirmed.calls.some(c => c.op === 'update'), '被二次确认拦下时不能已经改了状态')
for (const bad of [false, 'true', 1, null, undefined]) {
  const answer = await approveRefund(approveDb(), { userId: ADMIN1, group: 'admin' },
    { refund_id: REFUND, confirm: bad })
  assert(answer.status === 428, `confirm=${JSON.stringify(bad)} 不算确认——只有布尔真才算`)
}
// 关掉开关时不需要 confirm。
const noConfirmNeeded = await approveRefund(approveDb({ settings: { refund_require_second_confirm: false } }),
  { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND })
assert(noConfirmNeeded.status === 200, '关掉开关后可以直接批准')

// 申请状态不对：只有待审批和已转交能进已批准（§10.4）。
for (const status of ['approved', 'rejected', 'executing', 'completed', 'failed']) {
  const answer = await approveRefund(approveDb({ refund: { ...pendingRefund, status } }),
    { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND, confirm: true })
  assert(answer.status === 409, `${status} 的申请不能再批准`)
}
const fromTransferred = await approveRefund(
  recorder({
    refund_requests: [{ data: { ...pendingRefund, status: 'transferred' }, error: null },
      { data: [{ id: REFUND }], error: null }],
    orders: [{ data: { ...paidRow, status: 'paid' }, error: null }, { data: [{ id: RORDER }], error: null }],
    site_settings: settings(), notifications: { data: [{ id: 'n1' }], error: null }
  }), { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND, confirm: true })
assert(fromTransferred.status === 200, '转交后的申请可以被接手的人批准')

// 订单状态不对：§13.1 只允许从 PAID 进退款中。
for (const status of ['pending', 'failed', 'cancelled', 'refund_pending', 'refunded']) {
  const answer = await approveRefund(approveDb({ order: { ...paidRow, status } }),
    { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND, confirm: true })
  assert(answer.status === 409, `订单是 ${status} 时不能批准退款`)
}
// 订单状态不对时不能已经把申请改成已批准——那会留下一条永远推不动的申请。
const badOrder = approveDb({ order: { ...paidRow, status: 'refunded' } })
await approveRefund(badOrder, { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND, confirm: true })
assert(!badOrder.calls.some(c => c.table === 'refund_requests' && c.op === 'update'),
  '订单不能迁移时，申请也不该被改动')

// 找不到申请 / 找不到订单 / 申请号格式不对。
const missingRefund = await approveRefund(approveDb({ refund: null }), { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, confirm: true })
assert(missingRefund.status === 404, '申请不存在答 404')
const missingOrder = await approveRefund(approveDb({ order: null }), { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, confirm: true })
assert(missingOrder.status === 404, '订单不存在答 404')
for (const badId of ['', null, 'nope', `${REFUND}x`]) {
  const answer = await approveRefund(approveDb(), { userId: ADMIN1, group: 'admin' },
    { refund_id: badId, confirm: true })
  assert(answer.status === 400, `申请号 ${JSON.stringify(badId)} 答 400`)
}

// 抢不到申请：另一个管理员先处理了。这时候绝对不能继续往下改订单。
const lost = approveDb({ moved: 0 })
const lostAnswer = await approveRefund(lost, { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND, confirm: true })
assert(lostAnswer.status === 409 && lostAnswer.body.error.includes('其他管理员'), '抢不到时告诉他谁快了一步')
assert(!lost.calls.some(c => c.table === 'orders' && c.op === 'update'),
  '抢不到申请就不能动订单——否则订单进了退款中却没有在途申请能推下去')
assert(!lost.tables.includes('order_status_log'), '也不该留下一条没发生的状态变更')

// 反过来：申请抢到了但订单没动。批准已经生效，所以不能报失败，但要如实说订单没动，并留痕。
const orderStuck = approveDb({ orderMoved: 0 })
const stuckAnswer = await approveRefund(orderStuck, { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, confirm: true })
assert(stuckAnswer.status === 200 && stuckAnswer.body.order_moved === false, '订单没动要如实报告')
assert(stuckAnswer.body.order_status === 'paid', '订单状态如实返回原值，不能假报 refund_pending')
assert(!orderStuck.tables.includes('order_status_log'), '没发生的迁移不写状态日志')
// 按 action 断言而不是数条数：数量会随着别处多写一条审计（比如 settleApproval 自己那条）
// 一起变，改一处要跟着改测试；而这里真正要保证的是「订单没动」这件事本身留下了痕迹。
const stuckActions = orderStuck.calls
  .filter(c => c.table === 'refund_audit_log').map(c => c.payload?.action)
assert(stuckActions.includes('approve'), '批准本身要留痕')
assert(stuckActions.includes('order_move_failed'),
  '订单没动要单独留一条审计——否则事后只能看到「批准了」，看不出订单为什么还在 PAID')
const orderBroken = approveDb({ orderMoveError: true })
const brokenAnswer = await approveRefund(orderBroken, { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, confirm: true })
assert(brokenAnswer.status === 200 && brokenAnswer.body.order_moved === false, '订单写入报错同样如实报告')

// §10.2：批准时可以改金额，上限仍是实付。
const reduced = approveDb()
const reducedAnswer = await approveRefund(reduced, { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, confirm: true, amount_minor: 5000 })
assert(reducedAnswer.body.amount_minor === 5000, '批准时改的金额要生效')
assert(reduced.calls.find(c => c.table === 'refund_requests' && c.op === 'update').payload.amount_minor === 5000,
  '改后的金额要落库，否则执行时按旧金额退')
const overCap = await approveRefund(approveDb(), { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, confirm: true, amount_minor: 9501 })
assert(overCap.status === 400, '批准时也不能超过实付金额')

// §9.6：那条审批通知要被收掉置顶。
const settled2 = adb.calls.find(c => c.table === 'notifications' && c.op === 'update')
assert(settled2 && settled2.payload.state === 'approved' && settled2.payload.pinned === false,
  '审批通知要留下结果并停止置顶')
// 通知回写失败不能让批准回滚——批准已经生效了。
const notifBroken = recorder({
  refund_requests: [{ data: pendingRefund, error: null }, { data: [{ id: REFUND }], error: null }],
  orders: [{ data: { ...paidRow, status: 'paid' }, error: null }, { data: [{ id: RORDER }], error: null }],
  site_settings: settings(), notifications: { data: null, error: { message: 'boom' } }
})
const stillOk = await approveRefund(notifBroken, { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND, confirm: true })
assert(stillOk.status === 200, '通知回写失败不影响批准结果')

// §14 的 refund_auto_execute 默认关：§13.4 要求「退款成功」是人手点的。
assert(ok.body.auto_execute === false, '自动执行默认关闭')
const autoOn = await approveRefund(approveDb({ settings: { refund_auto_execute: true } }),
  { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND, confirm: true })
assert(autoOn.body.auto_execute === true, '开关打开时如实告知调用方')

console.log('Refund approval: OK')

// ---------------------------------------------------------------------------
// §10.3 的拒绝，以及 §13.5 那条形状特别的日志。
//
// 拒绝的要点和批准正好相反：订单一个字都不能改，但订单变更记录里必须多一条 PAID → PAID。
// 这条日志看着像噪音，实际是用户在订单页上唯一能看到「我提过、被拒了、为什么」的地方。
const rejectDb = (opts = {}) => recorder({
  refund_requests: [
    { data: opts.refund === undefined ? pendingRefund : opts.refund, error: null },
    { data: opts.moved === 0 ? [] : [{ id: REFUND, status: 'rejected' }], error: null }
  ],
  orders: { data: opts.order === undefined ? { ...paidRow, status: 'paid' } : opts.order, error: null },
  site_settings: settings(opts.settings),
  notifications: opts.notifyError
    ? { data: null, error: { message: 'boom' } }
    : { data: [{ id: 'n2' }], error: null }
})

const rdb2 = rejectDb()
const rejected = await rejectRefund(rdb2, { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, note: '证据不足，请补一张报错截图' })
assert(rejected.status === 200 && rejected.body.status === 'rejected', '管理员可以拒绝')
assert(rejected.body.order_status === 'paid', '拒绝之后订单还是已支付')
assert(!rdb2.calls.some(c => c.table === 'orders' && c.op === 'update'),
  '拒绝不能改订单——§13.5 只要求记一条日志，不是一次迁移')
const rejLog = rdb2.calls.find(c => c.table === 'order_status_log').payload
assert(rejLog.from_status === 'paid' && rejLog.to_status === 'paid', '§13.5：写成 PAID → PAID')
assert(rejLog.note.includes('证据不足'), '理由要落到订单变更记录里，否则用户看不到为什么被拒')
assert(rejLog.source === 'admin', '来源是管理员')
const rejUpd = rdb2.calls.find(c => c.table === 'refund_requests' && c.op === 'update')
assert(rejUpd.filters.status === 'pending', '拒绝同样要求申请还在待审批——并发保护')
assert(rejUpd.payload.decision_note.includes('证据不足') && rejUpd.payload.decided_by === ADMIN1,
  '决定和决定人一起落库')
const rejAudit = rdb2.calls.filter(c => c.table === 'refund_audit_log').map(c => c.payload.action)
assert(rejAudit.includes('reject'), '拒绝要留痕')

// 理由必填，而且空白字符不算填。
for (const noteMissing of [undefined, null, '', '   ', '\n\t']) {
  const db = rejectDb()
  const answer = await rejectRefund(db, { userId: ADMIN1, group: 'admin' },
    { refund_id: REFUND, note: noteMissing })
  assert(answer.status === 400, `note=${JSON.stringify(noteMissing)} 应被拒——§10.3 要求必须填理由`)
  assert(!db.calls.some(c => c.op === 'update'), '理由没填时不能已经改了状态')
}
const tooLongNote = await rejectRefund(rejectDb(), { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, note: 'x'.repeat(2001) })
assert(tooLongNote.status === 400, '理由过长应拒')

// 拒绝不设二次确认门：它是可逆的（用户能重提），确认框要留给不可逆的操作。
const rejectNoConfirm = await rejectRefund(rejectDb(), { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, note: '不符合退款条件' })
assert(rejectNoConfirm.status === 200, '拒绝不需要 confirm')

for (const group of ['cs', 'postsale', 'presale', 'coworker', 'read', 'default']) {
  const db = rejectDb()
  const answer = await rejectRefund(db, { userId: ADMIN1, group }, { refund_id: REFUND, note: '不行' })
  assert(answer.status === 403, `${group} 不能拒绝退款`)
  assert(db.calls.length === 0, `${group} 被拒时不该产生任何数据库调用`)
}

// 抢不到就不能继续往下写：拒绝日志和通知都不该发出去。
const rejectLost = rejectDb({ moved: 0 })
const rejectLostAnswer = await rejectRefund(rejectLost, { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, note: '重复申请' })
assert(rejectLostAnswer.status === 409, '抢不到时告诉他谁快了一步')
assert(!rejectLost.tables.includes('order_status_log'), '没拒成就不该留下一条拒绝日志')
assert(!rejectLost.tables.includes('notifications'), '也不该通知用户一次没发生的拒绝')

for (const status of ['approved', 'rejected', 'executing', 'completed', 'failed']) {
  const answer = await rejectRefund(rejectDb({ refund: { ...pendingRefund, status } }),
    { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND, note: '不行' })
  assert(answer.status === 409, `${status} 的申请不能再拒绝`)
}

// §14 的 refund_auto_notify：关掉时静默跳过，但拒绝本身照样成立。
const quietReject = rejectDb({ settings: { refund_auto_notify: false } })
const quietAnswer = await rejectRefund(quietReject, { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, note: '不符合条件' })
assert(quietAnswer.status === 200 && quietAnswer.body.notified === false, '开关关掉时如实说没通知')
assert(!quietReject.calls.some(c => c.table === 'notifications' && c.op === 'insert'),
  '关掉之后确实没给用户写站内信')
// 开关只管给用户的那条，不该顺手把审批通知的回收也关掉——否则那条带按钮的通知永远置顶在
// 全体管理员的收件箱里，而它对应的申请已经被拒了。
assert(quietReject.calls.some(c => c.table === 'notifications' && c.op === 'update'),
  '审批通知照样要收掉：settleApproval 走 update，和 refund_auto_notify 无关')
// 通知写不进去也不能让拒绝失败——拒绝已经落库了。
const rejectNotifyBroken = await rejectRefund(rejectDb({ notifyError: true }),
  { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND, note: '不符合条件' })
assert(rejectNotifyBroken.status === 200 && rejectNotifyBroken.body.notified === false,
  '通知失败时拒绝仍然成立，只是如实报告没通知到')

console.log('Refund rejection: OK')

// ---------------------------------------------------------------------------
// §10.3 的转交。
//
// 这里最要紧的一条是「转交对象必须是管理员」：转给一个没有审批权的人，等于把申请扔进一个没人能
// 处理的地方，而它同时已经从原管理员的待办里消失了。那种卡死要等 48 小时超时才有人发现。
const ADMIN2 = '88888888-8888-4888-8888-888888888888'
const transferDb = (opts = {}) => recorder({
  refund_requests: [
    { data: opts.refund === undefined ? pendingRefund : opts.refund, error: null },
    { data: opts.moved === 0 ? [] : [{ id: REFUND, status: 'pending' }], error: null }
  ],
  orders: { data: { ...paidRow, status: 'paid' }, error: null },
  user_profiles: opts.receiverError
    ? { data: null, error: { message: 'boom' } }
    : { data: opts.receiver === undefined
      ? { user_id: ADMIN2, display_name: '老王', group_name: 'admin' }
      : opts.receiver, error: null },
  site_settings: settings(opts.settings),
  notifications: opts.notifyError
    ? { data: null, error: { message: 'boom' } }
    : { data: [{ id: 'n3' }], error: null }
})

const tdb = transferDb()
const transferred = await transferRefund(tdb, { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, transfer_to: ADMIN2, note: '这单涉及链上退款，交给你判断' })
assert(transferred.status === 200, '管理员可以转交')
// 落库状态是 pending 而不是 transferred：接手人要看到一条能直接审批的申请。
assert(transferred.body.status === 'pending', '转交后回到待审批，否则接手人没有可点的按钮')
assert(transferred.body.transferred_to === ADMIN2, '如实返回转给了谁')
const tUpd = tdb.calls.find(c => c.table === 'refund_requests' && c.op === 'update')
assert(tUpd.payload.status === 'pending', 'update 直接落 pending')
assert(tUpd.payload.transferred_to === ADMIN2, 'transferred_to 要落库——§10.6 的看板要能回答等谁')
assert(tUpd.filters.status === 'pending', '并发保护：要求申请还在原状态')
// 审计里两笔都要有，否则最后一笔和库里的状态不一致，而 §10.8 的导出拿审计当事实来源。
const tAudit = tdb.calls.filter(c => c.table === 'refund_audit_log').map(c => c.payload.action)
assert(tAudit.includes('transfer'), '转交本身要留痕')
assert(tAudit.includes('reopen_after_transfer'),
  '回到 pending 也要留痕——否则审计的最后一笔是 transferred，和库里的 pending 对不上')
const tNotif = tdb.calls.find(c => c.table === 'notifications' && c.op === 'insert').payload
assert(tNotif.recipient_id === ADMIN2 && tNotif.scope === 'user',
  '转交通知只发给接手人：再广播给全体管理员的话，转交和不转交没有区别')
assert(tNotif.state === 'pending' && tNotif.actions.length === 2, '接手人拿到批准和拒绝两个按钮')
assert(!tNotif.actions.some(a => a.type === 'transfer_refund'),
  '不给「再转交」按钮——48 小时超时是按申请算的，转多少次都不会重置')
assert(tNotif.body.includes('装不上'), '原始退款原因要带给接手人，否则他要从零判断')
// §9.6：这条带审批按钮的通知必须置顶高亮，而且这是 insertNotification 算的，不靠调用方传。
assert(tNotif.pinned === true && tNotif.highlighted === true,
  '§9.6 强制置顶高亮——之前 presentationFor 只有测试在调，插入路径漏了')

// 转交对象必须存在、必须是管理员。
const notAdmin = await transferRefund(transferDb({
  receiver: { user_id: ADMIN2, display_name: '客服小李', group_name: 'cs' }
}), { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND, transfer_to: ADMIN2, note: '交给你' })
assert(notAdmin.status === 400 && notAdmin.body.error.includes('管理员'),
  '不能转给非管理员——那条申请会卡在没人有权处理的地方')
const noReceiver = await transferRefund(transferDb({ receiver: null }),
  { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND, transfer_to: ADMIN2, note: '交给你' })
assert(noReceiver.status === 404, '转交对象不存在应拒')
const receiverBroken = await transferRefund(transferDb({ receiverError: true }),
  { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND, transfer_to: ADMIN2, note: '交给你' })
assert(receiverBroken.status === 500, '读不到转交对象时不能当成「不是管理员」也不能放行')
// 校验没过时申请一个字都不能改。
const rejectedTransfer = transferDb({ receiver: { user_id: ADMIN2, display_name: 'x', group_name: 'read' } })
await transferRefund(rejectedTransfer, { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, transfer_to: ADMIN2, note: '交给你' })
assert(!rejectedTransfer.calls.some(c => c.op === 'update'), '转交对象不合格时不能已经改了申请')

// transfer_to 的形状。
for (const badTarget of [undefined, null, '', 'not-a-uuid', 123, {}]) {
  const db = transferDb()
  const answer = await transferRefund(db, { userId: ADMIN1, group: 'admin' },
    { refund_id: REFUND, transfer_to: badTarget, note: '交给你' })
  assert(answer.status === 400, `transfer_to=${JSON.stringify(badTarget)} 应拒`)
  assert(db.calls.length === 0, '目标不合法时不该查库')
}
const selfTransfer = await transferRefund(transferDb(), { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, transfer_to: ADMIN1, note: '交给我自己' })
assert(selfTransfer.status === 400 && selfTransfer.body.error.includes('自己'),
  '转给自己是空操作，但会把自己的待办清掉再建一个，直接拒掉')

// 说明必填：接手人需要知道为什么轮到他。
for (const noteMissing of [undefined, null, '', '  ']) {
  const answer = await transferRefund(transferDb(), { userId: ADMIN1, group: 'admin' },
    { refund_id: REFUND, transfer_to: ADMIN2, note: noteMissing })
  assert(answer.status === 400, `转交说明 ${JSON.stringify(noteMissing)} 应拒`)
}

for (const group of ['cs', 'postsale', 'presale', 'coworker', 'read', 'default']) {
  const db = transferDb()
  const answer = await transferRefund(db, { userId: ADMIN1, group },
    { refund_id: REFUND, transfer_to: ADMIN2, note: '交给你' })
  assert(answer.status === 403, `${group} 不能转交退款`)
  assert(db.calls.length === 0, `${group} 被拒时不该产生任何数据库调用`)
}

const transferLost = transferDb({ moved: 0 })
const transferLostAnswer = await transferRefund(transferLost, { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, transfer_to: ADMIN2, note: '交给你' })
assert(transferLostAnswer.status === 409, '抢不到时告诉他谁快了一步')
assert(!transferLost.calls.some(c => c.table === 'notifications' && c.op === 'insert'),
  '抢不到就不能给接手人发通知——否则他收到一条已经被别人处理掉的申请')

for (const status of ['approved', 'rejected', 'executing', 'completed', 'failed']) {
  const answer = await transferRefund(transferDb({ refund: { ...pendingRefund, status } }),
    { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND, transfer_to: ADMIN2, note: '交给你' })
  assert(answer.status === 409, `${status} 的申请不能转交`)
}

// 通知发不出去不回滚：申请已经回到 pending 并记了 transferred_to，看板和超时提醒都还找得到它。
const transferNotifyBroken = await transferRefund(transferDb({ notifyError: true }),
  { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND, transfer_to: ADMIN2, note: '交给你' })
assert(transferNotifyBroken.status === 200 && transferNotifyBroken.body.notified === false,
  '通知失败时转交仍然成立，只是如实报告没通知到')

console.log('Refund transfer: OK')

// ---------------------------------------------------------------------------
// §13.4 的「退款成功」和状态图里的「无法退款」。
//
// 这一段钉的是钱的账实一致：订单和申请必须一起动，中间任何一步失败都不能留下「订单已退款、申请
// 却永远不会完结」或者反过来的组合。所以下面既测正常路径，也逐个测每一步失败时留下的状态。
const approvedRefund = { ...pendingRefund, status: 'approved', amount_minor: 9500 }
const execDb = (opts = {}) => recorder({
  refund_requests: [
    { data: opts.refund === undefined ? approvedRefund : opts.refund, error: null },
    // 第一次 update 是抢 executing，第二次是落终态。
    { data: opts.claimed === 0 ? [] : [{ id: REFUND, status: 'executing' }], error: null },
    { data: opts.settled === 0 ? [] : [{ id: REFUND }], error: null }
  ],
  orders: [
    { data: opts.order === undefined ? { ...paidRow, status: 'refund_pending' } : opts.order, error: null },
    opts.orderMoveError
      ? { data: null, error: { message: 'boom' } }
      : { data: opts.orderMoved === 0 ? [] : [{ id: RORDER }], error: null }
  ],
  site_settings: settings(opts.settings),
  notifications: opts.notifyError
    ? { data: null, error: { message: 'boom' } }
    : { data: [{ id: 'n4' }], error: null }
})

const edb = execDb()
const executed = await executeRefund(edb, { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, outcome: 'success', confirm: true })
assert(executed.status === 200, '管理员可以标记退款成功')
assert(executed.body.status === 'completed' && executed.body.order_status === 'refunded', '§13.4 的两个终态')
assert(executed.body.can_execute === false, '登记之后按钮消失')
const execUpds = edb.calls.filter(c => c.table === 'refund_requests' && c.op === 'update')
assert(execUpds.length === 2, '先抢 executing 再落终态，两次 update')
assert(execUpds[0].filters.status === 'approved' && execUpds[0].payload.status === 'executing',
  '第一步从已批准抢到执行中——这是并发保护')
assert(execUpds[1].filters.status === 'executing' && execUpds[1].payload.status === 'completed',
  '第二步从执行中落已完成')
const execOrderUpd = edb.calls.find(c => c.table === 'orders' && c.op === 'update')
assert(execOrderUpd.filters.status === 'refund_pending', '订单的 update 要求它还在退款中')
assert(execOrderUpd.payload.status === 'refunded', '订单进已退款')
assert(!('paid_amount_minor' in execOrderUpd.payload), '登记退款不改订单金额——账上实付过多少就是多少')
const execLog = edb.calls.find(c => c.table === 'order_status_log').payload
assert(execLog.from_status === 'refund_pending' && execLog.to_status === 'refunded', 'REFUND_PENDING → REFUNDED')
const execAudit = edb.calls.filter(c => c.table === 'refund_audit_log').map(c => c.payload.action)
assert(execAudit.includes('execute_claim') && execAudit.includes('execute_success'),
  '抢占和执行结果各留一条痕迹')
const doneNotif = edb.calls.find(c => c.table === 'notifications' && c.op === 'insert').payload
assert(doneNotif.recipient_id === BUYER && doneNotif.kind === 'refund', '退款结果通知发给下单的人')
assert(doneNotif.title.includes('退款已完成'), '成功时的标题')
assert(doneNotif.pinned === false, '这条只是告知，不该占住置顶位')

// 「无法退款」：订单回到 PAID，申请落 failed，而 §10.7 允许 failed 再回 executing，所以不是死路。
const failedOut = execDb()
const failedAnswer = await executeRefund(failedOut, { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, outcome: 'failed', note: '渠道不支持退款，已改为人工转账', confirm: true })
assert(failedAnswer.status === 200 && failedAnswer.body.status === 'failed', '可以标记无法退款')
assert(failedAnswer.body.order_status === 'paid', '无法退款时订单退回已支付')
const failedOrderUpd = failedOut.calls.find(c => c.table === 'orders' && c.op === 'update')
assert(failedOrderUpd.payload.status === 'paid', 'REFUND_PENDING → PAID')
const failedNotif = failedOut.calls.find(c => c.table === 'notifications' && c.op === 'insert').payload
assert(failedNotif.title.includes('退款未成功'), '失败时的标题')
assert(failedNotif.body.includes('渠道不支持'), '失败原因要写给用户，否则他只看到一句「未成功」')
// 失败原因必填，成功备注不必填。
for (const noteMissing of [undefined, null, '', '  ']) {
  const answer = await executeRefund(execDb(), { userId: ADMIN1, group: 'admin' },
    { refund_id: REFUND, outcome: 'failed', note: noteMissing, confirm: true })
  assert(answer.status === 400, `无法退款时 note=${JSON.stringify(noteMissing)} 应拒`)
}
const noNoteSuccess = await executeRefund(execDb(), { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, outcome: 'success', confirm: true })
assert(noNoteSuccess.status === 200, '标记成功不强制写备注')

// outcome 的形状。
for (const badOutcome of [undefined, null, '', 'ok', 'SUCCESS', 'completed', 1, {}]) {
  const db = execDb()
  const answer = await executeRefund(db, { userId: ADMIN1, group: 'admin' },
    { refund_id: REFUND, outcome: badOutcome, confirm: true })
  assert(answer.status === 400, `outcome=${JSON.stringify(badOutcome)} 应拒`)
  assert(db.calls.length === 0, 'outcome 不合法时不该查库')
}

// §14 的强制二次确认在这里必须过——这是不可逆操作，而浏览器弹框拦不住直接调接口的人。
const execConfirm = execDb()
const needsConfirm2 = await executeRefund(execConfirm, { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, outcome: 'success' })
assert(needsConfirm2.status === 428 && needsConfirm2.body.requires_confirm === true, '缺二次确认应拒')
assert(!execConfirm.calls.some(c => c.op === 'update'), '被确认拦下时一个字都没改')
for (const badConfirm of [false, 'true', 1, null]) {
  const answer = await executeRefund(execDb(), { userId: ADMIN1, group: 'admin' },
    { refund_id: REFUND, outcome: 'success', confirm: badConfirm })
  assert(answer.status === 428, `confirm=${JSON.stringify(badConfirm)} 不算确认`)
}
const noConfirm2 = await executeRefund(execDb({ settings: { refund_require_second_confirm: false } }),
  { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND, outcome: 'success' })
assert(noConfirm2.status === 200, '关掉开关后可以直接登记')

// 申请必须已批准。没批准就能登记退款成功，等于跳过整个审批流程。
for (const status of ['pending', 'transferred', 'rejected', 'completed']) {
  const answer = await executeRefund(execDb({ refund: { ...approvedRefund, status } }),
    { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND, outcome: 'success', confirm: true })
  assert(answer.status === 409, `${status} 的申请不能直接登记退款结果`)
}
// 上次失败的可以重试（§10.7 的 failed → executing）。
const retried = await executeRefund(execDb({ refund: { ...approvedRefund, status: 'failed' } }),
  { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND, outcome: 'success', confirm: true })
assert(retried.status === 200, '上次失败的退款可以重试，而不是让人另开一条申请丢掉审计链')

// 订单必须在 REFUND_PENDING。这一条不能靠「申请是 approved」推出来：批准时改订单那一步可能失败过，
// 那时申请已批准而订单还是 PAID，此时登记成功会把一笔没进退款流程的订单直接改成已退款。
for (const pendingOrder of ['paid', 'pending', 'refunded', 'cancelled', 'failed']) {
  const db = execDb({ order: { ...paidRow, status: pendingOrder } })
  const answer = await executeRefund(db, { userId: ADMIN1, group: 'admin' },
    { refund_id: REFUND, outcome: 'success', confirm: true })
  assert(answer.status === 409, `订单在 ${pendingOrder} 时不能登记退款结果`)
  assert(!db.calls.some(c => c.op === 'update'), `订单在 ${pendingOrder} 时不能已经改了申请`)
}

// 抢不到 executing：别人正在处理，什么都不能动。
const stuckExec = execDb({ claimed: 0 })
const stuckExecAnswer = await executeRefund(stuckExec, { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, outcome: 'success', confirm: true })
assert(stuckExecAnswer.status === 409, '抢不到时告诉他有人在处理')
assert(!stuckExec.calls.some(c => c.table === 'orders' && c.op === 'update'),
  '抢不到就不能动订单——否则订单变成已退款而这条申请从没执行过')
assert(!stuckExec.tables.includes('order_status_log'), '也不留状态日志')

// 抢到了但订单没改成：申请必须留在 executing，不能推到终态。终态 + 订单还在退款中，等于一笔钱
// 永久对不上而且没有入口能修。
for (const opts of [{ orderMoved: 0 }, { orderMoveError: true }]) {
  const db = execDb(opts)
  const answer = await executeRefund(db, { userId: ADMIN1, group: 'admin' },
    { refund_id: REFUND, outcome: 'success', confirm: true })
  assert(answer.status === 409, '订单没改成要报失败，因为这次登记没有生效')
  assert(answer.body.status === 'executing', '申请留在执行中，按钮还在，可以再点一次')
  const upds = db.calls.filter(c => c.table === 'refund_requests' && c.op === 'update')
  assert(upds.length === 1, '只有抢占那一次 update，不能把申请推到终态')
  assert(!db.tables.includes('order_status_log'), '订单没动就不写状态日志')
  assert(!db.calls.some(c => c.table === 'notifications' && c.op === 'insert'),
    '不能通知用户一次没有生效的退款')
  assert(db.calls.filter(c => c.table === 'refund_audit_log')
    .some(c => c.payload.action === 'execute_order_move_failed'), '这次失败要留痕')
}

// 订单改完了但申请落终态失败：账面是对的（订单已退款），申请停在 executing 由人工推完。
const halfSettled = await executeRefund(execDb({ settled: 0 }), { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, outcome: 'success', confirm: true })
assert(halfSettled.status === 200 && halfSettled.body.order_status === 'refunded',
  '订单已经改完，这次登记是生效的')
assert(halfSettled.body.status === 'executing', '申请没落终态就如实说它还在执行中')

for (const group of ['cs', 'postsale', 'presale', 'coworker', 'read', 'default']) {
  const db = execDb()
  const answer = await executeRefund(db, { userId: ADMIN1, group },
    { refund_id: REFUND, outcome: 'success', confirm: true })
  assert(answer.status === 403, `${group} 不能标记退款结果`)
  assert(db.calls.length === 0, `${group} 被拒时不该产生任何数据库调用`)
}

// §14 的 refund_auto_notify 关掉时静默跳过，但登记本身成立。
const quietExec = execDb({ settings: { refund_auto_notify: false } })
const quietExecAnswer = await executeRefund(quietExec, { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, outcome: 'success', confirm: true })
assert(quietExecAnswer.status === 200 && quietExecAnswer.body.notified === false, '如实说没通知')
assert(!quietExec.calls.some(c => c.table === 'notifications' && c.op === 'insert'), '确实没发')
const execNotifyBroken = await executeRefund(execDb({ notifyError: true }),
  { userId: ADMIN1, group: 'admin' }, { refund_id: REFUND, outcome: 'success', confirm: true })
assert(execNotifyBroken.status === 200 && execNotifyBroken.body.notified === false,
  '通知失败不能让一笔已经登记的退款报失败——那会让人再退一次')

console.log('Refund execution: OK')

// ---------------------------------------------------------------------------
// §9 的收件箱。
//
// 这一段里最重要的不是列表格式，是可见性。requireUser 交出来的是 service client，它绕过 RLS，
// 所以 schema.sql 里那个 private.can_see_notification() 在这条路径上一点作用都没有——判定必须由
// canSeeNotification() 在 JS 里做完。判错的后果不是报错，是有人读到了别人的收件箱，而那不会有
// 任何症状。所以下面先把 JS 的阈值和 SQL 函数的 case 分支对着钉死。
const scopeCase = schemaSql.match(
  /create or replace function private\.can_see_notification\(scope text, recipient uuid\)[\s\S]*?\$\$([\s\S]*?)\$\$/
)
assert(scopeCase, '找不到 private.can_see_notification 的定义——它是可见性的另一半')
assert(/when 'user' then recipient = \(select auth\.uid\(\)\)/.test(scopeCase[1]),
  'user 范围按收件人判，JS 那边也是比 recipient_id')
assert(/when 'admin' then \(select private\.is_admin\(\)\)/.test(scopeCase[1]), 'admin 范围走 is_admin')
assert(/when 'cs' then \(select private\.is_staff\(\)\)/.test(scopeCase[1]),
  'cs 范围走 is_staff——所以售前售后也算客服，JS 的阈值必须是 777 而不是 888')
assert(/when 'all' then true/.test(scopeCase[1]), 'all 范围人人可见')
// 两个 rank 阈值从 SQL 函数体里读出来，而不是照抄一份。
const staffSql = schemaSql.match(/function private\.is_staff\(\)[\s\S]*?my_rank\(\) >= (\d+)/)
const adminSql = schemaSql.match(/function private\.is_admin\(\)[\s\S]*?my_rank\(\) >= (\d+)/)
assert(Number(staffSql[1]) === NOTIFICATION_SCOPE_RANK.cs,
  `cs 范围的阈值两边要一致：SQL ${staffSql[1]}，JS ${NOTIFICATION_SCOPE_RANK.cs}`)
assert(Number(adminSql[1]) === NOTIFICATION_SCOPE_RANK.admin,
  `admin 范围的阈值两边要一致：SQL ${adminSql[1]}，JS ${NOTIFICATION_SCOPE_RANK.admin}`)
// SQL 里出现的每个 scope 都要在 JS 的列表里，反之亦然——多一个的方向是泄露。
const sqlScopes = [...scopeCase[1].matchAll(/when '(\w+)' then/g)].map(m => m[1])
for (const s of sqlScopes) assert(NOTIFICATION_SCOPES.includes(s), `SQL 有 scope ${s}，JS 没有`)
for (const s of NOTIFICATION_SCOPES) assert(sqlScopes.includes(s), `JS 有 scope ${s}，SQL 没有`)

// 逐个组核对能看到哪些广播范围。
assert(broadcastScopesFor(999).sort().join() === 'admin,all,cs', '管理员能看到全部三种广播')
assert(broadcastScopesFor(888).sort().join() === 'all,cs', 'cs 组看得到客服广播，看不到管理员广播')
assert(broadcastScopesFor(777).sort().join() === 'all,cs', '售前售后同样算客服')
assert(broadcastScopesFor(555).join() === 'all', '文案只看得到全站广播')
assert(broadcastScopesFor(111).join() === 'all', 'read 组同上')
assert(broadcastScopesFor(0).join() === 'all', '普通用户只看得到全站广播')
assert(!broadcastScopesFor(999).includes('user'), 'user 不是广播范围，不能靠 rank 拿到')

const OTHER = '99999999-9999-4999-8999-999999999999'
const mineRow = { id: '10000000-0000-4000-8000-000000000001', scope: 'user', recipient_id: BUYER, kind: 'order', title: 'a', body: 'b', state: null, actions: [], created_at: '2026-08-20T00:00:00Z' }
const theirRow = { id: '10000000-0000-4000-8000-000000000002', scope: 'user', recipient_id: OTHER, kind: 'order', title: 'a', body: 'b', state: null, actions: [], created_at: '2026-08-21T00:00:00Z' }
const adminRow = { id: '10000000-0000-4000-8000-000000000003', scope: 'admin', recipient_id: null, kind: 'refund_approval', title: 'a', body: 'b', state: 'pending', actions: [{ type: 'approve_refund', label: '批准', target: REFUND }], created_at: '2026-08-22T00:00:00Z' }
const csRow = { id: '10000000-0000-4000-8000-000000000004', scope: 'cs', recipient_id: null, kind: 'session', title: 'a', body: 'b', state: null, actions: [], created_at: '2026-08-23T00:00:00Z' }
const allRow = { id: '10000000-0000-4000-8000-000000000005', scope: 'all', recipient_id: null, kind: 'system', title: 'a', body: 'b', state: null, actions: [], created_at: '2026-08-24T00:00:00Z' }

// 逐条问 canSeeNotification，这是接口的最后一道防线。
assert(canSeeNotification(mineRow, BUYER, 0) === true, '自己的通知自己看得见')
assert(canSeeNotification(mineRow, OTHER, 999) === false,
  '别人的私信管理员也看不见——rank 再高也不该越过 user 范围')
assert(canSeeNotification(theirRow, BUYER, 777) === false, '不是发给我的就看不见')
assert(canSeeNotification(adminRow, BUYER, 999) === true, '管理员看得见管理员广播')
assert(canSeeNotification(adminRow, BUYER, 888) === false, 'cs 组看不见管理员广播')
assert(canSeeNotification(csRow, BUYER, 777) === true, '售后看得见客服广播')
assert(canSeeNotification(csRow, BUYER, 555) === false, '文案看不见客服广播')
assert(canSeeNotification(allRow, BUYER, 0) === true, '全站广播人人可见')
assert(canSeeNotification({ scope: 'user', recipient_id: null }, null, 999) === false,
  'recipient_id 和 userId 都为空时不能算匹配——一个 == 就会让所有匿名比较都通过')
assert(canSeeNotification({ scope: 'user', recipient_id: undefined }, undefined, 999) === false, '同上')
assert(canSeeNotification({ scope: 'nonsense', recipient_id: null }, BUYER, 999) === false,
  '未知范围默认看不见，而不是默认可见')
assert(canSeeNotification(null, BUYER, 999) === false, '空行看不见')

const receiptsFor = rows => ({ data: rows, error: null })
const inboxDb = (notifRows, receiptRows = []) => recorder({
  notifications: { data: notifRows, error: null },
  notification_receipts: receiptsFor(receiptRows),
  site_settings: settings()
})

// 列表：库里混着别人的私信时也不能漏出去。
const listDb = inboxDb([mineRow, theirRow, adminRow, csRow, allRow])
const listed = await listNotifications(listDb, { userId: BUYER, group: 'default', rank: 0 }, {})
const listedIds = listed.body.items.map(n => n.id)
assert(listed.status === 200, '列表可读')
assert(listedIds.includes(mineRow.id) && listedIds.includes(allRow.id), '自己的和全站的都在')
assert(!listedIds.includes(theirRow.id), '别人的私信不能出现在我的列表里')
assert(!listedIds.includes(adminRow.id) && !listedIds.includes(csRow.id),
  '普通用户拿不到管理员和客服广播——就算 or 条件写漏了，最后那次 filter 也要挡住')
// or 条件里放进去的 scope 必须来自 broadcastScopesFor，不能是手写的。
const listQuery = listDb.calls.find(c => c.table === 'notifications')
assert(listQuery.or.includes(`recipient_id.eq.${BUYER}`), '查询里带上自己的收件人条件')
assert(listQuery.or.includes('scope.in.(all)'), '普通用户的 or 里只有 all')
assert(!listQuery.or.includes('admin'), '普通用户的查询条件里不该出现 admin')
const adminList = inboxDb([mineRow, adminRow, csRow, allRow])
const adminListed = await listNotifications(adminList, { userId: BUYER, group: 'admin', rank: 999 }, {})
assert(adminListed.body.items.length === 4, '管理员看得到自己的和三种广播')
assert(adminList.calls.find(c => c.table === 'notifications').or.includes('cs'),
  '管理员的 or 里要包含 cs——否则客服广播对管理员不可见，而 is_staff 说它可见')

// 排序：置顶优先，再按时间倒序。§9.6 要求待审批的一直挡在眼前，读过了也不许沉下去。
assert(adminList.calls.find(c => c.table === 'notifications').orders.length === 2, '两级排序')
assert(adminList.calls.find(c => c.table === 'notifications').orders[0].col === 'pinned',
  '第一级按置顶——§9.6')
assert(adminList.calls.find(c => c.table === 'notifications').orders[0].ascending === false, '置顶的在前')
// pinned 是重算的，不是读库里的列：库里那两列在 settleApproval 之后会被收掉。
const pinnedItem = adminListed.body.items.find(n => n.id === adminRow.id)
assert(pinnedItem.pinned === true && pinnedItem.highlighted === true,
  '带审批按钮且待处理的要置顶高亮')
const plainItem = adminListed.body.items.find(n => n.id === allRow.id)
assert(plainItem.pinned === false, '普通通知不占置顶位')

// 已读状态来自 receipts；没有 receipt 行的一律算未读。
const readMix = inboxDb([mineRow, allRow], [
  { notification_id: mineRow.id, read_at: '2026-08-25T00:00:00Z', archived_at: null, dwell_ms: 2100 }
])
const mixed = await listNotifications(readMix, { userId: BUYER, group: 'default', rank: 0 }, {})
assert(mixed.body.items.find(n => n.id === mineRow.id).read === true, '有 read_at 就是已读')
assert(mixed.body.items.find(n => n.id === allRow.id).read === false,
  '没有 receipt 行的广播算未读——广播在没人碰过之前根本没有那一行')
assert(mixed.body.unread === 1, '未读数不能只查 receipts，否则恒为 0')
// receipts 查询必须按自己的 user_id 收窄。
const receiptQuery = readMix.calls.find(c => c.table === 'notification_receipts')
assert(receiptQuery.filters.user_id === BUYER, '只读自己的已读记录')
assert(Array.isArray(receiptQuery.in.notification_id), '按这一页的 id 收窄，不是全表拉回来')

// 归档过的默认不出现，带 archived=true 时单独看。
const archivedMix = inboxDb([mineRow, allRow], [
  { notification_id: mineRow.id, read_at: null, archived_at: '2026-08-25T00:00:00Z', dwell_ms: 0 }
])
const openOnly = await listNotifications(archivedMix, { userId: BUYER, group: 'default', rank: 0 }, {})
assert(openOnly.body.items.length === 1 && openOnly.body.items[0].id === allRow.id,
  '归档过的默认不出现，否则手动归档等于没用')
const archivedOnly = await listNotifications(
  inboxDb([mineRow, allRow], [{ notification_id: mineRow.id, read_at: null, archived_at: 'x', dwell_ms: 0 }]),
  { userId: BUYER, group: 'default', rank: 0 }, { archived: 'true' })
assert(archivedOnly.body.items.length === 1 && archivedOnly.body.items[0].id === mineRow.id,
  'archived=true 时只看归档的')

// 分页上限：limit 要被夹住，否则一个请求能把整张表拉走。
const bigLimit = inboxDb([allRow])
await listNotifications(bigLimit, { userId: BUYER, group: 'default', rank: 0 }, { limit: 9999 })
assert(bigLimit.calls.find(c => c.table === 'notifications').limit === 100, 'limit 上限 100')
const zeroLimit = inboxDb([allRow])
await listNotifications(zeroLimit, { userId: BUYER, group: 'default', rank: 0 }, { limit: 0 })
assert(zeroLimit.calls.find(c => c.table === 'notifications').limit === 20, 'limit=0 退回默认值')
const beforeDb = inboxDb([allRow])
await listNotifications(beforeDb, { userId: BUYER, group: 'default', rank: 0 }, { before: '2026-08-24T00:00:00Z' })
assert(beforeDb.calls.find(c => c.table === 'notifications').lt.created_at === '2026-08-24T00:00:00Z',
  'before 走 created_at 的 lt')

// 未读数：待处理要单独给一个数，否则全读过之后那三条等着批的退款不再提醒任何人。
const countDb = inboxDb([mineRow, adminRow, allRow], [
  { notification_id: adminRow.id, read_at: '2026-08-25T00:00:00Z', archived_at: null }
])
const counted = await unreadCount(countDb, { userId: BUYER, group: 'admin', rank: 999 })
assert(counted.body.unread === 2, '两条没读')
assert(counted.body.pending === 1, '读过但没处理的仍然算待处理')
const countArchived = await unreadCount(
  inboxDb([adminRow], [{ notification_id: adminRow.id, read_at: null, archived_at: 'x' }]),
  { userId: BUYER, group: 'admin', rank: 999 })
assert(countArchived.body.unread === 0 && countArchived.body.pending === 0, '归档过的不再计数')

// 标记已读：只能标自己看得见的。
const readDb = inboxDb([mineRow])
const readAnswer = await markRead(readDb, { userId: BUYER, group: 'default', rank: 0 },
  { ids: [mineRow.id], dwell_ms: 2100 })
assert(readAnswer.status === 200 && readAnswer.body.marked === 1, '标记成功')
const upsertCall = readDb.calls.find(c => c.table === 'notification_receipts' && c.op === 'upsert')
assert(upsertCall.upsertOpts.onConflict === 'notification_id,user_id',
  'upsert 要走主键冲突更新——广播在第一次被读之前没有那一行，先查后插会有并发缝')
assert(upsertCall.payload[0].user_id === BUYER && upsertCall.payload[0].read_at, '记下是谁什么时候读的')
assert(upsertCall.payload[0].dwell_ms === 2100, '§9.7 的停留时长要留下痕迹，两条触发路径要能分辨')
const dwellBad = inboxDb([mineRow])
await markRead(dwellBad, { userId: BUYER, group: 'default', rank: 0 }, { ids: [mineRow.id], dwell_ms: -5 })
assert(dwellBad.calls.find(c => c.op === 'upsert').payload[0].dwell_ms === 0, '负的停留时长归零')

// 标别人的通知：不能生效，而且不能靠答复差异问出那条通知存在。
const stealRead = inboxDb([theirRow])
const stolen = await markRead(stealRead, { userId: BUYER, group: 'default', rank: 0 }, { ids: [theirRow.id] })
assert(stolen.status === 404, '标不了别人的通知')
assert(!stealRead.calls.some(c => c.op === 'upsert'),
  '看不见就不能写 receipt——那不只是越权，还会让对方永远收不到那条提醒')
const mixedRead = inboxDb([mineRow, theirRow])
const partialAnswer = await markRead(mixedRead, { userId: BUYER, group: 'default', rank: 0 },
  { ids: [mineRow.id, theirRow.id] })
assert(partialAnswer.body.marked === 1 && partialAnswer.body.skipped === 1, '混着给时只标看得见的')
assert(mixedRead.calls.find(c => c.op === 'upsert').payload.length === 1, '写进去的只有一条')
for (const badIds of [undefined, null, [], ['x'], [123], {}]) {
  const answer = await markRead(inboxDb([mineRow]), { userId: BUYER, group: 'default', rank: 0 },
    { ids: badIds })
  assert(answer.status === 400, `ids=${JSON.stringify(badIds)} 应拒`)
}
const singleId = await markRead(inboxDb([mineRow]), { userId: BUYER, group: 'default', rank: 0 },
  { id: mineRow.id })
assert(singleId.status === 200, '单条也能标，不必包成数组')
const tooManyIds = await markRead(inboxDb([mineRow]), { userId: BUYER, group: 'default', rank: 0 },
  { ids: Array.from({ length: 101 }, () => mineRow.id) })
assert(tooManyIds.status === 400, '一次最多 100 条')

// 归档：待处理的不许归档，否则等于绕过 §9.6 的强制置顶。
const archDb = inboxDb([mineRow])
const archAnswer = await archiveNotifications(archDb, { userId: BUYER, group: 'default', rank: 0 },
  { ids: [mineRow.id] })
assert(archAnswer.status === 200 && archAnswer.body.archived === 1, '普通通知可以归档')
assert(archDb.calls.find(c => c.op === 'upsert').payload[0].archived_at, '记下归档时间')
const archPending = inboxDb([adminRow])
const blockedArch = await archiveNotifications(archPending, { userId: BUYER, group: 'admin', rank: 999 },
  { ids: [adminRow.id] })
assert(blockedArch.status === 409, '待处理的不许归档')
assert(!archPending.calls.some(c => c.op === 'upsert'), '被拦下时不写 receipt')
const stealArch = await archiveNotifications(inboxDb([theirRow]),
  { userId: BUYER, group: 'default', rank: 0 }, { ids: [theirRow.id] })
assert(stealArch.status === 404, '归档不了别人的通知')
const undoArch = inboxDb([mineRow])
const restored = await archiveNotifications(undoArch, { userId: BUYER, group: 'default', rank: 0 },
  { ids: [mineRow.id], undo: true })
assert(restored.body.restored === 1, '可以取消归档')
assert(undoArch.calls.find(c => c.op === 'upsert').payload[0].archived_at === null, '取消归档是把时间清空')

// or 条件是拼串，所以拼进去的 userId 必须先过形状校验。带逗号或右括号的值能改写整条过滤器，
// 而那条过滤器就是可见性判定。
for (const badUser of ['1,scope.eq.admin', 'x) or (true', '', null, undefined, 'not-a-uuid']) {
  const db = inboxDb([allRow])
  const answer = await listNotifications(db, { userId: badUser, group: 'default', rank: 0 }, {})
  assert(answer.status === 400, `userId=${JSON.stringify(badUser)} 不该被拼进 or 条件`)
  assert(db.calls.length === 0, '形状不对时一次库都不查')
  const counted2 = await unreadCount(inboxDb([allRow]), { userId: badUser, group: 'default', rank: 0 })
  assert(counted2.status === 400, '未读数那条路径同样要挡')
}

// §14：停留阈值必须由服务端给，前端写死 2000 的话管理员改了配置也不生效。
const inboxSet = await inboxSettings(recorder({
  site_settings: settings({
    notification_auto_archive_days: 45, notification_read_dwell_ms: 3500,
    notification_notify_browser: true, notification_notify_email: false
  })
}))
assert(inboxSet.body.auto_archive_days === 45 && inboxSet.body.read_dwell_ms === 3500, '配置如实返回')
assert(inboxSet.body.notify_browser === true && inboxSet.body.notify_email === false,
  '两个开关是独立的，可以同时开')

console.log('Notification inbox: OK')

// --- api/admin-orders.mjs (§12) ---------------------------------------------------------------------
// 这个接口的门槛是 rank ≥ 111，比其他所有订单接口都低（§12.2 确认过是有意的）。于是「返回了什么列」
// 变成一个安全问题而不只是功能问题：脱敏是这里唯一的保护，RLS 表达不了「这一列要打码」。

// 邮箱脱敏：首尾留字符、域名不遮。留中间几位等于没打，全打成星号则客服没法在电话里核对身份。
assert(maskEmail('zhangsan@example.com') === 'z******n@example.com', '中间遮掉，首尾和域名留着')
assert(maskEmail('ab@x.io') === 'a*@x.io', '两个字符的用户名也要遮掉一个')
assert(maskEmail('') === '', '空值不要变成一串星号')
assert(maskEmail('nobody-at-all') === 'n******l', '没有 @ 的字符串按普通文本遮')
assert(!maskEmail('zhangsan@example.com').includes('zhangsan'), '脱敏后不能还能读出原用户名')

// CSV：Excel 会把 = + - @ 开头的单元格当公式执行，而 sku_name / display_name 都是别处写入的可控字段。
{
  const csv = toCsv([{ a: '=cmd|calc', b: '含"引号"', c: '逗号,在里面' }], [
    { title: '列A', pick: r => r.a }, { title: '列B', pick: r => r.b }, { title: '列C', pick: r => r.c }
  ])
  assert(csv.startsWith('﻿'), '要有 BOM，否则 Excel 用本地代码页读 UTF-8，中文全是乱码')
  assert(csv.includes('"\'=cmd|calc"'), '以 = 开头的值要前置单引号，否则 Excel 当公式执行')
  assert(csv.includes('"含""引号"""'), '内部引号翻倍')
  assert(csv.includes('"逗号,在里面"'), '带逗号的值靠引号包住，不能把一格拆成两格')
  assert(csv.includes('\r\n'), 'CRLF 换行——Excel 对 LF-only 的 CSV 有时把整表读成一行')
}

const ORDER_AT = '2026-08-20T09:00:00Z'
const ORDER_ROW = {
  id: '11111111-2222-3333-4444-555555555555', user_id: BUYER, sku: 'aetherac-pro', sku_name: 'AetherAC 专业版',
  quantity: 1, status: 'paid', provider: 'payerurl', provider_order_id: 'PU-9', payment_reference: 'PAY-77',
  amount_minor: 9500, list_amount_minor: 12000, discount_minor: 2500, paid_amount_minor: 9500,
  currency: 'USD', paid_currency: 'USD', coupon_code: 'WELCOME', created_at: ORDER_AT, paid_at: ORDER_AT, updated_at: ORDER_AT
}
const ordersDb = (opts = {}) => recorder({
  orders: opts.orders ?? { data: [ORDER_ROW], error: null, count: 137 },
  payment_providers: { data: [{ id: 'payerurl' }, { id: 'stripe' }], error: null },
  user_profiles: { data: [{ user_id: BUYER, email: 'zhangsan@example.com', display_name: '张三' }], error: null },
  order_status_log: { data: opts.logs ?? [], error: null },
  refund_requests: { data: opts.refunds ?? [], error: null },
  artifacts: { data: null, error: null },
  site_settings: settings(opts.config ?? {})
})

// 列表：筛选、分页、总数。
{
  const db = ordersDb()
  const out = await listOrders(db, {
    status: 'paid', provider: 'payerurl', created_from: '2026-08-01', created_to: '2026-08-31',
    paid_from: '2026-08-05', limit: '25', offset: '50'
  }, { pageSize: 20 })
  assert(out.status === 200, '合法筛选要通过')
  const q = db.calls.find(c => c.table === 'orders')
  assert(q.selectOpts?.count === 'exact', "总数靠 { count: 'exact' }，漏掉它分页控件只会画出一页")
  assert(q.filters.status === 'paid' && q.filters.provider === 'payerurl', '状态和渠道各自成为等值条件')
  assert(q.gte.created_at.startsWith('2026-08-01') && q.lte.created_at.startsWith('2026-08-31'),
    '下单时间两端都夹上')
  assert(q.gte.paid_at.startsWith('2026-08-05') && !(q.lte && 'paid_at' in q.lte),
    '只填了支付时间的下界，就只加下界——另一端不该被补成 now')
  assert(q.range.from === 50 && q.range.to === 74, 'offset 50 取 25 条是 [50,74]，不是 [50,75]')
  assert(out.body.total === 137, '总数来自 count，不是本页条数')
  assert(!q.selected.includes('provider_payload'),
    '列表不查回调原文：那里面有渠道塞进来的买家邮箱和 IP，而这个接口 rank 111 就能调')
}

// 分页上限：前端传一个大数不能变成整表导出。
{
  const db = ordersDb()
  const out = await listOrders(db, { limit: '99999' }, { pageSize: 20, cap: 200 })
  assert(out.body.limit === 200, 'limit 被 cap 夹住')
  assert(db.calls[0].range.to === 199, 'range 跟着 cap，而不是跟着请求里的数字')
  const dflt = ordersDb()
  await listOrders(dflt, {}, { pageSize: 20 })
  assert(dflt.calls[0].range.to === 19, '不传 limit 时用 §14 的 order_list_page_size')
}

// §12.3 精确搜索：三个搜索项，形状不对就在查库之前拒掉。
{
  const byOrder = ordersDb()
  await listOrders(byOrder, { search: ORDER_ROW.id, search_field: 'order_no' }, { pageSize: 20 })
  assert(byOrder.calls[0].filters.id === ORDER_ROW.id, '订单号搜的是 id 等值')

  const byPay = ordersDb()
  await listOrders(byPay, { search: 'PAY-77', search_field: 'payment_id' }, { pageSize: 20 })
  assert(byPay.calls[0].or === 'payment_reference.eq.PAY-77,provider_order_id.eq.PAY-77',
    '支付 ID 要同时查两列：老订单的流水号在 provider_order_id 里，只查一列就永远搜不到')

  // 模糊搜索会让任何组织成员用一个字母把全表捞出来，那是枚举。所以 like 一律不许出现。
  const shapes = [
    ['order_no', 'not-a-uuid'], ['user_id', '1'], ['payment_id', 'PAY,scope.eq.admin'],
    ['payment_id', 'x) or (true'], ['payment_id', 'a'.repeat(129)], ['nope', ORDER_ROW.id]
  ]
  for (const [field, value] of shapes) {
    const db = ordersDb()
    const bad = await listOrders(db, { search: value, search_field: field }, { pageSize: 20 })
    assert(bad.status === 400, `${field}=${String(value).slice(0, 20)} 要被拒`)
    assert(db.calls.length === 0, '拒掉的搜索不该已经查过库——拼进 or 的东西必须先确认形状')
  }
}

// 状态和渠道也要按名单校验：渠道 id 是 text 主键，形状不受控。
{
  const badStatus = await listOrders(ordersDb(), { status: 'refunded_maybe' }, { pageSize: 20 })
  assert(badStatus.status === 400, '未知状态被拒')
  const badProvider = await listOrders(ordersDb(), { provider: 'wechat' }, { pageSize: 20 })
  assert(badProvider.status === 400 && badProvider.body.error.includes('wechat'), '未知渠道被拒且指名')
}

// 详情（§12.5）：商品快照、变更记录、下一步。
{
  const db = ordersDb({
    orders: { data: ORDER_ROW, error: null },
    logs: [{ id: 1, from_status: 'pending', to_status: 'paid', source: 'callback', note: '', created_at: ORDER_AT }],
    refunds: [{ id: 'r1', status: 'pending', amount_minor: 9500, currency: 'USD' }]
  })
  const out = await orderDetail(db, ORDER_ROW.id, { canModify: true })
  assert(out.status === 200, '详情要能读出来')
  assert(out.body.order.user_email === 'z******n@example.com', '详情里的联系方式同样脱敏')
  assert(out.body.order.user_email !== 'zhangsan@example.com', '不能因为是管理员就返回原文')
  assert(out.body.line.name === 'AetherAC 专业版', '商品名取订单上的快照')
  assert(out.body.line.coupon_code === 'WELCOME', '§5：用了券就显示券码')
  assert(out.body.logs.length === 1 && out.body.refunds.length === 1, '变更记录和退款记录都带上')
  assert(out.body.open_refund?.id === 'r1', 'pending 的申请算在途——操作区要据此把退款按钮画灰')
  const next = out.body.next_statuses
  assert(next.length === 1 && next[0].status === 'refund_pending', 'paid 的下一步只有一个')
  assert(next[0].via_refund === true, '这一步得走退款流程，前端要据此不画成普通状态按钮')

  const missing = await orderDetail(ordersDb({ orders: { data: null, error: null } }), ORDER_ROW.id, { canModify: true })
  assert(missing.status === 404, '不存在的订单是 404')
  const malformed = await orderDetail(ordersDb(), 'not-a-uuid', { canModify: true })
  assert(malformed.status === 400, '格式不对在查库前拒掉')
}

// 商品快照为空时（早于快照列的历史订单）才回落到 artifacts。
{
  const legacy = { ...ORDER_ROW, sku_name: '', sku_description: '' }
  const db = recorder({
    orders: { data: legacy, error: null },
    user_profiles: { data: [], error: null },
    order_status_log: { data: [], error: null },
    refund_requests: { data: [], error: null },
    artifacts: { data: { name: '旧商品名', description: '旧描述' }, error: null }
  })
  const out = await orderDetail(db, ORDER_ROW.id, { canModify: false })
  assert(out.body.line.name === '旧商品名', '空快照回落到 artifacts')
  assert(out.body.can_modify === false, 'can_modify 如实传下去，前端据此画灰按钮而不是隐藏按钮')

  // 有快照时不许去查 artifacts：商品改名后回头看这笔订单必须还是当时那份。
  const fresh = ordersDb({ orders: { data: ORDER_ROW, error: null } })
  await orderDetail(fresh, ORDER_ROW.id, { canModify: true })
  assert(!fresh.tables.includes('artifacts'), '有快照就不查商品表，否则订单记录会跟着商品定义一起变')
}

// §12.5 状态变更：必填说明、非法迁移被拒、并发保护。
{
  const okDb = ordersDb({ orders: [{ data: { id: ORDER_ROW.id, status: 'pending' }, error: null }, { data: [{ id: ORDER_ROW.id, status: 'cancelled' }], error: null }] })
  const done = await updateOrderStatus(okDb, { userId: ADMIN1, group: 'admin' }, {
    order_id: ORDER_ROW.id, status: 'cancelled', note: '渠道超时，买家已确认放弃'
  })
  assert(done.status === 200 && done.body.from === 'pending', '合法迁移通过并回报原状态')
  const upd = okDb.calls.find(c => c.table === 'orders' && c.op === 'update')
  assert(upd.filters.status === 'pending',
    "update 上要带 .eq('status', 原状态)——支付回调也在改这张表，不是只有两个人同时点才会撞")
  const logged = okDb.calls.find(c => c.table === 'order_status_log')
  assert(logged?.payload.source === 'admin' && logged.payload.note.includes('渠道超时'),
    '§12.4：来源记成 admin，说明原样入库')
  assert(logged.payload.actor_group === 'admin', '记下操作人所在的组，否则事后分不清是谁改的')

  const noNote = await updateOrderStatus(ordersDb(), { userId: ADMIN1, group: 'admin' }, { order_id: ORDER_ROW.id, status: 'cancelled' })
  assert(noNote.status === 400 && noNote.body.error.includes('变更说明'), '§12.5：说明必填')

  const illegal = await updateOrderStatus(
    ordersDb({ orders: { data: { id: ORDER_ROW.id, status: 'refunded' }, error: null } }),
    { userId: ADMIN1, group: 'admin' }, { order_id: ORDER_ROW.id, status: 'paid', note: '改回来' })
  assert(illegal.status === 409 && illegal.body.error.includes('终态'), '§12.5：非法迁移被拒且说明原因')

  // 抢不到行 = 别人先改了。这里必须是 409 而不是 200：返回 200 会让管理员以为改成功了。
  const raced = ordersDb({ orders: [{ data: { id: ORDER_ROW.id, status: 'pending' }, error: null }, { data: [], error: null }] })
  const lost = await updateOrderStatus(raced, { userId: ADMIN1, group: 'admin' }, {
    order_id: ORDER_ROW.id, status: 'failed', note: '渠道回报失败'
  })
  assert(lost.status === 409, '0 行受影响是 409')
  assert(!raced.tables.includes('order_status_log'), '没改动就不该留下一条说改了的审计')
}

// 退款相关的两个状态不能从订单详情直接点。放开等于给出一个「标成已退款但查不到申请」的入口。
for (const target of ['refund_pending', 'refunded']) {
  const db = ordersDb({ orders: { data: { id: ORDER_ROW.id, status: target === 'refunded' ? 'refund_pending' : 'paid' }, error: null } })
  const blocked = await updateOrderStatus(db, { userId: ADMIN1, group: 'admin' }, {
    order_id: ORDER_ROW.id, status: target, note: '手工改一下'
  })
  assert(blocked.status === 409 && blocked.body.error.includes('退款'),
    `${target} 必须走退款流程——直接改会绕过审批、二次确认和给用户的站内信`)
  assert(!db.tables.includes('order_status_log'), '被拒的操作不留审计')
}

// §12.4 导出：受 §14 的开关管，且有上限。
{
  const db = ordersDb({ orders: { data: [ORDER_ROW], error: null, count: 1 } })
  const out = await exportOrders(db, {}, { pageSize: 20 })
  assert(out.status === 200 && out.filename === `orders-${new Date().toISOString().slice(0, 10)}.csv`, '文件名带日期')
  assert(!/[0-9a-f]{8}-/.test(out.filename), '文件名里不放订单号或用户 ID：导出文件常常被直接转发')
  assert(out.csv.includes('z******n@example.com'), '导出的联系方式同样脱敏')
  assert(!out.csv.includes('zhangsan@example.com'), '导出是最容易外流的一份，绝不能带原始邮箱')
  assert(out.csv.includes('PAY-77') && out.csv.includes('WELCOME'), '§5 的支付 ID 和券码都在表里')
  assert(out.truncated === false, '没截断')

  const capped = await exportOrders(ordersDb({ orders: { data: [ORDER_ROW], error: null, count: 90000 } }), {}, { pageSize: 20 })
  assert(capped.truncated === true && capped.total === 90000,
    '被上限截断要如实说——否则拿着一份不完整的表去对账')

  const off = await exportOrders(ordersDb({ config: { order_export_enabled: false } }), {}, { pageSize: 20 })
  assert(off.status === 403, '开关关掉时是 403，不是一个空文件——空文件会被读成「这个月没订单」')
}

// 和 schema.sql 对齐：门槛数字和 §14 的键名都不许两边各写一份。
{
  const viewSql = schemaSql.match(/function private\.can_view_orders\(\)[\s\S]*?my_rank\(\) >= (\d+)/)
  assert(Number(viewSql[1]) === RANK.MEMBER,
    'can_view_orders 的阈值必须等于 RANK.MEMBER——SQL 松一档就是越权读，JS 松一档是界面能点接口报错')
  const updSql = schemaSql.match(/policy admin_orders_update on public\.orders[\s\S]{0,200}/)
  assert(/is_admin\(\)/.test(updSql[0]), 'orders 的 UPDATE 策略只给 admin，接口里的 canModify 跟着它')
  for (const key of ['order_list_page_size', 'order_export_enabled']) {
    assert(schemaSql.includes(`'${key}'`), `§14 的 ${key} 要在 schema 的 seed 里，否则配置界面改了也读不到`)
  }
  const logCols = schemaSql.match(/create table if not exists public\.order_status_log\(?[\s\S]*?\);/)
  for (const col of ['from_status', 'to_status', 'actor_group', 'source', 'note']) {
    assert(logCols[0].includes(col), `order_status_log 缺列 ${col}，logOrderStatus 写进去会报约束错`)
  }
  assert(/source .*check \(source in \([^)]*'admin'[^)]*\)\)/.test(logCols[0]),
    "source 的 check 里要有 'admin'，否则 §12.5 每次改状态都写不进审计")
}

console.log('Admin orders: OK')
