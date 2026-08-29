import handler from '../api/github-progress.mjs'
import usersHandler, { isBanned } from '../api/admin-users.mjs'
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
