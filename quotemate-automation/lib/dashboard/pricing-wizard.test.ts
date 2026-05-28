// Tests for the pure Pricing Wizard module.
// No DOM, no fetch — just schema validation + payload shaping.

import { describe, expect, it } from 'vitest'
import {
  RateCardSchema,
  ServiceTogglesSchema,
  BrandPreferencesSchema,
  WizardAnswersSchema,
  buildPatchPayload,
  categoriesForTrades,
  commonBrandsForTrades,
  nextStep,
  prevStep,
  STEP_LABELS,
} from './pricing-wizard'

describe('RateCardSchema', () => {
  it('accepts a valid rate card', () => {
    const r = RateCardSchema.safeParse({
      hourly_rate: 150,
      call_out_minimum: 200,
      default_markup_pct: 30,
      after_hours_multiplier: 1.7,
    })
    expect(r.success).toBe(true)
  })

  it('rejects a non-positive hourly rate', () => {
    const r = RateCardSchema.safeParse({
      hourly_rate: 0,
      call_out_minimum: 200,
      default_markup_pct: 30,
      after_hours_multiplier: 1.7,
    })
    expect(r.success).toBe(false)
  })

  it('rejects a markup over 100%', () => {
    const r = RateCardSchema.safeParse({
      hourly_rate: 150,
      call_out_minimum: 200,
      default_markup_pct: 150,
      after_hours_multiplier: 1.7,
    })
    expect(r.success).toBe(false)
  })

  it('rejects an after-hours multiplier under 1.0', () => {
    const r = RateCardSchema.safeParse({
      hourly_rate: 150,
      call_out_minimum: 200,
      default_markup_pct: 30,
      after_hours_multiplier: 0.8,
    })
    expect(r.success).toBe(false)
  })

  it('rejects an after-hours multiplier over 3.0', () => {
    const r = RateCardSchema.safeParse({
      hourly_rate: 150,
      call_out_minimum: 200,
      default_markup_pct: 30,
      after_hours_multiplier: 3.5,
    })
    expect(r.success).toBe(false)
  })
})

describe('ServiceTogglesSchema', () => {
  it('accepts an empty map', () => {
    expect(ServiceTogglesSchema.safeParse({}).success).toBe(true)
  })

  it('accepts uuid → boolean', () => {
    const r = ServiceTogglesSchema.safeParse({
      'c59fd3cf-cdfd-4b00-ac88-b8d58cacc008': true,
      '6dca084c-10d5-4459-b48f-9b45e4bbc68a': false,
    })
    expect(r.success).toBe(true)
  })

  it('rejects non-uuid keys', () => {
    const r = ServiceTogglesSchema.safeParse({ 'not-a-uuid': true })
    expect(r.success).toBe(false)
  })

  it('rejects non-boolean values', () => {
    const r = ServiceTogglesSchema.safeParse({
      'c59fd3cf-cdfd-4b00-ac88-b8d58cacc008': 'true' as unknown as boolean,
    })
    expect(r.success).toBe(false)
  })
})

describe('BrandPreferencesSchema', () => {
  it('accepts a brand string', () => {
    expect(BrandPreferencesSchema.safeParse({ downlight: 'Clipsal' }).success).toBe(true)
  })

  it('accepts null to clear a preference', () => {
    expect(BrandPreferencesSchema.safeParse({ downlight: null }).success).toBe(true)
  })

  it('accepts empty string to clear a preference', () => {
    expect(BrandPreferencesSchema.safeParse({ downlight: '' }).success).toBe(true)
  })

  it('rejects a category slug over 40 chars', () => {
    const r = BrandPreferencesSchema.safeParse({ ['x'.repeat(41)]: 'Clipsal' })
    expect(r.success).toBe(false)
  })

  it('rejects a brand over 80 chars', () => {
    const r = BrandPreferencesSchema.safeParse({ downlight: 'x'.repeat(81) })
    expect(r.success).toBe(false)
  })
})

describe('WizardAnswersSchema', () => {
  it('accepts every section being optional', () => {
    expect(WizardAnswersSchema.safeParse({}).success).toBe(true)
  })

  it('accepts a full payload', () => {
    const r = WizardAnswersSchema.safeParse({
      rateCard: {
        hourly_rate: 150,
        call_out_minimum: 200,
        default_markup_pct: 30,
        after_hours_multiplier: 1.7,
      },
      services: { 'c59fd3cf-cdfd-4b00-ac88-b8d58cacc008': true },
      brands: { downlight: 'Clipsal', gpo: 'HPM' },
    })
    expect(r.success).toBe(true)
  })
})

