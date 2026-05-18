// WP1 — the hard "this pricing book must belong to this tenant" rule.
//
// Background (the bug this fixes):
//   /api/estimate/draft used to do a tenant-scoped pricing_book lookup and
//   then, if that returned nothing, "grab the oldest book for the trade"
//   (`.eq('trade', t).order('id').limit(1)`). With more than one tenant on
//   a trade that silently quoted Tradie A's job on Tradie B's rates/markup
//   — no error, no log a human would notice. A plumber could be quoted on
//   another plumber's numbers and nobody would know.
//
// The fix is a single pure function that decides, given the intake's tenant
// and the (already tenant-scoped) row that came back from the DB, whether
// that row may be used. It NEVER falls back to another tenant's book — when
// the book can't be resolved for THIS tenant it returns ok:false and the
// caller routes the quote to the paid inspection instead, with the reason
// logged. Keeping this logic pure makes it unit-testable without a DB.

export type PricingBookRow = {
  id?: string | null
  tenant_id?: string | null
  trade?: string | null
  [k: string]: unknown
}

export type PricingBookResolutionFailureCode =
  | 'no_tenant_on_intake' // intake has no tenant_id — can't know whose book
  | 'no_book_for_tenant' // tenant has no pricing_book row for this trade
  | 'tenant_mismatch' // a book was loaded but it belongs to another tenant
  | 'trade_mismatch' // the book is for a different trade than the intake

export type PricingBookResolution =
  | { ok: true; pricingBook: PricingBookRow }
  | { ok: false; code: PricingBookResolutionFailureCode; reason: string }

function blank(v: string | null | undefined): boolean {
  return v == null || v.trim() === ''
}

/**
 * Decide whether `tenantBook` (the row returned by the tenant_id+trade
 * scoped query) may be used to price this intake.
 *
 * Hard rule (WP1): the pricing book MUST belong to the intake's tenant and
 * match its trade. Any failure → ok:false with a human-readable reason; the
 * caller routes the quote to inspection. There is deliberately NO fallback
 * to "some other tradie's book" — that silent fallback IS the bug.
 */
export function resolvePricingBookForIntake(args: {
  intakeTenantId: string | null | undefined
  intakeTrade: string
  tenantBook: PricingBookRow | null | undefined
}): PricingBookResolution {
  const intakeTenantId = blank(args.intakeTenantId) ? null : args.intakeTenantId!.trim()
  const intakeTrade = (args.intakeTrade ?? '').trim()
  const book = args.tenantBook ?? null

  if (!intakeTenantId) {
    return {
      ok: false,
      code: 'no_tenant_on_intake',
      reason:
        'Intake has no tenant_id — cannot resolve which tradie this pricing book belongs to. ' +
        'Routing to inspection rather than silently borrowing another tradie\'s prices (WP1).',
    }
  }

  if (!book) {
    return {
      ok: false,
      code: 'no_book_for_tenant',
      reason:
        `No pricing_book row for tenant=${intakeTenantId} trade=${intakeTrade || 'unknown'}. ` +
        'Routing to inspection — refusing to fall back to another tradie\'s book (WP1).',
    }
  }

  const bookTenantId = blank(book.tenant_id as string | null | undefined)
    ? null
    : String(book.tenant_id).trim()

  if (bookTenantId !== intakeTenantId) {
    return {
      ok: false,
      code: 'tenant_mismatch',
      reason:
        `Loaded pricing_book belongs to tenant=${bookTenantId ?? 'NULL'} but the intake's ` +
        `tenant is ${intakeTenantId}. Using it would silently misprice this job — ` +
        'routing to inspection instead (WP1).',
    }
  }

  const bookTrade = blank(book.trade as string | null | undefined)
    ? null
    : String(book.trade).trim()

  if (intakeTrade && bookTrade && bookTrade !== intakeTrade) {
    return {
      ok: false,
      code: 'trade_mismatch',
      reason:
        `Loaded pricing_book is for trade=${bookTrade} but the intake is trade=${intakeTrade}. ` +
        'Routing to inspection rather than pricing one trade on another\'s rates (WP1).',
    }
  }

  return { ok: true, pricingBook: book }
}
