// The telemetry wire format, and the only place that decides what a valid sample is.
//
// This module is pure so tests can drive it without a database. api/telemetry.mjs is the transport;
// everything about what a sample may contain is here, and the plugin's SampleFields.java is built to
// match. Field names are identical on both sides and in the database — no translation layer, because a
// silent rename is exactly how one half starts dropping a field the other still sends.

/** The salted SHA-256 an install derives from stable machine facts. Never a raw machine identifier. */
export const HWID = /^[0-9a-f]{64}$/

/**
 * What the licence check concluded. A closed set: an unrecognised value is rejected rather than stored,
 * so a typo in a client release shows up as a 400 in the logs instead of a phantom category in the
 * admin breakdown that nobody can explain.
 *
 * `unknown` is the honest answer before the first check completes, and is what a sample carries when the
 * licence server could not be reached — distinct from `invalid`, which is a licence that was checked and
 * refused. Conflating those two would make a network outage look like a customer's licence being revoked.
 */
export const LICENSE_STATUS = ['active', 'expired', 'invalid', 'revoked', 'missing', 'grace', 'unknown']

// Length caps. Every string arrives from an unauthenticated request, so each one is bounded: without
// this, a client — or someone pretending to be one — writes megabytes into a text column. The caps are
// generous against real values ("1.21.8", "paper", "0.1.0-SNAPSHOT+abc1234") and small enough that the
// worst case is bounded.
const CAPS = { mcver: 32, loader: 32, modver: 64, licensecode: 128, os: 32, osver: 64, osarch: 16 }

/** Counters are per-sample deltas, so a plausible ceiling exists; beyond it the value is a bug. */
const MAX_DELTA = 1_000_000

const isString = (value) => typeof value === 'string'
const trimmed = (value) => (isString(value) ? value.trim() : '')

/**
 * Validate and normalise one sample.
 *
 * Returns `{ sample }` or `{ error }`. Never throws and never partially accepts: a sample that fails any
 * check is rejected whole, because a half-stored row would be counted in 装机量 while describing nothing.
 */
export function parseSample(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'A sample must be a JSON object' }

  const hwid = trimmed(input.hwid).toLowerCase()
  if (!HWID.test(hwid)) {
    return { error: 'hwid must be 64 lower-case hex characters — a salted SHA-256, not a machine identifier' }
  }

  // Required descriptors. Empty is a rejection rather than a default: a row claiming mcver='' would be
  // counted in the install base and then silently excluded from every breakdown built on it.
  const required = {}
  for (const key of ['mcver', 'loader', 'modver']) {
    const value = trimmed(input[key])
    if (!value) return { error: `${key} is required` }
    if (value.length > CAPS[key]) return { error: `${key} exceeds ${CAPS[key]} characters` }
    required[key] = value
  }

  const licensestatus = trimmed(input.licensestatus).toLowerCase()
  if (!LICENSE_STATUS.includes(licensestatus)) {
    return { error: `licensestatus must be one of ${LICENSE_STATUS.join(', ')}` }
  }

  // Optional descriptors. Absent and empty are the same thing here — both mean "this install did not
  // say" — and both store as ''. Only a value that is present and wrong is an error.
  const optional = {}
  for (const key of ['os', 'osver', 'osarch']) {
    const value = trimmed(input[key])
    if (value.length > CAPS[key]) return { error: `${key} exceeds ${CAPS[key]} characters` }
    optional[key] = value
  }

  // A licence code identifies a paying customer, so it is stored only when one was actually reported,
  // and null — not '' — when it was not. That distinction is what lets an admin tell "no licence" from
  // "a licence whose code we failed to record".
  let licensecode = null
  if (input.licensecode !== undefined && input.licensecode !== null) {
    if (!isString(input.licensecode)) return { error: 'licensecode must be a string' }
    const value = input.licensecode.trim()
    if (value.length > CAPS.licensecode) return { error: `licensecode exceeds ${CAPS.licensecode} characters` }
    licensecode = value || null
  }

  // When the licence server asked the client to back off, this is when it may ask again. It is the
  // client's own deadline, so it is accepted as an instant and stored as one.
  let retry_license_after = null
  if (input.retry_license_after !== undefined && input.retry_license_after !== null && input.retry_license_after !== '') {
    const when = new Date(input.retry_license_after)
    if (Number.isNaN(when.getTime())) return { error: 'retry_license_after must be an ISO 8601 timestamp' }
    retry_license_after = when.toISOString()
  }

  const deltas = {}
  for (const key of ['errors', 'crashes', 'warns']) {
    const raw = input[key]
    if (raw === undefined || raw === null) { deltas[key] = 0; continue }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      return { error: `${key} must be a non-negative integer` }
    }
    if (raw > MAX_DELTA) return { error: `${key} exceeds ${MAX_DELTA} for a single sample` }
    deltas[key] = raw
  }

  return { sample: { hwid, ...required, licensestatus, licensecode, retry_license_after, ...optional, ...deltas } }
}

/**
 * Fold a sample into the row to be written.
 *
 * Descriptors overwrite — the newest sample is the truth about a version or a licence. Counters add,
 * because each sample reports only what happened since the last one; a client that restarted has
 * forgotten its own tallies, so the running total can only be kept here.
 */
export function mergeSample(existing, sample, now = new Date()) {
  const stamp = now.toISOString()
  const { errors, crashes, warns, ...descriptors } = sample
  return {
    ...descriptors,
    first_seen: existing?.first_seen ?? stamp,
    last_seen: stamp,
    samples: Number(existing?.samples ?? 0) + 1,
    errors: Number(existing?.errors ?? 0) + errors,
    crashes: Number(existing?.crashes ?? 0) + crashes,
    warns: Number(existing?.warns ?? 0) + warns
  }
}

/** How recently an install must have reported to count as running. */
export const RUNNING_WINDOW_MS = 15 * 60 * 1000

/**
 * Derive the numbers the admin overview shows.
 *
 * 装机量 is every install ever seen; 运行量 is those seen inside the running window. The window is
 * deliberately several times the heartbeat interval: at exactly one interval, a sample arriving a second
 * late would drop a live server out of the count and make the figure flicker.
 */
export function summarise(rows, now = Date.now(), windowMs = RUNNING_WINDOW_MS) {
  const installs = rows ?? []
  const running = installs.filter((row) => now - new Date(row.last_seen).getTime() <= windowMs)
  const tally = (source, key) => {
    const counts = {}
    for (const row of source) {
      const value = row[key] || '未知'
      counts[value] = (counts[value] ?? 0) + 1
    }
    // Largest first: a breakdown is read to find the common case, not to admire the alphabet.
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]))
  }
  return {
    installed_hwid: installs.length,
    running_hwid: running.length,
    errors: installs.reduce((total, row) => total + Number(row.errors ?? 0), 0),
    crashes: installs.reduce((total, row) => total + Number(row.crashes ?? 0), 0),
    warns: installs.reduce((total, row) => total + Number(row.warns ?? 0), 0),
    // Breakdowns describe what is running now. Over all installs ever, a version retired a year ago
    // would sit in the list forever and make the current fleet impossible to read.
    by_mcver: tally(running, 'mcver'),
    by_loader: tally(running, 'loader'),
    by_licensestatus: tally(running, 'licensestatus'),
    by_osarch: tally(running, 'osarch')
  }
}
