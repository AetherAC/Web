import { RANK, requireUser, send, serviceClient } from '../_lib/server.mjs'
import { RUNNING_WINDOW_MS, summarise } from '../_lib/telemetry.mjs'

/** How stale the newest rollup may be before another is appended. */
const ROLLUP_INTERVAL_MS = 60 * 60 * 1000

/**
 * The install figures behind /admin's overview.
 *
 * Derived from public.telemetry_installs, not from Sentry. Sentry receives this project's errors,
 * crashes and logs, but it cannot answer 装机量: `count_unique(hwid)` runs over the errors dataset, so it
 * counts only installs that failed — a server running cleanly would not appear, and the number would
 * silently become a crash count wearing an install count's label. (The token issued here also carries
 * only project:releases, so that query answers 403, but fixing the scope would not fix the meaning.)
 *
 * Breakdowns by mcver, loader, licensestatus and osarch name individual servers' versions in aggregate,
 * so the whole response is admin-only. The bare counts are the part that could be published, and this is
 * not the endpoint that would do it.
 */
export default async function handler(req, res) {
  const auth = await requireUser(req, res, RANK.ADMIN)
  if (!auth) return
  try {
    const db = serviceClient()
    const { data: rows, error } = await db
      .from('telemetry_installs')
      .select('hwid,last_seen,mcver,loader,licensestatus,osarch,errors,crashes,warns')
    if (error) throw error

    const summary = summarise(rows)

    // Append to the rollup history at most hourly. installation_snapshots exists to answer "what was the
    // install base three months ago", which the live table cannot: it holds current state per install and
    // is upserted, so yesterday's shape is gone. Writing one row per page view would bury that history in
    // duplicates, so a fresh row is only added once the newest is an hour old.
    const { data: newest } = await db
      .from('installation_snapshots').select('captured_at').order('captured_at', { ascending: false }).limit(1).maybeSingle()
    const due = !newest || Date.now() - new Date(newest.captured_at).getTime() >= ROLLUP_INTERVAL_MS
    if (due) {
      await db.from('installation_snapshots').insert({
        installed_hwid: summary.installed_hwid, running_hwid: summary.running_hwid, source: 'heartbeat'
      })
    }

    // `configured` reports whether telemetry can actually be received: without the ingest key
    // api/telemetry.mjs refuses every sample, so zero installs would otherwise read as "nobody is
    // running it" when it means "nothing can report".
    return send(res, 200, {
      ...summary,
      running_window_minutes: RUNNING_WINDOW_MS / 60000,
      configured: Boolean(process.env.TELEMETRY_INGEST_KEY)
    })
  } catch (error) { return send(res, 500, { error: error.message }) }
}
