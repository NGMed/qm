// ════════════════════════════════════════════════════════════════════
// Needs-follow-up queue selector (WP7, step 2).
//
// "John wants a VA to follow up with people who received a quote but did
// not accept it." A quote is a follow-up candidate when ALL hold:
//
//   1. It reached the customer  — status is at least 'sent' (or sent_at
//      is stamped). A still-'draft' quote was never delivered, so
//      there's nobody to chase.
//   2. It did NOT convert       — no paid_at, no accepted_at, and status
//      is not 'paid'/'accepted'. (Either signal counts as converted so
//      a webhook lag on the status column can't hide a paid quote.)
//   3. It has gone stale        — the last activity is older than the
//      minimum age (default 24h) so we don't nag customers the same day
//      they received the quote.
//   4. A VA hasn't already actioned it (followed_up_at is null) — once
//      "Mark contacted" is pressed it drops out of the active queue.
//
// Everything here is PURE and DB-free so the queue logic is fully unit
// tested (followup.test.ts) without standing up Postgres. The API route
// and dashboard just feed rows through these functions.
// ════════════════════════════════════════════════════════════════════

import { rankOf } from './lifecycle'

/** Don't surface a quote for follow-up until it's at least this old
 *  (measured from its last activity). Keeps the VA off same-day quotes
 *  that customers are still reading. */
export const FOLLOWUP_MIN_AGE_HOURS = 24

const HOUR_MS = 3_600_000

/** Minimal lifecycle shape the selector needs. The API maps DB rows
 *  into this; tests construct it directly. Extra fields are ignored. */
export type FollowupQuote = {
  status?: string | null
  sent_at?: string | null
  viewed_at?: string | null
  paid_at?: string | null
  accepted_at?: string | null
  last_status_at?: string | null
  created_at?: string | null
  followed_up_at?: string | null
}

export type FollowupOptions = {
  /** Override the staleness threshold (hours). Default 24. */
  minAgeHours?: number
  /** Include quotes a VA already marked contacted. Default false. */
  includeActioned?: boolean
}

/** ISO string of the most recent meaningful activity on the quote.
 *  Prefers the dedicated last_status_at (migration 027) and falls back
 *  through the lifecycle timestamps so it still works on rows written
 *  before the column was backfilled. */
export function lastActivityIso(q: FollowupQuote): string | null {
  return (
    q.last_status_at ??
    q.accepted_at ??
    q.paid_at ??
    q.viewed_at ??
    q.sent_at ??
    q.created_at ??
    null
  )
}

/** Whole/fractional hours between `iso` and `now`. null when `iso` is
 *  missing or unparseable (treated as "age unknown" by the caller). */
export function ageHoursSince(
  iso: string | null | undefined,
  now: number,
): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return (now - t) / HOUR_MS
}

/** Did the quote reach the customer at all? (rank >= 'sent', or a
 *  sent_at timestamp exists even if the status column lagged.) */
export function reachedCustomer(q: FollowupQuote): boolean {
  return !!q.sent_at || rankOf(q.status) >= rankOf('sent')
}

/** Did the customer convert? Either authoritative signal counts so a
 *  status-column lag can't mask a real payment/booking. */
export function isConverted(q: FollowupQuote): boolean {
  return (
    !!q.paid_at ||
    !!q.accepted_at ||
    q.status === 'paid' ||
    q.status === 'accepted'
  )
}

/**
 * Is this quote something a VA should chase right now?
 * Reached the customer + not converted + stale enough + not already
 * actioned (unless includeActioned).
 */
export function isFollowupCandidate(
  q: FollowupQuote,
  now: number,
  opts: FollowupOptions = {},
): boolean {
  const minAgeHours = opts.minAgeHours ?? FOLLOWUP_MIN_AGE_HOURS
  if (!reachedCustomer(q)) return false
  if (isConverted(q)) return false
  if (!opts.includeActioned && q.followed_up_at) return false
  const age = ageHoursSince(lastActivityIso(q), now)
  if (age === null) return false
  return age >= minAgeHours
}

/** Short, human reason shown next to each row in the VA queue. */
export function followupReason(q: FollowupQuote): string {
  if (q.followed_up_at) return 'Contacted - awaiting reply'
  const opened = !!q.viewed_at || rankOf(q.status) >= rankOf('viewed')
  return opened ? 'Opened, not paid' : 'Sent, not opened'
}

/** Oldest activity first — the VA works the most-overdue quotes top of
 *  list. Rows with an unknown last activity sort last. */
export function compareByStaleness(a: FollowupQuote, b: FollowupQuote): number {
  const ta = Date.parse(lastActivityIso(a) ?? '')
  const tb = Date.parse(lastActivityIso(b) ?? '')
  const va = Number.isFinite(ta) ? ta : Number.POSITIVE_INFINITY
  const vb = Number.isFinite(tb) ? tb : Number.POSITIVE_INFINITY
  return va - vb
}

/** Filter a batch of quotes to the follow-up queue, oldest-first. */
export function selectFollowups<T extends FollowupQuote>(
  quotes: readonly T[],
  now: number,
  opts: FollowupOptions = {},
): T[] {
  return quotes
    .filter((q) => isFollowupCandidate(q, now, opts))
    .sort(compareByStaleness)
}
