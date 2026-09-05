import { send } from '../_lib/server.mjs'

export function linuxdoClaims(profile) {
  const id = String(profile?.id ?? '')
  if (!/^[1-9]\d{0,18}$/.test(id) || profile.active !== true || profile.silenced === true) throw new Error('Linux.DO account unavailable')
  // Never forward api_key, external_ids or synthetic email addresses into Supabase identities.
  return { sub: id, name: String(profile.name || profile.username || `Linux.DO ${id}`).slice(0, 200),
    preferred_username: String(profile.username || '').slice(0, 100) }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' })
  const authorization = req.headers.authorization
  if (typeof authorization !== 'string' || !/^Bearer [\x21-\x7e]{1,4096}$/.test(authorization)) return send(res, 401, { error: 'Bearer token required' })
  try {
    const response = await fetch('https://connect.linux.do/api/user', {
      headers: { Authorization: authorization, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(10000)
    })
    if (!response.ok) return send(res, response.status === 401 || response.status === 403 ? 401 : 502, { error: 'Linux.DO userinfo unavailable' })
    const profile = await response.json()
    let claims
    try { claims = linuxdoClaims(profile) } catch { return send(res, 403, { error: 'Linux.DO account unavailable' }) }
    return send(res, 200, claims)
  } catch { return send(res, 502, { error: 'Linux.DO userinfo unavailable' }) }
}
