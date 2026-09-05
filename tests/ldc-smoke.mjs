import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { decimalMinor, LDC_DEFAULTS, safeNext, validateLdcConfig } from '../shared/ldc.mjs'
import { ldcSign, paymentFields, queryLdc, verifyLdc, verifySettlement } from '../api/_lib/ldc.mjs'
import { linuxdoClaims } from '../api/_routes/linuxdo-userinfo.mjs'
import ldcHandler from '../api/_routes/ldc.mjs'
import notifyHandler from '../api/_routes/ldc-notify.mjs'
import checkoutHandler from '../api/_routes/checkout.mjs'

assert.equal(decimalMinor('0.01'), 1)
assert.equal(decimalMinor('10.1'), 1010)
assert.equal(decimalMinor('999999.99'), 99999999)
for (const input of ['1e2', '-1', '1.001', 'NaN', 'Infinity', '01', '', ' 1', '1&pid=x']) assert.throws(() => decimalMinor(input))
for (const next of ['//evil.invalid', '/\\evil.invalid', 'https://evil.invalid', '/\n/evil.invalid', 'javascript:alert(1)']) assert.equal(safeNext(next), '/me')
assert.equal(safeNext('/buy?coupon=LDC-123'), '/buy?coupon=LDC-123')
assert.deepEqual(linuxdoClaims({ id: 12, active: true, username: 'alice', api_key: 'never-return', email: 'ignored@example.com' }),
  { sub: '12', name: 'alice', preferred_username: 'alice' })
assert.throws(() => linuxdoClaims({ id: 0, active: true }))
assert.throws(() => linuxdoClaims({ id: 12, active: false }))
assert.throws(() => linuxdoClaims({ id: 12, active: true, silenced: true }))

const offer = { id: 'save-five', kind: 'discount', name: 'Save five', enabled: true,
  ldc_minor: 10000, discount_minor: 500, currency: 'USD', sku: 'PRO', valid_days: 30 }
const config = validateLdcConfig({ ...LDC_DEFAULTS, enabled: true, discount_enabled: true, coupon_enabled: true, support_enabled: true, offers: [offer] })
assert.equal(config.offers[0].discount_minor, 500)
for (const bad of [{ enabled: 'true' }, { support_max_minor: 0 }, { request_ttl_minutes: 0 }, { offers: [offer, offer] },
  { offers: [{ ...offer, sku: '' }] }, { offers: [{ ...offer, ldc_minor: 1.5 }] }, { offers: [{ ...offer, currency: '' }] }]) {
  assert.throws(() => validateLdcConfig(bad))
}
const fields = { pid: '001', name: 'Test', money: '10', type: 'epay', out_trade_no: 'M20250101' }
const canonical = 'money=10&name=Test&out_trade_no=M20250101&pid=001&type=epaysecret'
assert.equal(ldcSign(fields, 'secret'), createHash('md5').update(canonical).digest('hex'))
const signed = { ...fields, sign_type: 'MD5', sign: ldcSign(fields, 'secret') }
assert(verifyLdc(signed, 'secret'))
assert(!verifyLdc({ ...signed, money: '1' }, 'secret'))
assert(!verifyLdc({ ...signed, pid: 'other' }, 'secret'))
assert(!verifyLdc({ ...signed, sign_type: 'NONE' }, 'secret'))
assert(!verifyLdc({ ...signed, extra: ['array'] }, 'secret'))

const savedEnv = { ...process.env }, savedFetch = globalThis.fetch
const USER = '11111111-1111-4111-8111-111111111111'
const AGENT = '22222222-2222-4222-8222-222222222222'
const SESSION = '33333333-3333-4333-8333-333333333333'
const ORDER = '44444444-4444-4444-8444-444444444444'
const order = { id: ORDER, user_id: USER, requested_by: USER, kind: 'discount', name: 'Save five',
  ldc_minor: 10000, benefit: offer, status: 'pending', session_id: null,
  expires_at: new Date(Date.now() + 600000).toISOString(), consented_at: new Date().toISOString() }
const callback = { pid: '001', type: 'epay', out_trade_no: ORDER, trade_no: 'T123', money: '100.00', name: order.name, trade_status: 'TRADE_SUCCESS' }
assert(verifySettlement(callback, order, '001'))
for (const change of [{ money: '99.99' }, { money: '100.01' }, { type: 'alipay' }, { pid: '2' }, { trade_status: 'pending' }, { out_trade_no: USER }]) {
  assert(!verifySettlement({ ...callback, ...change }, order, '001'))
}

