import { supabase, useAuth } from './auth'
import { LINUXDO_PROVIDER, safeNext } from '../../../shared/ldc.mjs'

export async function ldcApi(options: RequestInit = {}, query = '') {
  const token = useAuth().session.value?.access_token
  const response = await fetch(`/api/ldc${query}`, {
    ...options, signal: options.signal || AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers }
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `LDC ${response.status}`)
  return data
}

export async function linuxdoLogin(link = false) {
  if (!supabase) throw new Error('Supabase 尚未配置')
  const next = safeNext(new URLSearchParams(location.search).get('next'))
  // Older SDK typings predate custom providers; the Auth server owns validation and OAuth state.
  const provider = LINUXDO_PROVIDER as Parameters<typeof supabase.auth.signInWithOAuth>[0]['provider']
  const options = { redirectTo: `${location.origin}${link ? '/me' : next}` }
  const { error } = link
    ? await supabase.auth.linkIdentity({ provider, options })
    : await supabase.auth.signInWithOAuth({ provider, options })
  if (error) throw error
}

export function submitLdcPayment(payment: { action: string; fields: Record<string, string> }) {
  if (payment.action !== 'https://credit.linux.do/epay/pay/submit.php') throw new Error('无效的 LDC 网关')
  const form = document.createElement('form')
  form.method = 'POST'; form.action = payment.action
  for (const [name, value] of Object.entries(payment.fields)) {
    const input = document.createElement('input')
    input.type = 'hidden'; input.name = name; input.value = value
    form.append(input)
  }
  document.body.append(form)
  form.submit()
  form.remove()
}
