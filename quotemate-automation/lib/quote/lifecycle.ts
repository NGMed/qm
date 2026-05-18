// ════════════════════════════════════════════════════════════════════
// Quote lifecycle — single source of truth for status transitions (WP7).
//
// The build brief (docs/wp7-implementation-brief.md) requires the quote
// lifecycle to be reliable enough to distinguish sent / viewed / paid /
// accepted before a VA follow-up queue can be trusted. Before WP7 the
// `quotes.status` column was free text and the only reliable writes were
// 'draft' (on insert) and 'accepted' (on booking). 'sent' and 'viewed'
// were never recorded and 'paid' never moved the status column.
//
// Canonical ladder (monotonic — a quote never moves backwards):
//
//     draft (0) → sent (1) → viewed (2) → paid (3) → accepted (4)
//
// In this product the customer pays the deposit BEFORE they can pick a
// booking slot (see app/api/q/[token]/book/route.ts — it requires
// paid_at), so 'accepted' legitimately ranks above 'paid'.
//
// Legacy / unknown statuses (e.g. the historical 'inspection' value) are
// tolerated: rankOf() returns -1 for them so they never crash anything
// and a genuine lifecycle event can still advance them forward (an
// inspection-routed quote is still "sent" when its SMS goes out).
//
// All decision logic here is PURE and dependency-free so it can be unit
// tested without a database (see lifecycle.test.ts). The only impure
// function, advanceQuoteStatus(), is a thin, defensive Supabase wrapper
// that NEVER throws — its callers run inside Next `after()` blocks and
// webhooks where an unhandled throw would break the customer flow.
// ════════════════════════════════════════════════════════════════════

import type { SupabaseClient } from '@supabase/supabase-js'

/** The canonical, ordered lifecycle states. Index === rank. */
export const QUOTE_STATUSES = [
  'draft',
  'sent',
  'viewed',
  'paid',
  'accepted',
] as const

export type QuoteStatus = (typeof QUOTE_STATUSES)[number]

/** Status → rank. Higher rank = further along the lifecycle. */
export const STATUS_RANK: Readonly<Record<QuoteStatus, number>> = Object.freeze(
  QUOTE_STATUSES.reduce(
    (acc, s, i) => {
      acc[s] = i
      return acc
    },
    {} as Record<QuoteStatus, number>,
  ),
)

/** Lifecycle status → the timestamp column that records when it happened.
 *  'draft' has no dedicated column (created_at covers it). */
export const STATUS_TIMESTAMP_COLUMN: Readonly<
  Record<QuoteStatus, string | null>
> = Object.freeze({
  draft: null,
  sent: 'sent_at',
  viewed: 'viewed_at',
  paid: 'paid_at',
  accepted: 'accepted_at',
})

/**
 * Rank of an arbitrary status string. Known canonical statuses return
 * their ladder index (0-4). Anything else — null, '', 'inspection',
 * a typo, a future value — returns -1 ("below draft"), which makes
 * `shouldAdvance` treat it as freely advanceable while guaranteeing a
 * real status is never regressed into an unknown one. Never throws.
 */
export function rankOf(status: string | null | undefined): number {
  if (!status) return -1
  return Object.prototype.hasOwnProperty.call(STATUS_RANK, status)
    ? STATUS_RANK[status as QuoteStatus]
    : -1
}

/**
 * Should a quote currently at `current` advance to `target`?
 *
 * Rules:
 *  • `target` must be a canonical status (callers only ever pass one).
 *  • Strictly monotonic: advance ONLY when target outranks current.
 *    Equal rank (idempotent re-fire) or lower rank (out-of-order /
 *    duplicate webhook) is rejected — this is what makes every wiring
 *    site safe to call repeatedly and in any order.
 */
export function shouldAdvance(
  current: string | null | undefined,
  target: QuoteStatus,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(STATUS_RANK, target)) return false
  return STATUS_RANK[target] > rankOf(current)
}

/** The lifecycle status implied by whichever timestamps a quote row
 *  carries, using the same precedence as the migration 027 backfill.
 *  Pure — handy for tests and for classifying rows that pre-date
 *  reliable status writes. */
export function statusFromTimestamps(q: {
  accepted_at?: string | null
  paid_at?: string | null
  viewed_at?: string | null
  sent_at?: string | null
}): QuoteStatus {
  if (q.accepted_at) return 'accepted'
  if (q.paid_at) return 'paid'
  if (q.viewed_at) return 'viewed'
  if (q.sent_at) return 'sent'
  return 'draft'
}

export type AdvanceResult =
  | { advanced: true; from: string | null; to: QuoteStatus }
  | { advanced: false; reason: 'no_advance' | 'not_found' | 'error'; from?: string | null }

/**
 * Move a quote forward to `target` if (and only if) that is a genuine
 * advance. Idempotent and concurrency-tolerant: re-running for the same
 * or an earlier state is a no-op. Sets the matching timestamp column
 * (only when currently NULL — never rewrites the original event time)
 * and always bumps `last_status_at` so the follow-up queue has one
 * sortable "last activity" field.
 *
 * Defensive by contract: returns a result object and NEVER throws, so a
 * lifecycle write can never break the SMS dispatch / webhook / page
 * render it is embedded in.
 */
export async function advanceQuoteStatus(
  supabase: SupabaseClient,
  quoteId: string,
  target: QuoteStatus,
  opts?: { nowIso?: string },
): Promise<AdvanceResult> {
  const nowIso = opts?.nowIso ?? new Date().toISOString()
  try {
    const tsCol = STATUS_TIMESTAMP_COLUMN[target]
    const selectCols = ['status', 'last_status_at']
    if (tsCol) selectCols.push(tsCol)

    const { data: row, error: readErr } = await supabase
      .from('quotes')
      .select(selectCols.join(', '))
      .eq('id', quoteId)
      .maybeSingle()

    if (readErr) {
      console.warn('[quote/lifecycle] read failed — skipping advance', {
        quoteId,
        target,
        message: readErr.message,
      })
      return { advanced: false, reason: 'error' }
    }
    if (!row) {
      return { advanced: false, reason: 'not_found' }
    }

    // supabase-js types a dynamic (non-literal) .select() result as
    // GenericStringError, so go via `unknown` to read our own columns.
    const r = row as unknown as Record<string, unknown>
    const current = r.status as string | null | undefined
    if (!shouldAdvance(current, target)) {
      return { advanced: false, reason: 'no_advance', from: current ?? null }
    }

    const update: Record<string, unknown> = {
      status: target,
      last_status_at: nowIso,
    }
    // Stamp the event timestamp only if it isn't already set, so a
    // re-derived/late advance never overwrites the true first-occurrence
    // time (e.g. a page re-render must not move viewed_at forward).
    if (tsCol && !r[tsCol]) {
      update[tsCol] = nowIso
    }

    const { error: writeErr } = await supabase
      .from('quotes')
      .update(update)
      .eq('id', quoteId)

    if (writeErr) {
      console.warn('[quote/lifecycle] update failed — status unchanged', {
        quoteId,
        target,
        message: writeErr.message,
      })
      return { advanced: false, reason: 'error', from: current ?? null }
    }

    return { advanced: true, from: current ?? null, to: target }
  } catch (e) {
    // Last-resort guard: a lifecycle write must never break its caller.
    console.warn('[quote/lifecycle] advance threw — swallowed', {
      quoteId,
      target,
      message: e instanceof Error ? e.message : String(e),
    })
    return { advanced: false, reason: 'error' }
  }
}
