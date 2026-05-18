// WP7 regression coverage — the needs-follow-up queue selector.
//
// Locks in exactly who the VA should and should not be chasing:
// delivered-but-not-converted-and-stale only, paid/accepted excluded
// (by timestamp OR by status so a webhook lag can't hide a sale),
// same-day quotes excluded, already-actioned excluded, oldest-first.

import { describe, expect, it } from 'vitest'
import {
  FOLLOWUP_MIN_AGE_HOURS,
  ageHoursSince,
  compareByStaleness,
  followupReason,
  isConverted,
  isFollowupCandidate,
  lastActivityIso,
  reachedCustomer,
  selectFollowups,
  type FollowupQuote,
} from './followup'

const NOW = Date.parse('2026-05-18T12:00:00.000Z')
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

describe('FOLLOWUP_MIN_AGE_HOURS', () => {
  it('defaults to 24h so same-day quotes are left alone', () => {
    expect(FOLLOWUP_MIN_AGE_HOURS).toBe(24)
  })
})

describe('lastActivityIso', () => {
  it('prefers last_status_at, then falls back through the ladder', () => {
    expect(lastActivityIso({ last_status_at: 'A', sent_at: 'B' })).toBe('A')
    expect(lastActivityIso({ accepted_at: 'A', paid_at: 'B' })).toBe('A')
    expect(lastActivityIso({ sent_at: 'S', created_at: 'C' })).toBe('S')
    expect(lastActivityIso({ created_at: 'C' })).toBe('C')
    expect(lastActivityIso({})).toBeNull()
  })
})

describe('ageHoursSince', () => {
  it('computes hours between iso and now', () => {
    expect(ageHoursSince(hoursAgo(24), NOW)).toBeCloseTo(24, 5)
    expect(ageHoursSince(hoursAgo(0.5), NOW)).toBeCloseTo(0.5, 5)
  })
  it('returns null for missing/unparseable input', () => {
    expect(ageHoursSince(null, NOW)).toBeNull()
    expect(ageHoursSince(undefined, NOW)).toBeNull()
    expect(ageHoursSince('not-a-date', NOW)).toBeNull()
  })
})

describe('reachedCustomer', () => {
  it('true when status >= sent or sent_at present', () => {
    expect(reachedCustomer({ status: 'sent' })).toBe(true)
    expect(reachedCustomer({ status: 'viewed' })).toBe(true)
    expect(reachedCustomer({ status: 'accepted' })).toBe(true)
    expect(reachedCustomer({ sent_at: hoursAgo(1) })).toBe(true)
  })
  it('false for an undelivered draft', () => {
    expect(reachedCustomer({ status: 'draft' })).toBe(false)
    expect(reachedCustomer({})).toBe(false)
  })
})

describe('isConverted', () => {
  it('true on either authoritative signal (timestamp OR status)', () => {
    expect(isConverted({ paid_at: hoursAgo(1) })).toBe(true)
    expect(isConverted({ accepted_at: hoursAgo(1) })).toBe(true)
    expect(isConverted({ status: 'paid' })).toBe(true)
    expect(isConverted({ status: 'accepted' })).toBe(true)
  })
  it('false when still sent/viewed with no payment', () => {
    expect(isConverted({ status: 'sent' })).toBe(false)
    expect(isConverted({ status: 'viewed' })).toBe(false)
  })
})

