export const LINUXDO_PROVIDER = 'custom:linuxdo'
export const LDC_DEFAULTS = Object.freeze({
  enabled: false, discount_enabled: false, coupon_enabled: false,
  support_enabled: false, support_max_minor: 100000,
  request_ttl_minutes: 30, offers: []
})

export function safeNext(value, fallback = '/me') {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\\\x00-\x20]/.test(value)) return fallback
  try {
    const url = new URL(value, 'https://site.invalid')
    return url.origin === 'https://site.invalid' ? url.pathname + url.search + url.hash : fallback
  } catch { return fallback }
}

export function decimalMinor(value) {
  if (!/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(String(value))) throw new Error('Invalid LDC amount')
  const [whole, fraction = ''] = String(value).split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

export function validateLdcConfig(input) {
  const config = { ...LDC_DEFAULTS, ...input }
  for (const key of ['enabled', 'discount_enabled', 'coupon_enabled', 'support_enabled']) {
    if (typeof config[key] !== 'boolean') throw new Error(`${key} must be boolean`)
  }
  const int = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max
  if (!int(config.support_max_minor, 1, 100000000)) throw new Error('Invalid support limit')
  if (!int(config.request_ttl_minutes, 5, 1440)) throw new Error('Request TTL must be 5..1440 minutes')
  if (!Array.isArray(config.offers) || config.offers.length > 50) throw new Error('At most 50 offers')
  const ids = new Set()
  config.offers = config.offers.map(offer => {
    if (!offer || !/^[a-z0-9_-]{1,40}$/.test(offer.id) || ids.has(offer.id)) throw new Error('Invalid or duplicate offer ID')
    ids.add(offer.id)
    if (!['discount', 'coupon'].includes(offer.kind) || typeof offer.enabled !== 'boolean') throw new Error('Invalid offer kind/enabled')
    if (typeof offer.name !== 'string' || !offer.name.trim() || offer.name.length > 64) throw new Error('Offer name required (max 64)')
    if (!int(offer.ldc_minor, 1, 100000000) || !int(offer.discount_minor, 1, 100000000)) throw new Error('Offer amounts must be positive integers')
    if (!/^[A-Z]{3}$/.test(offer.currency)) throw new Error('Offer currency required')
    if (!int(offer.valid_days, 1, 365)) throw new Error('Coupon validity must be 1..365 days')
    if (typeof offer.sku !== 'string' || offer.sku.length > 100 || (offer.kind === 'discount' && !offer.sku.trim())) throw new Error('Discount offers require an exact SKU')
    return { id: offer.id, kind: offer.kind, enabled: offer.enabled, name: offer.name.trim(),
      ldc_minor: offer.ldc_minor, discount_minor: offer.discount_minor, currency: offer.currency,
      valid_days: offer.valid_days, sku: offer.sku.trim() }
  })
  return Object.fromEntries(Object.keys(LDC_DEFAULTS).map(key => [key, config[key]]))
}
