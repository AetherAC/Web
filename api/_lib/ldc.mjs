import { createHash, timingSafeEqual } from 'node:crypto'
import { decimalMinor, LDC_DEFAULTS, validateLdcConfig } from '../../shared/ldc.mjs'
import { settingsOf } from './cs.mjs'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const LDC_COLUMNS = 'id,user_id,requested_by,session_id,kind,name,ldc_minor,benefit,status,provider_trade_no,coupon_code,created_at,expires_at,paid_at,consented_at'

export async function ldcConfig(db) {
  const settings = await settingsOf(db, ['ldc_config', 'linuxdo_enabled'])
  return { config: validateLdcConfig(settings.ldc_config || LDC_DEFAULTS), linuxdo_enabled: settings.linuxdo_enabled === true }
}

export function credentials() {
  const pid = process.env.LDC_CLIENT_ID
  const key = process.env.LDC_CLIENT_SECRET
  if (!pid || !key) throw new Error('LDC credentials are not configured')
  return { pid, key }
}

export function ldcSign(params, secret) {
  const entries = Object.entries(params).filter(([key, value]) => !['sign', 'sign_type'].includes(key) && value !== '' && value != null)
  if (entries.some(([, value]) => typeof value !== 'string')) throw new Error('LDC fields must be strings')
  const canonical = entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('&')
  return createHash('md5').update(canonical + secret, 'utf8').digest('hex')
}

export function verifyLdc(params, secret) {
  if (!/^[a-f0-9]{32}$/i.test(params.sign || '') || (params.sign_type && params.sign_type !== 'MD5')) return false
  try { return timingSafeEqual(Buffer.from(params.sign.toLowerCase()), Buffer.from(ldcSign(params, secret))) } catch { return false }
}

export function paymentFields(order) {
  const { pid, key } = credentials()
  const origin = new URL(process.env.SITE_URL || 'https://aetherac.abnt.it')
  if (origin.protocol !== 'https:' || origin.username || origin.password) throw new Error('SITE_URL must use HTTPS')
  const fields = {
    pid, type: 'epay', out_trade_no: order.id, name: order.name,
    money: (order.ldc_minor / 100).toFixed(2),
    notify_url: `${origin.origin}/api/ldc-notify`, return_url: `${origin.origin}/me?ldc=${order.id}`
  }
  if (fields.notify_url.length > 100 || fields.return_url.length > 100) throw new Error('LDC callback URL too long')
  return { ...fields, sign: ldcSign(fields, key), sign_type: 'MD5' }
}

export function verifySettlement(params, order, pid) {
  if (params.pid !== pid || params.type !== 'epay' || params.trade_status !== 'TRADE_SUCCESS' ||
      params.out_trade_no !== order.id || !/^[A-Za-z0-9_-]{1,128}$/.test(params.trade_no || '')) return false
  try { return decimalMinor(params.money) === order.ldc_minor } catch { return false }
}

export async function settleLdc(db, order, tradeNo) {
  const { data, error } = await db.rpc('complete_ldc_order', { p_order: order.id, p_trade: tradeNo })
  if (error) throw new Error('LDC settlement failed')
  return data
}

export async function queryLdc(db, order) {
  const { pid, key } = credentials()
  const url = new URL('https://credit.linux.do/epay/api.php')
  url.search = new URLSearchParams({ act: 'order', pid, key, out_trade_no: order.id }).toString()
  const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'error' })
  if (response.status === 404) return order
  if (!response.ok) throw new Error('LDC status service unavailable')
  const data = await response.json()
  if (Number(data.status) !== 1) return order
  const normalized = { ...data, pid: String(data.pid), trade_status: 'TRADE_SUCCESS' }
  if (!verifySettlement(normalized, order, pid)) throw new Error('LDC settlement details mismatch')
  return settleLdc(db, order, data.trade_no)
}
