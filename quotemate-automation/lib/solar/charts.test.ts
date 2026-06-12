import { describe, it, expect } from 'vitest'
import {
  AU_MONTHLY_PRODUCTION_SHAPE,
  buildMonthlyProductionChart,
  buildUtilityCostsChart,
  buildMonthlyBillComparisonChart,
  buildCumulativeSavingsChart,
} from './charts'

describe('AU_MONTHLY_PRODUCTION_SHAPE', () => {
  it('has 12 fractions summing to exactly 1', () => {
    expect(AU_MONTHLY_PRODUCTION_SHAPE).toHaveLength(12)
    const sum = AU_MONTHLY_PRODUCTION_SHAPE.reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 12)
  })

  it('is southern-hemisphere: December beats June', () => {
    expect(AU_MONTHLY_PRODUCTION_SHAPE[11]).toBeGreaterThan(AU_MONTHLY_PRODUCTION_SHAPE[5])
    expect(AU_MONTHLY_PRODUCTION_SHAPE[0]).toBeGreaterThan(AU_MONTHLY_PRODUCTION_SHAPE[6])
  })
})

describe('buildMonthlyProductionChart', () => {
  it('renders 12 bars and the annual total in the caption', () => {
    const out = buildMonthlyProductionChart({ annual_kwh_ac: 9000, theme: 'dark' })!
    expect(out.svg.match(/<rect /g)?.length).toBe(12)
    expect(out.caption).toContain('9,000 kWh/yr')
    expect(out.caption.toLowerCase()).toContain('modelled')
  })

  it('null on non-positive production', () => {
    expect(buildMonthlyProductionChart({ annual_kwh_ac: 0, theme: 'dark' })).toBeNull()
    expect(buildMonthlyProductionChart({ annual_kwh_ac: Number.NaN, theme: 'light' })).toBeNull()
  })

  it('dark and light themes produce different palettes', () => {
    const dark = buildMonthlyProductionChart({ annual_kwh_ac: 9000, theme: 'dark' })!
    const light = buildMonthlyProductionChart({ annual_kwh_ac: 9000, theme: 'light' })!
    expect(dark.svg).not.toBe(light.svg)
    expect(light.svg).toContain('#e6ebf0') // light grid
    expect(dark.svg).toContain('#27313d') // dark grid
  })
})

describe('buildUtilityCostsChart', () => {
  it('labels both bars with AU currency values', () => {
    const out = buildUtilityCostsChart({
      annual_bill_before_aud: 1920,
      annual_bill_with_solar_aud: 363,
      source: 'personal',
      theme: 'dark',
    })!
    expect(out.svg).toContain('$1,920')
    expect(out.svg).toContain('$363')
    expect(out.svg).toContain('BEFORE SOLAR')
    expect(out.svg).toContain('WITH SOLAR')
    expect(out.caption).toContain('quarterly bill you provided')
  })

  it('modelled source carries the modelled label (degradation §4.6)', () => {
    const out = buildUtilityCostsChart({
      annual_bill_before_aud: 1920,
      annual_bill_with_solar_aud: 500,
      source: 'modelled',
      theme: 'light',
    })!
    expect(out.caption).toContain('Modelled on typical usage')
  })

  it('negative with-solar bill clamps the bar and notes the credit', () => {
    const out = buildUtilityCostsChart({
      annual_bill_before_aud: 320,
      annual_bill_with_solar_aud: -600,
      source: 'personal',
      theme: 'dark',
    })!
    expect(out.caption).toContain('net credit of $600/yr')
  })

  it('null when the before-bill is non-positive', () => {
    expect(
      buildUtilityCostsChart({
        annual_bill_before_aud: 0,
        annual_bill_with_solar_aud: 0,
        source: 'modelled',
        theme: 'dark',
      }),
    ).toBeNull()
  })
})

describe('buildMonthlyBillComparisonChart', () => {
  it('renders 24 bars (12 paired months)', () => {
    const out = buildMonthlyBillComparisonChart({
      annual_bill_before_aud: 1920,
      annual_bill_with_solar_aud: 363,
      source: 'personal',
      theme: 'dark',
    })!
    expect(out.svg.match(/<rect /g)?.length).toBe(24)
    expect(out.caption).toContain('Teal = before solar, orange = with solar')
  })

  it('null on a non-positive before-bill', () => {
    expect(
      buildMonthlyBillComparisonChart({
        annual_bill_before_aud: Number.NaN,
        annual_bill_with_solar_aud: 100,
        source: 'modelled',
        theme: 'light',
      }),
    ).toBeNull()
  })
})

describe('buildCumulativeSavingsChart', () => {
  const series = Array.from({ length: 26 }, (_, y) => ({
    year: y,
    cumulative_aud: y * 1500,
  }))

  it('draws the line, endpoint value, and break-even reference', () => {
    const out = buildCumulativeSavingsChart({
      series,
      net_cost_aud: 8000,
      theme: 'dark',
    })!
    expect(out.svg).toContain('<polyline')
    expect(out.svg).toContain('$37,500') // 25 × 1500 endpoint
    expect(out.svg).toContain('SYSTEM COST $8,000')
    expect(out.caption).toContain('25 years')
    expect(out.caption).toContain('not a guarantee')
  })

  it('omits the break-even line when net cost is absent', () => {
    const out = buildCumulativeSavingsChart({ series, theme: 'light' })!
    expect(out.svg).not.toContain('SYSTEM COST')
  })

  it('null on a degenerate series', () => {
    expect(buildCumulativeSavingsChart({ series: [], theme: 'dark' })).toBeNull()
    expect(
      buildCumulativeSavingsChart({ series: [{ year: 0, cumulative_aud: 0 }], theme: 'dark' }),
    ).toBeNull()
  })

  it('is deterministic', () => {
    const a = buildCumulativeSavingsChart({ series, net_cost_aud: 8000, theme: 'dark' })!
    const b = buildCumulativeSavingsChart({ series, net_cost_aud: 8000, theme: 'dark' })!
    expect(a.svg).toBe(b.svg)
  })
})
