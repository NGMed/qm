// WP1 regression coverage — the pricing-book / tenant hard rule.
//
// These lock in the behaviour the brief demands: a misconfigured tenant
// produces a clear, routed-to-inspection result instead of a silent wrong
// price. Every failure mode the old "grab the oldest book" fallback could
// hide is asserted here.

import { describe, expect, it } from 'vitest'
import { resolvePricingBookForIntake } from './pricing-book'

const TENANT_A = '11111111-1111-1111-1111-111111111111'
const TENANT_B = '22222222-2222-2222-2222-222222222222'

describe('resolvePricingBookForIntake', () => {
  it('accepts a book that belongs to the intake tenant and matches the trade', () => {
    const res = resolvePricingBookForIntake({
      intakeTenantId: TENANT_A,
      intakeTrade: 'electrical',
      tenantBook: { id: 'pb1', tenant_id: TENANT_A, trade: 'electrical', hourly_rate: 110 },
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.pricingBook.hourly_rate).toBe(110)
  })

  it('routes to inspection when the intake has no tenant_id (null)', () => {
    const res = resolvePricingBookForIntake({
      intakeTenantId: null,
      intakeTrade: 'electrical',
      tenantBook: { id: 'pb1', tenant_id: TENANT_A, trade: 'electrical' },
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('no_tenant_on_intake')
  })

  it('treats empty-string / whitespace tenant_id as missing (no silent fallback)', () => {
    for (const bad of ['', '   ', undefined]) {
      const res = resolvePricingBookForIntake({
        intakeTenantId: bad,
        intakeTrade: 'plumbing',
        tenantBook: { id: 'pb', tenant_id: TENANT_A, trade: 'plumbing' },
      })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe('no_tenant_on_intake')
    }
  })

  it('routes to inspection when the tenant has no book for this trade', () => {
    const res = resolvePricingBookForIntake({
      intakeTenantId: TENANT_A,
      intakeTrade: 'electrical',
      tenantBook: null,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('no_book_for_tenant')
  })

  it('rejects a book that belongs to a DIFFERENT tenant (the core bug)', () => {
    const res = resolvePricingBookForIntake({
      intakeTenantId: TENANT_A,
      intakeTrade: 'plumbing',
      // This is exactly what the old oldest-book fallback would have handed
      // back: another tradie's plumbing book.
      tenantBook: { id: 'pbB', tenant_id: TENANT_B, trade: 'plumbing', hourly_rate: 999 },
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('tenant_mismatch')
      expect(res.reason).toContain(TENANT_A)
      expect(res.reason).toContain(TENANT_B)
    }
  })

  it('rejects a book whose tenant_id is NULL even if everything else matches', () => {
    const res = resolvePricingBookForIntake({
      intakeTenantId: TENANT_A,
      intakeTrade: 'electrical',
      tenantBook: { id: 'orphan', tenant_id: null, trade: 'electrical' },
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('tenant_mismatch')
  })

  it('rejects a tenant-owned book that is for the wrong trade', () => {
    const res = resolvePricingBookForIntake({
      intakeTenantId: TENANT_A,
      intakeTrade: 'electrical',
      tenantBook: { id: 'pb', tenant_id: TENANT_A, trade: 'plumbing' },
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('trade_mismatch')
  })

  it('never returns ok:true for a cross-tenant book under any trade', () => {
    for (const trade of ['electrical', 'plumbing']) {
      const res = resolvePricingBookForIntake({
        intakeTenantId: TENANT_A,
        intakeTrade: trade,
        tenantBook: { id: 'x', tenant_id: TENANT_B, trade },
      })
      expect(res.ok).toBe(false)
    }
  })
})
