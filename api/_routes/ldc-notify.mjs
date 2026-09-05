import { serviceClient } from '../_lib/server.mjs'
import { credentials, LDC_COLUMNS, UUID, verifyLdc, verifySettlement, settleLdc } from '../_lib/ldc.mjs'

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  if (req.method !== 'GET') return res.status(405).send('fail')
  try {
    // Read the original query, not req.query: Vercel adds an unsigned `route` parameter.
    const params = Object.create(null)
    for (const [key, value] of new URL(req.url, 'https://site.invalid').searchParams) {
      if (key === 'route') continue
      if (Object.hasOwn(params, key)) return res.status(400).send('fail')
      params[key] = value
    }
    const { pid, key } = credentials()
    if (!UUID.test(params.out_trade_no || '') || !verifyLdc(params, key)) return res.status(400).send('fail')
    const db = serviceClient()
    const { data: order, error } = await db.from('ldc_orders').select(LDC_COLUMNS).eq('id', params.out_trade_no).maybeSingle()
    if (error) throw error
    if (!order || !verifySettlement(params, order, pid)) return res.status(400).send('fail')
    await settleLdc(db, order, params.trade_no)
    return res.status(200).send('success')
  } catch {
    console.error('LDC notification could not be settled')
    return res.status(503).send('fail')
  }
}
