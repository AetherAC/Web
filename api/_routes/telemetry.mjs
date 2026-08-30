import { bodyOf, send, serviceClient } from '../_lib/server.mjs'
import { mergeSample, parseSample } from '../_lib/telemetry.mjs'
import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Compare without leaking length or position through timing.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be an oracle, so both sides are
 * hashed to a fixed width first. Cheap, and it removes the need to reason about it again.
 */
const sameKey = (given, expected) => {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false
  const digest = (value) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(given), digest(expected))
}

/**
 * Receive one telemetry sample from an installed copy of the anticheat.
 *
 * Writes through the service client, so RLS is bypassed and the checks in this file are the whole of the
 * authorization. Two of them matter:
 *
 * - The shared key. Without it anyone could post arbitrary hwids and inflate 装机量 into fiction. It is a
 *   constant embedded in a distributed jar, so a determined person will extract it; what it buys is that
 *   the numbers cannot be moved by someone who merely found the URL. If it is unset the endpoint refuses
 *   rather than accepting anonymously, because a metric quietly open to the internet is worse than one
 *   that is plainly switched off.
 * - parseSample. Every field is bounded and every enum closed there, so a malformed or hostile body
 *   cannot reach the database.
 *
 * Flooding is bounded by the shape of the table rather than by a rate limiter: samples upsert on hwid, so
 * a client reporting a thousand times a second still occupies one row and moves 装机量 by zero. Only
 * minting fresh hwids inflates anything, and that needs the key.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })

  const expected = process.env.TELEMETRY_INGEST_KEY
  if (!expected) return send(res, 503, { error: 'Telemetry is not configured' })
  const offered = req.headers['x-aether-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!sameKey(offered, expected)) return send(res, 401, { error: 'Invalid ingest key' })

  try {
    const { sample, error } = parseSample(await bodyOf(req))
    if (error) return send(res, 400, { error })

    const db = serviceClient()
    // Read-then-write rather than a single upsert, because the counters accumulate: the new total needs
    // the old one. Two samples from the same install racing here would have one overwrite the other's
    // increment — an undercount of at most one sample's deltas on one install, which is not worth a
    // locking round trip. The descriptors and last_seen, which is what the counts are built on, are
    // correct either way since both writers carry the same values.
    const { data: existing } = await db.from('telemetry_installs').select('*').eq('hwid', sample.hwid).maybeSingle()
    const row = mergeSample(existing, sample)
    const { error: writeError } = await db.from('telemetry_installs').upsert(row, { onConflict: 'hwid' })
    if (writeError) throw writeError

    // The response says nothing about the fleet. A client needs to know its sample landed; telling it how
    // many installs exist would publish the figure to every install, and to anyone holding the key.
    return send(res, 202, { accepted: true })
  } catch (error) {
    return send(res, 500, { error: error.message })
  }
}
