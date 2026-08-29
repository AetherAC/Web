import { createClient } from '@supabase/supabase-js'

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
export async function requireUser(req, res, admin = false) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) { send(res, 401, { error: 'Authentication required' }); return null }
  const db = serviceClient()
  const { data, error } = await db.auth.getUser(token)
  if (error || !data.user) { send(res, 401, { error: 'Invalid session' }); return null }
  if (admin) {
    const { data: profile } = await db.from('user_profiles').select('group_name').eq('user_id', data.user.id).single()
    if (profile?.group_name !== 'admin') { send(res, 403, { error: 'Admin access required' }); return null }
  }
  return { user: data.user, db }
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
