import { bodyOf, RANK, requireUser, send } from '../_lib/server.mjs'
const bootstrap = () => {
  const token = process.env.VERCEL_API_TOKEN
  const project = process.env.VERCEL_PROJECT_ID
  if (!token || !project) throw new Error('Set VERCEL_API_TOKEN and VERCEL_PROJECT_ID once in Vercel')
  const team = process.env.VERCEL_TEAM_ID
  return { token, project, team, query: team ? `?teamId=${encodeURIComponent(team)}` : '' }
}
async function vercel(path, options = {}) {
  const { token } = bootstrap()
  const response = await fetch(`https://api.vercel.com${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers } })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error?.message || `Vercel API ${response.status}`)
  return data
}
async function redeploy() {
  const hook = process.env.VERCEL_DEPLOY_HOOK_URL
  if (!hook) return false
  const url = new URL(hook)
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.vercel.com')) throw new Error('VERCEL_DEPLOY_HOOK_URL must be a Vercel HTTPS hook')
  const response = await fetch(url, { method: 'POST' })
  if (!response.ok) throw new Error(`Deploy hook ${response.status}`)
  return true
}
export default async function handler(req, res) {
  if (!await requireUser(req, res, RANK.ADMIN)) return
  try {
    const { project, query } = bootstrap()
    if (req.method === 'GET') {
      const data = await vercel(`/v9/projects/${encodeURIComponent(project)}/env${query}`)
      return send(res, 200, { variables: (data.envs || []).map(({ id, key, target, type, updatedAt }) => ({ id, key, target, type, updatedAt })) })
    }
    const body = await bodyOf(req)
    if (req.method === 'PUT') {
      if (!/^[A-Z][A-Z0-9_]*$/.test(body.key || '') || typeof body.value !== 'string') return send(res, 400, { error: 'Invalid environment variable' })
      const target = body.target?.length ? body.target : ['production','preview','development']
      if (body.id) await vercel(`/v9/projects/${encodeURIComponent(project)}/env/${encodeURIComponent(body.id)}${query}`, { method: 'PATCH', body: JSON.stringify({ key: body.key, value: body.value, type: body.sensitive === false ? 'plain' : 'sensitive', target }) })
      else await vercel(`/v10/projects/${encodeURIComponent(project)}/env${query}`, { method: 'POST', body: JSON.stringify({ key: body.key, value: body.value, type: body.sensitive === false ? 'plain' : 'sensitive', target }) })
      return send(res, 200, { ok: true, redeployRequired: !await redeploy() })
    }
    if (req.method === 'DELETE') {
      if (!body.id) return send(res, 400, { error: 'Missing variable id' })
      await vercel(`/v9/projects/${encodeURIComponent(project)}/env/${encodeURIComponent(body.id)}${query}`, { method: 'DELETE' })
      return send(res, 200, { ok: true, redeployRequired: !await redeploy() })
    }
    return send(res, 405, { error: 'Method not allowed' })
  } catch (error) { return send(res, 500, { error: error.message }) }
}