function response() {
  return { statusCode: 200, headers: {}, body: null,
    status(code) { this.statusCode = code; return this },
    setHeader(name, value) { this.headers[name] = value },
    send(body) { this.body = body; return this },
    json(body) { this.body = JSON.stringify(body); return this } }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
let calls = [], identity = USER, group = 'default', currentOrder = { ...order }, sessionAgent = AGENT
function mockFetch() {
  calls = []
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ url, method, body })
    if (url.hostname !== 'project.supabase.invalid') throw new Error(`Unexpected network: ${url.origin}`)
    if (url.pathname === '/auth/v1/user') return json({ id: identity, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} })
    if (url.pathname.endsWith('/user_profiles')) return json({ group_name: group })
    if (url.pathname.endsWith('/site_settings')) return json([{ key: 'ldc_config', value: { value: config } }, { key: 'linuxdo_enabled', value: { value: true } }])
    if (url.pathname.endsWith('/cs_sessions')) return json({ id: SESSION, user_id: USER, agent_id: sessionAgent, status: 'open', channel: 'presale' })
    if (url.pathname.endsWith('/artifacts')) return json({ id: USER, sku: 'PRO', name: 'Pro', price_minor: 2000, currency: 'USD' })
    if (url.pathname.endsWith('/payment_providers')) return json(null)
    if (url.pathname.endsWith('/orders')) return json(url.searchParams.has('status') ? null : [])
    if (url.pathname.endsWith('/coupons')) return json({ id: SESSION, code: 'FREE', name: 'Free coupon', enabled: true,
      conditions: [], actions: [{ type: 'fixed', value: 2000 }], allowed_user_ids: [USER], total_limit: 1, used_count: 0 })
    if (url.pathname.endsWith('/ldc_orders')) {
      if (method === 'GET') {
        if (url.searchParams.get('user_id') && url.searchParams.get('user_id') !== `eq.${currentOrder.user_id}`) return json(null)
        return json(currentOrder)
      }
      if (method === 'PATCH') {
        if (currentOrder.status !== 'pending' || (url.searchParams.has('consented_at') && currentOrder.consented_at)) return json(null)
        currentOrder = { ...currentOrder, ...body }
        return json(currentOrder)
      }
    }
    if (url.pathname.endsWith('/rpc/create_ldc_order')) return json({ ...order, kind: body.p_kind, user_id: body.p_user, ldc_minor: body.p_amount })
    if (url.pathname.endsWith('/rpc/complete_ldc_order')) return json({ ...order, status: 'paid', coupon_code: 'LDC-TEST' })
    if (url.pathname.endsWith('/rpc/checkout_zero_order')) return json({ id: ORDER, user_id: USER, status: 'paid', amount_minor: 0, checkout_url: null })
    throw new Error(`Unexpected request: ${method} ${url.pathname}`)
  }
}
async function api(body, options = {}) {
  const res = response()
  await ldcHandler({ method: 'POST', headers: { authorization: 'Bearer test-token' }, query: {}, body, ...options }, res)
  return { status: res.statusCode, data: JSON.parse(res.body) }
}
try {
  process.env.SUPABASE_URL = 'https://project.supabase.invalid'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
  process.env.LDC_CLIENT_ID = '001'; process.env.LDC_CLIENT_SECRET = 'secret'
  process.env.SITE_URL = 'https://aetherac.abnt.it'
  const pay = paymentFields(order)
  assert.equal(pay.money, '100.00')
  assert.equal(pay.notify_url, 'https://aetherac.abnt.it/api/ldc-notify')
  assert(verifyLdc(pay, 'secret'))
  assert(!JSON.stringify(pay).includes('secret'))

  mockFetch()
  assert.equal((await api({ action: 'create', offer_id: offer.id, amount: '0.01', discount_minor: 999999 })).status, 201)
  const created = calls.find(c => c.url.pathname.endsWith('/rpc/create_ldc_order')).body
  assert.equal(created.p_amount, 10000, 'The configured cost overrides client input')
  assert.equal(created.p_benefit.discount_minor, 500)
  assert.equal(created.p_user, USER)
  assert.equal((await api({ action: 'settings', config, linuxdo_enabled: true })).status, 403)
  assert.equal((await api({ action: 'pay', id: ORDER })).status, 400)
  const authorized = await api({ action: 'pay', id: ORDER, confirm: true })
  assert.equal(authorized.status, 200)
  assert.equal(authorized.data.action, 'https://credit.linux.do/epay/pay/submit.php')
  assert(!calls.some(c => c.url.hostname === 'credit.linux.do'), 'Consent prepares a form; it never charges from the API')
  assert.equal((await api({ action: 'decline', id: ORDER })).status, 409, 'Cannot promise cancellation after a form was issued')

  identity = AGENT; group = 'presale'; mockFetch()
  assert.equal((await api({ action: 'pay', id: ORDER, confirm: true })).status, 404, 'Staff cannot pay as the user')
  assert.equal((await api({ action: 'create', session_id: SESSION, amount: '12.34', name: 'Consulting' })).status, 201)
  const request = calls.find(c => c.url.pathname.endsWith('/rpc/create_ldc_order')).body
  assert.equal(request.p_user, USER)
  assert.equal(request.p_actor, AGENT)
  assert.equal(request.p_amount, 1234)
  sessionAgent = '55555555-5555-4555-8555-555555555555'
  assert.equal((await api({ action: 'create', session_id: SESSION, amount: '1', name: 'Other agent' })).status, 403)
  sessionAgent = AGENT
  assert.equal((await api({ action: 'create', session_id: SESSION, amount: '9999999', name: 'Over limit' })).status, 400)

  identity = USER; group = 'default'; mockFetch()
  const params = { ...callback, sign: ldcSign(callback, 'secret') }
  const req = { method: 'GET', headers: {}, url: `/api/ldc-notify?route=ldc-notify&${new URLSearchParams(params)}` }
  const res = response()
  await notifyHandler(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body, 'success', 'LDC needs a literal success acknowledgement')
  assert(calls.some(c => c.url.pathname.endsWith('/rpc/complete_ldc_order')))
  mockFetch()
  const forged = response()
  await notifyHandler({ ...req, url: req.url.replace('money=100.00', 'money=1.00') }, forged)
  assert.equal(forged.statusCode, 400)
  assert.equal(calls.length, 0, 'Reject invalid signatures before any database access')
  const duplicate = response()
  await notifyHandler({ ...req, url: `${req.url}&money=1.00` }, duplicate)
  assert.equal(duplicate.statusCode, 400)

  mockFetch()
  const free = response()
  await checkoutHandler({ method: 'POST', headers: { authorization: 'Bearer test-token' },
    body: { artifact_id: USER, provider: '', coupon_code: 'FREE', amount_minor: 999999 } }, free)
  assert.equal(free.statusCode, 201)
  assert.equal(JSON.parse(free.body).order.amount_minor, 0)
  assert(calls.some(c => c.url.pathname.endsWith('/rpc/checkout_zero_order')), 'Zero checkout uses one atomic RPC')
  assert(!calls.some(c => c.url.hostname === 'credit.linux.do'))

  let settled = false
  globalThis.fetch = async () => json({ ...callback, status: 1, money: '99.00' })
  await assert.rejects(() => queryLdc({ rpc() { settled = true } }, order), /mismatch/)
  assert.equal(settled, false)
} finally {
  globalThis.fetch = savedFetch
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(savedEnv, key)) delete process.env[key]
  Object.assign(process.env, savedEnv)
}

// Static installation guards, not a substitute for a PostgreSQL transaction/concurrency test.
const sql = readFileSync(new URL('../supabase/ldc.sql', import.meta.url), 'utf8')
assert.match(sql, /select \* into o from public\.ldc_orders where id = p_order for update/)
assert.match(sql, /provider_trade_no text unique/)
assert.match(sql, /revoke all on public\.ldc_orders from anon,authenticated/)
assert.match(sql, /revoke all on function public\.complete_ldc_order\(uuid,text\) from public,anon,authenticated/)
assert.match(sql, /array\[o\.user_id\]/)
assert.match(sql, /if o\.status = 'paid' then/)
console.log('LDC: amounts, signatures, OAuth claims, API permissions, consent, callback and installation guards OK')
