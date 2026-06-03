import { describe, expect, it } from 'vitest'
import {
  SOLAR_ALLOWANCE_DEFAULTS,
  buildSolarDetectPrompt,
  computeSolarAllowance,
  parseSolarDetection,
  solarAllowanceConfigFromCard,
} from './solar'
import { DEFAULT_ROOFING_RATE_CARD } from './pricing'
import type { SolarDetection } from './solar'
import type { RoofingRateCard } from './types'

function detection(overrides: Partial<SolarDetection> = {}): SolarDetection {
  return {
    has_solar: true,
    array_count: 2,
    panel_count_estimate: 40,
    approx_area_m2: 68,
    confidence: 'high',
    notes: 'two arrays',
    ...overrides,
  }
}

describe('buildSolarDetectPrompt', () => {
  it('asks for strict JSON about the centre building', () => {
    const p = buildSolarDetectPrompt()
    expect(p.toLowerCase()).toContain('centre')
    expect(p).toContain('has_solar')
    expect(p.toLowerCase()).toContain('json')
  })
})

describe('parseSolarDetection', () => {
  it('parses clean JSON', () => {
    const d = parseSolarDetection('{"has_solar":true,"array_count":2,"panel_count_estimate":40,"approx_area_m2":68,"confidence":"high","notes":"x"}')
    expect(d?.has_solar).toBe(true)
    expect(d?.array_count).toBe(2)
    expect(d?.confidence).toBe('high')
  })

  it('strips ```json code fences', () => {
    const d = parseSolarDetection('```json\n{"has_solar":false,"array_count":0,"confidence":"high","notes":""}\n```')
    expect(d?.has_solar).toBe(false)
    expect(d?.array_count).toBe(0)
  })

  it('defaults array_count to 1 when solar present but count missing', () => {
    const d = parseSolarDetection('{"has_solar":true,"confidence":"medium","notes":""}')
    expect(d?.array_count).toBe(1)
  })

  it('coerces an unknown confidence to low', () => {
    const d = parseSolarDetection('{"has_solar":true,"array_count":1,"confidence":"definitely","notes":""}')
    expect(d?.confidence).toBe('low')
  })

  it('returns null for non-JSON or missing has_solar', () => {
    expect(parseSolarDetection('not json')).toBeNull()
    expect(parseSolarDetection('{"array_count":2}')).toBeNull()
    expect(parseSolarDetection('')).toBeNull()
  })
})

describe('computeSolarAllowance', () => {
  it('returns null when there is no solar', () => {
    expect(computeSolarAllowance(detection({ has_solar: false }), { intent: 'full_reroof' })).toBeNull()
    expect(computeSolarAllowance(null, { intent: 'full_reroof' })).toBeNull()
  })

  it('applies on a high-confidence full re-roof and prices base + per-array', () => {
    const a = computeSolarAllowance(detection({ array_count: 2 }), { intent: 'full_reroof' })
    expect(a?.applies).toBe(true)
    // base 1000 + 700 × 2 = 2400 ex; ×1.1 = 2640 inc
    expect(a?.ex_gst).toBe(2400)
    expect(a?.inc_gst).toBe(2640)
    expect(a?.arrays).toBe(2)
    expect(a?.electrician_note.toLowerCase()).toContain('electrician')
  })

  it('flags but does NOT apply on low confidence', () => {
    const a = computeSolarAllowance(detection({ confidence: 'low' }), { intent: 'full_reroof' })
    expect(a?.applies).toBe(false)
    expect(a?.low_confidence).toBe(true)
  })

  it('does NOT apply on a non-reroof intent (patch/leak does not disturb panels)', () => {
    const a = computeSolarAllowance(detection(), { intent: 'leak_trace' })
    expect(a?.applies).toBe(false)
  })

  it('respects tenant-configured base + per-array and gst flag', () => {
    const a = computeSolarAllowance(detection({ array_count: 1 }), {
      intent: 'full_reroof',
      base_ex_gst: 1500,
      per_array_ex_gst: 500,
      gstRegistered: false,
    })
    // 1500 + 500 × 1 = 2000 ex; not GST registered → inc == ex
    expect(a?.ex_gst).toBe(2000)
    expect(a?.inc_gst).toBe(2000)
  })
})

describe('solarAllowanceConfigFromCard', () => {
  it('falls back to defaults on a plain card', () => {
    const cfg = solarAllowanceConfigFromCard(DEFAULT_ROOFING_RATE_CARD)
    expect(cfg.base_ex_gst).toBe(SOLAR_ALLOWANCE_DEFAULTS.base_ex_gst)
    expect(cfg.per_array_ex_gst).toBe(SOLAR_ALLOWANCE_DEFAULTS.per_array_ex_gst)
  })

  it('reads stashed overlay values', () => {
    const card = {
      ...DEFAULT_ROOFING_RATE_CARD,
      solar_detach_reinstate_base_ex_gst: 1200,
      solar_detach_reinstate_per_array_ex_gst: 800,
    } as RoofingRateCard
    const cfg = solarAllowanceConfigFromCard(card)
    expect(cfg.base_ex_gst).toBe(1200)
    expect(cfg.per_array_ex_gst).toBe(800)
  })
})
