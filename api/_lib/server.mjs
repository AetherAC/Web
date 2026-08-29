import { createClient } from '@supabase/supabase-js'
import { RANK, rankOf } from '../../shared/groups.mjs'
// 用户组定义在 shared/groups.mjs，浏览器那边也从同一个文件读。转发出去是为了让调用方少写一个 import。
export { EDITOR_GROUPS, GROUP_LABEL, GROUP_ORDER, GROUP_RANK, RANK, isEditor, rankOf } from '../../shared/groups.mjs'

export function send(res, status, body) {
  res.status(status)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.send(JSON.stringify(body))
}
export function serviceClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) are required')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}
// `need` is a minimum rank, not a boolean. Callers pass RANK.ADMIN / RANK.STAFF / RANK.MEMBER; 0 (the
// default) means any signed-in user. Returns the caller's group and rank so handlers can make finer
// distinctions — e.g. §10.4 lets postsale start a refund but only admin approve one.
export async function requireUser(req, res, need = 0) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) { send(res, 401, { error: 'Authentication required' }); return null }
  const db = serviceClient()
  const { data, error } = await db.auth.getUser(token)
  if (error || !data.user) { send(res, 401, { error: 'Invalid session' }); return null }
  // Booleans still work: `true` used to mean admin-only, and that is what it keeps meaning.
  const floor = need === true ? RANK.ADMIN : need === false ? 0 : Number(need) || 0
  const { data: profile } = await db.from('user_profiles').select('group_name').eq('user_id', data.user.id).maybeSingle()
  const group = profile?.group_name || 'default'
  const rank = rankOf(group)
  if (rank < floor) {
    send(res, 403, { error: floor >= RANK.ADMIN ? 'Admin access required' : 'Insufficient permissions', required: floor, rank })
    return null
  }
  return { user: data.user, db, group, rank }
}
export async function bodyOf(req) {
  if (req.body && typeof req.body === 'object') return req.body
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  // PayerURL posts its callback form-encoded. Left to JSON.parse that would throw and answer 500,
  // which the provider would read as an outage and keep retrying.
  const form = /application\/x-www-form-urlencoded/i.test(String(req.headers?.['content-type'] || ''))
  return form ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw)
}
