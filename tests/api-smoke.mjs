import handler from '../api/github-progress.mjs'
import usersHandler, { isBanned } from '../api/admin-users.mjs'
import {
  DRIVERS,
  approvalLink,
  decimalAmount,
  driverFor,
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

const stripeForm = stripeSessionForm(order, artifact, site)
assert(stripeForm instanceof URLSearchParams, 'Stripe only accepts application/x-www-form-urlencoded')
assert(stripeForm.get('line_items[0][price_data][unit_amount]') === '1999', 'unit_amount must stay the minor unit the artifacts table stores')
assert(stripeForm.get('line_items[0][price_data][currency]') === 'usd', 'Stripe rejects an upper-case currency')
assert(stripeForm.get('line_items[0][price_data][product_data][name]') === '入门版', 'the buyer must see the artifact name, not the SKU')
assert(stripeForm.get('client_reference_id') === order.id && stripeForm.get('metadata[order_id]') === order.id, 'the callback finds our order through client_reference_id / metadata')
assert(stripeForm.get('success_url') === `${site}/order/${order.id}?paid=1`, 'success_url must return to the order page')
assert(!stripeSessionForm(order, { name: 'x', description: '' }, site).has('line_items[0][price_data][product_data][description]'), 'Stripe rejects an empty description, so a blank one must be omitted')
assert(stripeSessionForm(order, null, site).get('line_items[0][price_data][product_data][name]') === order.sku, 'a missing artifact must fall back to the SKU rather than sending "undefined"')

const paypalBody = paypalOrderBody(order, artifact, site)
assert(paypalBody.intent === 'CAPTURE', 'the order must be capturable, otherwise the money never moves')
assert(paypalBody.purchase_units[0].amount.value === '19.99', 'PayPal wants a decimal string, not the minor unit')
assert(paypalBody.purchase_units[0].amount.currency_code === 'USD', 'PayPal rejects a lower-case currency code')
assert(paypalBody.purchase_units[0].custom_id === order.id, 'custom_id is how the webhook maps a PayPal order back to ours')
assert(paypalBody.payment_source.paypal.experience_context.return_url === `${site}/order/${order.id}?paid=1`, 'the buyer must land back on the order page')

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
assert(payerurlArgs.amount === 1999, "amount is the smallest unit — a decimal here would charge 19.99 cents for a 19.99 USD artifact")
assert(payerurlArgs.currency === 'usd', 'PayerURL lower-cases the currency')
assert(payerurlArgs.items[0].price === '19.99', "an item's price is a decimal string even though the order amount is not")
assert(payerurlArgs.items[0].name === '入门版_Starter', 'a space in an item name becomes an underscore')
assert(payerurlArgs.type === 'nodejs', 'the SDK identifies itself as nodejs')
// The whole request, byte for byte as the SDK builds it.
assert(
  payerurlQuery(payerurlArgs) === 'amount=1999&billing_email=buyer%40example.com&billing_fname=buyer&billing_lname=buyer'
    + '&cancel_url=https%3A%2F%2Faetherac.abnt.it%2Forder%2Fa1b2c3d4-0000-4000-8000-000000000001&currency=usd'
    + '&items%5B0%5D%5Bname%5D=%E5%85%A5%E9%97%A8%E7%89%88_Starter&items%5B0%5D%5Bqty%5D=1&items%5B0%5D%5Bprice%5D=19.99'
    + '&notify_url=https%3A%2F%2Faetherac.abnt.it%2Fv1%2Fcallback%2Fpayerurl&order_id=a1b2c3d4-0000-4000-8000-000000000001'
    + '&redirect_to=https%3A%2F%2Faetherac.abnt.it%2Forder%2Fa1b2c3d4-0000-4000-8000-000000000001%3Fpaid%3D1&type=nodejs',
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