describe('buildPatchPayload', () => {
  it('returns null for an empty wizard run', () => {
    expect(buildPatchPayload({})).toBeNull()
  })

  it('returns just `pricing` when only the rate card is filled', () => {
    const body = buildPatchPayload({
      rateCard: {
        hourly_rate: 150,
        call_out_minimum: 200,
        default_markup_pct: 30,
        after_hours_multiplier: 1.7,
      },
    })
    expect(body).not.toBeNull()
    expect(body).toHaveProperty('pricing')
    expect(body!.services).toBeUndefined()
    expect(body!.material_preferences).toBeUndefined()
    expect((body!.pricing as Record<string, unknown>).hourly_rate).toBe(150)
  })

  it('returns just `services` when only the toggle map is filled', () => {
    const body = buildPatchPayload({
      services: { 'c59fd3cf-cdfd-4b00-ac88-b8d58cacc008': true },
    })
    expect(body).not.toBeNull()
    expect(body!.services).toBeDefined()
    expect(body!.pricing).toBeUndefined()
  })

  it('passes the services map through unchanged', () => {
    const toggles = {
      'c59fd3cf-cdfd-4b00-ac88-b8d58cacc008': true,
      '6dca084c-10d5-4459-b48f-9b45e4bbc68a': false,
    }
    const body = buildPatchPayload({ services: toggles })
    expect(body!.services).toEqual(toggles)
  })

  it('strips empty-string brand prefs to null so the dashboard route deletes them', () => {
    const body = buildPatchPayload({
      brands: { downlight: 'Clipsal', gpo: '', smoke_alarm: null },
    })
    expect(body!.material_preferences).toEqual({
      downlight: 'Clipsal',
      gpo: null,
      smoke_alarm: null,
    })
  })

  it('trims brand whitespace', () => {
    const body = buildPatchPayload({
      brands: { downlight: '  Clipsal  ' },
    })
    expect((body!.material_preferences as Record<string, unknown>).downlight).toBe('Clipsal')
  })

  it('skips a brands section that is entirely empty', () => {
    expect(buildPatchPayload({ brands: {} })).toBeNull()
  })

  it('skips a services section that is entirely empty', () => {
    expect(buildPatchPayload({ services: {} })).toBeNull()
  })

  it('combines all three sections in one payload', () => {
    const body = buildPatchPayload({
      rateCard: {
        hourly_rate: 150,
        call_out_minimum: 200,
        default_markup_pct: 30,
        after_hours_multiplier: 1.7,
      },
      services: { 'c59fd3cf-cdfd-4b00-ac88-b8d58cacc008': true },
      brands: { downlight: 'Clipsal' },
    })
    expect(body).not.toBeNull()
    expect(body).toHaveProperty('pricing')
    expect(body).toHaveProperty('services')
    expect(body).toHaveProperty('material_preferences')
  })
})

describe('categoriesForTrades', () => {
  it('returns electrical categories for an electrical-only tradie', () => {
    const cats = categoriesForTrades(['electrical'])
    expect(cats.some((c) => c.slug === 'downlight')).toBe(true)
    expect(cats.some((c) => c.slug === 'gpo')).toBe(true)
    expect(cats.some((c) => c.slug === 'hot_water')).toBe(false)
  })

  it('returns plumbing categories for a plumbing-only tradie', () => {
    const cats = categoriesForTrades(['plumbing'])
    expect(cats.some((c) => c.slug === 'hot_water')).toBe(true)
    expect(cats.some((c) => c.slug === 'drain')).toBe(true)
    expect(cats.some((c) => c.slug === 'downlight')).toBe(false)
  })

  it('returns BOTH for a cross-trade tradie, no duplicates', () => {
    const cats = categoriesForTrades(['electrical', 'plumbing'])
    expect(cats.some((c) => c.slug === 'downlight')).toBe(true)
    expect(cats.some((c) => c.slug === 'hot_water')).toBe(true)
    const slugs = cats.map((c) => c.slug)
    expect(new Set(slugs).size).toBe(slugs.length) // no dups
  })

  it('attaches a friendly label to each category', () => {
    const cats = categoriesForTrades(['electrical'])
    expect(cats.find((c) => c.slug === 'downlight')?.label).toBe('Downlights')
    expect(cats.find((c) => c.slug === 'gpo')?.label).toBe('Power points (GPOs)')
  })

  it('case-insensitive trade matching', () => {
    expect(categoriesForTrades(['ELECTRICAL']).length).toBeGreaterThan(0)
    expect(categoriesForTrades(['Plumbing']).length).toBeGreaterThan(0)
  })

  it('returns empty array for an unknown trade', () => {
    expect(categoriesForTrades(['astronaut'])).toEqual([])
  })
})

describe('commonBrandsForTrades', () => {
  it('returns electrical brands for an electrical-only tradie', () => {
    const brands = commonBrandsForTrades(['electrical'])
    expect(brands).toContain('Clipsal')
    expect(brands).toContain('HPM')
    expect(brands).not.toContain('Rheem')
  })

  it('returns plumbing brands for a plumbing-only tradie', () => {
    const brands = commonBrandsForTrades(['plumbing'])
    expect(brands).toContain('Rheem')
    expect(brands).toContain('Rinnai')
    expect(brands).not.toContain('Clipsal')
  })

  it('returns BOTH sets for a cross-trade tradie, no duplicates', () => {
    const brands = commonBrandsForTrades(['electrical', 'plumbing'])
    expect(brands).toContain('Clipsal')
    expect(brands).toContain('Rheem')
    expect(new Set(brands).size).toBe(brands.length)
  })

  it('is case-insensitive on the trade name', () => {
    expect(commonBrandsForTrades(['ELECTRICAL']).length).toBeGreaterThan(0)
    expect(commonBrandsForTrades(['Plumbing']).length).toBeGreaterThan(0)
  })

  it('returns an empty array for an unknown trade', () => {
    expect(commonBrandsForTrades(['astronaut'])).toEqual([])
  })

  it('returns an empty array for an empty trade list', () => {
    expect(commonBrandsForTrades([])).toEqual([])
  })
})

describe('nextStep / prevStep', () => {
  it('moves forward through the wizard', () => {
    expect(nextStep(0)).toBe(1)
    expect(nextStep(1)).toBe(2)
    expect(nextStep(2)).toBeNull()
  })

  it('moves backward through the wizard', () => {
    expect(prevStep(0)).toBeNull()
    expect(prevStep(1)).toBe(0)
    expect(prevStep(2)).toBe(1)
  })
})

describe('STEP_LABELS', () => {
  it('has exactly 3 labels — one per wizard step', () => {
    expect(STEP_LABELS).toHaveLength(3)
    expect(STEP_LABELS[0]).toContain('rate card')
    expect(STEP_LABELS[1]).toContain('jobs')
    expect(STEP_LABELS[2]).toContain('brand')
  })
})