describe('isFollowupCandidate', () => {
  const sentStale: FollowupQuote = {
    status: 'sent',
    sent_at: hoursAgo(48),
    last_status_at: hoursAgo(48),
  }

  it('includes a stale, delivered, unconverted quote', () => {
    expect(isFollowupCandidate(sentStale, NOW)).toBe(true)
  })

  it('includes a stale viewed-but-unpaid quote', () => {
    expect(
      isFollowupCandidate(
        { status: 'viewed', sent_at: hoursAgo(50), viewed_at: hoursAgo(40), last_status_at: hoursAgo(40) },
        NOW,
      ),
    ).toBe(true)
  })

  it('excludes an undelivered draft', () => {
    expect(
      isFollowupCandidate({ status: 'draft', created_at: hoursAgo(72) }, NOW),
    ).toBe(false)
  })

  it('excludes a same-day (too recent) quote', () => {
    expect(
      isFollowupCandidate(
        { status: 'sent', sent_at: hoursAgo(3), last_status_at: hoursAgo(3) },
        NOW,
      ),
    ).toBe(false)
  })

  it('excludes paid and accepted quotes (timestamp or status)', () => {
    expect(
      isFollowupCandidate(
        { status: 'sent', sent_at: hoursAgo(48), paid_at: hoursAgo(2), last_status_at: hoursAgo(2) },
        NOW,
      ),
    ).toBe(false)
    expect(
      isFollowupCandidate(
        { status: 'paid', sent_at: hoursAgo(48), last_status_at: hoursAgo(30) },
        NOW,
      ),
    ).toBe(false)
    expect(
      isFollowupCandidate(
        { status: 'accepted', sent_at: hoursAgo(48), last_status_at: hoursAgo(30) },
        NOW,
      ),
    ).toBe(false)
  })

  it('excludes a quote a VA already actioned, unless includeActioned', () => {
    const actioned: FollowupQuote = {
      status: 'sent',
      sent_at: hoursAgo(48),
      last_status_at: hoursAgo(48),
      followed_up_at: hoursAgo(2),
    }
    expect(isFollowupCandidate(actioned, NOW)).toBe(false)
    expect(isFollowupCandidate(actioned, NOW, { includeActioned: true })).toBe(
      true,
    )
  })

  it('respects a custom minAgeHours threshold', () => {
    const q: FollowupQuote = {
      status: 'sent',
      sent_at: hoursAgo(5),
      last_status_at: hoursAgo(5),
    }
    expect(isFollowupCandidate(q, NOW)).toBe(false) // 5h < 24h default
    expect(isFollowupCandidate(q, NOW, { minAgeHours: 4 })).toBe(true)
  })

  it('is exactly inclusive at the threshold boundary', () => {
    const q: FollowupQuote = {
      status: 'sent',
      sent_at: hoursAgo(24),
      last_status_at: hoursAgo(24),
    }
    expect(isFollowupCandidate(q, NOW)).toBe(true) // age >= 24
  })
})

describe('followupReason', () => {
  it('distinguishes opened vs not opened, and actioned', () => {
    expect(followupReason({ status: 'sent' })).toBe('Sent, not opened')
    expect(followupReason({ status: 'viewed' })).toBe('Opened, not paid')
    expect(followupReason({ status: 'sent', viewed_at: 'x' })).toBe(
      'Opened, not paid',
    )
    expect(
      followupReason({ status: 'sent', followed_up_at: 'x' }),
    ).toBe('Contacted - awaiting reply')
  })
})

describe('selectFollowups', () => {
  it('filters to candidates and orders oldest activity first', () => {
    const quotes: FollowupQuote[] = [
      { status: 'sent', sent_at: hoursAgo(30), last_status_at: hoursAgo(30) },
      { status: 'paid', sent_at: hoursAgo(99), last_status_at: hoursAgo(99) }, // converted
      { status: 'sent', sent_at: hoursAgo(72), last_status_at: hoursAgo(72) },
      { status: 'draft', created_at: hoursAgo(99) }, // never delivered
      { status: 'viewed', sent_at: hoursAgo(5), last_status_at: hoursAgo(5) }, // too recent
    ]
    const out = selectFollowups(quotes, NOW)
    expect(out).toHaveLength(2)
    // oldest (72h) before newer (30h)
    expect(out[0].last_status_at).toBe(hoursAgo(72))
    expect(out[1].last_status_at).toBe(hoursAgo(30))
  })

  it('returns [] when nothing qualifies', () => {
    expect(
      selectFollowups(
        [{ status: 'draft' }, { status: 'paid', paid_at: hoursAgo(50) }],
        NOW,
      ),
    ).toEqual([])
  })
})

describe('compareByStaleness', () => {
  it('sorts unknown-activity rows last', () => {
    const a: FollowupQuote = { last_status_at: hoursAgo(10) }
    const b: FollowupQuote = {}
    expect(compareByStaleness(a, b)).toBeLessThan(0)
    expect(compareByStaleness(b, a)).toBeGreaterThan(0)
  })
})
