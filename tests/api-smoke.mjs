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
