import { bodyOf, RANK, requireUser, send, serviceClient } from '../_lib/server.mjs'
import { sessionCapabilities } from '../../shared/cs.mjs'
import { validateLdcConfig, decimalMinor } from '../../shared/ldc.mjs'
import { credentials, ldcConfig, LDC_COLUMNS, paymentFields, queryLdc, UUID } from '../_lib/ldc.mjs'

export default async function handler(req, res) {
  try {
    if (req.method === 'GET' && req.query?.view === 'config') {
      const { config, linuxdo_enabled } = await ldcConfig(serviceClient())
      const configured = Boolean(process.env.LDC_CLIENT_ID && process.env.LDC_CLIENT_SECRET)
      return send(res, 200, { ...config, enabled: config.enabled && configured, linuxdo_enabled, configured,
        offers: config.offers.filter(o => o.enabled && config[`${o.kind}_enabled`]) })
    }
    if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { error: 'Method not allowed' })
    const auth = await requireUser(req, res)
    if (!auth) return
    const { db, user } = auth
    const settings = await ldcConfig(db)
    const config = settings.config
    if (req.method === 'GET') {
      if (req.query?.view === 'admin') {
        if (auth.rank < RANK.ADMIN) return send(res, 403, { error: 'Admin required' })
        return send(res, 200, { ...settings, configured: Boolean(process.env.LDC_CLIENT_ID && process.env.LDC_CLIENT_SECRET) })
      }
      let query = db.from('ldc_orders').select(LDC_COLUMNS).order('created_at', { ascending: false }).limit(100)
      if (req.query?.session_id) {
        const id = String(req.query.session_id)
        if (!UUID.test(id)) return send(res, 400, { error: 'Invalid session' })
        const { data: session, error } = await db.from('cs_sessions').select('*').eq('id', id).maybeSingle()
        if (error) throw error
        if (!session || !sessionCapabilities(session, { userId: user.id, group: auth.group }).can_see) return send(res, 403, { error: 'Session access denied' })
        query = query.eq('session_id', id)
      } else query = query.eq('user_id', user.id)
      const { data, error } = await query
      if (error) throw error
      return send(res, 200, { orders: data || [] })
    }
    const input = await bodyOf(req)
    if (input.action === 'settings') {
      if (auth.rank < RANK.ADMIN) return send(res, 403, { error: 'Admin required' })
      let validated
      try { validated = validateLdcConfig(input.config) } catch (e) { return send(res, 400, { error: e.message }) }
      if (typeof input.linuxdo_enabled !== 'boolean') return send(res, 400, { error: 'Invalid login switch' })
      const { error } = await db.from('site_settings').upsert([
        { key: 'ldc_config', value: { value: validated }, description: 'LDC exchange and support requests' },
        { key: 'linuxdo_enabled', value: { value: input.linuxdo_enabled }, description: 'Linux.DO OAuth login' }
      ])
      if (error) throw error
      return send(res, 200, { ok: true })
    }
    if (['pay', 'sync', 'decline'].includes(input.action)) {
      if (!UUID.test(input.id || '')) return send(res, 400, { error: 'Invalid request ID' })
      const { data: order, error } = await db.from('ldc_orders').select(LDC_COLUMNS).eq('id', input.id).eq('user_id', user.id).maybeSingle()
      if (error) throw error
      if (!order) return send(res, 404, { error: 'Request not found' })
      if (input.action === 'sync') return send(res, 200, { order: order.status === 'paid' ? order : await queryLdc(db, order) })
      if (input.action === 'decline') {
        const { data, error: updateError } = await db.from('ldc_orders').update({ status: 'declined' })
          .eq('id', order.id).eq('status', 'pending').is('consented_at', null).select(LDC_COLUMNS).maybeSingle()
        if (updateError) throw updateError
        if (!data) return send(res, 409, { error: 'Request already authorized or completed; close payment page and contact support' })
        return send(res, 200, { order: data })
      }
      if (!config.enabled || !config[`${order.kind === 'support' ? 'support' : order.kind}_enabled`]) return send(res, 409, { error: 'This LDC feature is disabled' })
      if (input.confirm !== true) return send(res, 400, { error: 'Explicit user confirmation required' })
      if (order.status !== 'pending' || Date.parse(order.expires_at) <= Date.now()) return send(res, 409, { error: 'Request completed or expired' })
      const fields = paymentFields(order)
      const { data, error: updateError } = await db.from('ldc_orders').update({ consented_at: new Date().toISOString() })
        .eq('id', order.id).eq('status', 'pending').gt('expires_at', new Date().toISOString()).select('id').maybeSingle()
      if (updateError) throw updateError
      if (!data) return send(res, 409, { error: 'Request is no longer payable' })
      return send(res, 200, { action: 'https://credit.linux.do/epay/pay/submit.php', fields })
    }
    if (input.action !== 'create') return send(res, 400, { error: 'Unknown action' })
    if (!config.enabled) return send(res, 409, { error: 'LDC is disabled' })
    credentials()
    let target = user.id, benefit = {}, sessionId = null, kind, name, amount
    if (input.session_id) {
      if (!config.support_enabled || auth.rank < RANK.STAFF || !UUID.test(input.session_id)) return send(res, 403, { error: 'LDC support requests unavailable' })
      const { data: session, error } = await db.from('cs_sessions').select('*').eq('id', input.session_id).maybeSingle()
      if (error) throw error
      const caps = session && sessionCapabilities(session, { userId: user.id, group: auth.group })
      if (!caps?.can_post || caps.is_owner || (!caps.is_agent && !caps.is_admin)) return send(res, 403, { error: 'Only the assigned agent or administrator may request LDC' })
      try { amount = decimalMinor(input.amount) } catch { return send(res, 400, { error: 'Invalid LDC amount (up to two decimals)' }) }
      if (amount < 1 || amount > config.support_max_minor) return send(res, 400, { error: 'LDC amount exceeds configured limit' })
      name = String(input.name || '').trim()
      if (!name || name.length > 64) return send(res, 400, { error: 'A reason of 1..64 characters is required' })
      kind = 'support'; target = session.user_id; sessionId = session.id
    } else {
      const offer = config.offers.find(o => o.id === input.offer_id && o.enabled && config[`${o.kind}_enabled`])
      if (!offer) return send(res, 404, { error: 'Offer unavailable' })
      if (offer.sku) {
        const { data: product, error } = await db.from('artifacts').select('price_minor,currency').eq('sku', offer.sku).eq('active', true).maybeSingle()
        if (error) throw error
        if (!product || product.currency !== offer.currency || product.price_minor < offer.discount_minor) return send(res, 409, { error: 'Offer does not match the current product price/currency' })
      }
      kind = offer.kind; name = offer.name; amount = offer.ldc_minor; benefit = offer
    }
    const { data, error } = await db.rpc('create_ldc_order', {
      p_user: target, p_actor: user.id, p_session: sessionId, p_kind: kind, p_name: name,
      p_amount: amount, p_benefit: benefit, p_ttl: config.request_ttl_minutes
    })
    if (error?.code === 'P0001') return send(res, 409, { error: 'Too many recent or pending LDC requests; finish an existing request first' })
    if (error?.code === '42501') return send(res, 403, { error: 'Session access changed; refresh the conversation' })
    if (error) throw error
    return send(res, 201, { order: data })
  } catch (error) {
    console.error('LDC operation failed', { code: error.code })
    return send(res, 503, { error: 'LDC service unavailable; check configuration and database setup' })
  }
}
