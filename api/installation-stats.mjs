import { send, serviceClient } from './_lib/server.mjs'
async function sentryUnique(period) {
  const org = process.env.SENTRY_ORG
  const project = process.env.SENTRY_PROJECT
  const token = process.env.SENTRY_AUTH_TOKEN
  const tag = process.env.SENTRY_HWID_TAG || 'hwid'
  if (!org || !project || !token) return null
  const params = new URLSearchParams({ dataset: 'errors', project, statsPeriod: period })
  params.append('field', `count_unique(${tag})`)
  const response = await fetch(`https://sentry.io/api/0/organizations/${encodeURIComponent(org)}/events/?${params}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok) throw new Error(`Sentry API ${response.status}`)
  const data = await response.json()
  return Number(data.data?.[0]?.[`count_unique(${tag})`] || 0)
}
export default async function handler(_req, res) {
  try {
    const db = serviceClient()
    const { data: cached } = await db.from('installation_snapshots').select('*').order('captured_at',{ascending:false}).limit(1).maybeSingle()
    if (cached && Date.now()-new Date(cached.captured_at).getTime()<300000) return send(res,200,cached)
    const [installed,running] = await Promise.all([sentryUnique(process.env.SENTRY_INSTALL_PERIOD || '90d'),sentryUnique(process.env.SENTRY_RUNNING_PERIOD || '5m')])
    if (installed === null) return send(res,200,cached || { installed_hwid:0,running_hwid:0,configured:false })
    const { data } = await db.from('installation_snapshots').insert({installed_hwid:installed,running_hwid:running||0}).select().single()
    return send(res,200,{...data,configured:true})
  } catch (error) { return send(res,500,{error:error.message}) }
}
