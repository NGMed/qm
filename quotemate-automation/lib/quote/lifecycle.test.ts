// WP7 regression coverage — quote lifecycle is monotonic and reliable.
//
// The follow-up queue is only as trustworthy as these transitions, so
// this locks in: the ladder order, that a quote never moves backwards
// (duplicate/out-of-order events are no-ops), that unknown/legacy
// statuses never crash and never regress a real status, and the
// status<->timestamp mapping used by the wiring sites + backfill.

import { describe, expect, it } from 'vitest'
import {
  QUOTE_STATUSES,
  STATUS_RANK,
  STATUS_TIMESTAMP_COLUMN,
  rankOf,
  shouldAdvance,
  statusFromTimestamps,
} from './lifecycle'

describe('quote lifecycle ladder', () => {
  it('has the canonical order draft<sent<viewed<paid<accepted', () => {
    expect(QUOTE_STATUSES).toEqual([
      'draft',
      'sent',
      'viewed',
      'paid',
      'accepted',
    ])
    expect(STATUS_RANK.draft).toBe(0)
    expect(STATUS_RANK.sent).toBe(1)
    expect(STATUS_RANK.viewed).toBe(2)
    expect(STATUS_RANK.paid).toBe(3)
    expect(STATUS_RANK.accepted).toBe(4)
  })

  it('ranks are strictly increasing along the ladder', () => {
    for (let i = 1; i < QUOTE_STATUSES.length; i++) {
      expect(rankOf(QUOTE_STATUSES[i])).toBeGreaterThan(
        rankOf(QUOTE_STATUSES[i - 1]),
      )
    }
  })
})

describe('rankOf', () => {
  it('returns the ladder index for canonical statuses', () => {
    expect(rankOf('draft')).toBe(0)
    expect(rankOf('accepted')).toBe(4)
  })

  it('returns -1 for null, empty, legacy and unknown statuses', () => {
    expect(rankOf(null)).toBe(-1)
    expect(rankOf(undefined)).toBe(-1)
    expect(rankOf('')).toBe(-1)
    expect(rankOf('inspection')).toBe(-1) // legacy value, tolerated
    expect(rankOf('totally-made-up')).toBe(-1)
  })

  it('never throws on hostile input', () => {
    expect(() => rankOf('__proto__')).not.toThrow()
    expect(rankOf('__proto__')).toBe(-1)
    expect(rankOf('constructor')).toBe(-1)
    expect(rankOf('hasOwnProperty')).toBe(-1)
  })
})

describe('shouldAdvance — monotonic guarantee', () => {
  it('advances forward one step', () => {
    expect(shouldAdvance('draft', 'sent')).toBe(true)
    expect(shouldAdvance('sent', 'viewed')).toBe(true)
    expect(shouldAdvance('viewed', 'paid')).toBe(true)
    expect(shouldAdvance('paid', 'accepted')).toBe(true)
  })

  it('advances forward across multiple steps', () => {
    expect(shouldAdvance('draft', 'paid')).toBe(true)
    expect(shouldAdvance('sent', 'accepted')).toBe(true)
  })

  it('rejects an equal-rank re-fire (idempotent)', () => {
    expect(shouldAdvance('sent', 'sent')).toBe(false)
    expect(shouldAdvance('paid', 'paid')).toBe(false)
  })

  it('rejects any backwards / out-of-order transition', () => {
    expect(shouldAdvance('accepted', 'paid')).toBe(false)
    expect(shouldAdvance('paid', 'viewed')).toBe(false)
    expect(shouldAdvance('viewed', 'sent')).toBe(false)
    expect(shouldAdvance('sent', 'draft')).toBe(false)
    // A duplicate Stripe webhook on an already-accepted quote is a no-op.
    expect(shouldAdvance('accepted', 'paid')).toBe(false)
  })

  it('advances a legacy/unknown status forward (it ranks below draft)', () => {
    // An inspection-routed quote whose SMS goes out is genuinely "sent".
    expect(shouldAdvance('inspection', 'sent')).toBe(true)
    expect(shouldAdvance(null, 'sent')).toBe(true)
    expect(shouldAdvance(undefined, 'paid')).toBe(true)
  })

  it('never advances to a non-canonical target', () => {
    // @ts-expect-error target is typed QuoteStatus; assert runtime guard too
    expect(shouldAdvance('draft', 'bogus')).toBe(false)
    // @ts-expect-error non-canonical target must be rejected at runtime
    expect(shouldAdvance('draft', '__proto__')).toBe(false)
  })
})

describe('STATUS_TIMESTAMP_COLUMN', () => {
  it('maps each lifecycle status to its event timestamp column', () => {
    expect(STATUS_TIMESTAMP_COLUMN.draft).toBeNull()
    expect(STATUS_TIMESTAMP_COLUMN.sent).toBe('sent_at')
    expect(STATUS_TIMESTAMP_COLUMN.viewed).toBe('viewed_at')
    expect(STATUS_TIMESTAMP_COLUMN.paid).toBe('paid_at')
    expect(STATUS_TIMESTAMP_COLUMN.accepted).toBe('accepted_at')
  })
})

describe('statusFromTimestamps — backfill precedence', () => {
  it('uses the highest set timestamp', () => {
    expect(statusFromTimestamps({})).toBe('draft')
    expect(statusFromTimestamps({ sent_at: 't' })).toBe('sent')
    expect(statusFromTimestamps({ sent_at: 't', viewed_at: 't' })).toBe(
      'viewed',
    )
    expect(
      statusFromTimestamps({ sent_at: 't', viewed_at: 't', paid_at: 't' }),
    ).toBe('paid')
    expect(
      statusFromTimestamps({
        sent_at: 't',
        viewed_at: 't',
        paid_at: 't',
        accepted_at: 't',
      }),
    ).toBe('accepted')
  })

  it('classifies a paid-but-not-viewed quote as paid (skipped view)', () => {
    expect(statusFromTimestamps({ sent_at: 't', paid_at: 't' })).toBe('paid')
  })
})
