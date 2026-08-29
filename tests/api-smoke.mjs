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
