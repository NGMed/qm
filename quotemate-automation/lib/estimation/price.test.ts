import { describe, it, expect } from 'vitest'
import { matchAssembly, matchAssemblyWithSignals, priceTakeoff, type AssemblyRow, type PricingBook } from './price'

// The 5 seeded electrical assemblies (sql/init.sql).
const ASSEMBLIES: AssemblyRow[] = [
  { name: 'Install LED downlight', category: 'lighting', default_unit_price_ex_gst: 28, default_labour_hours: 0.4 },
  { name: 'Replace double GPO', category: 'power', default_unit_price_ex_gst: 22, default_labour_hours: 0.3 },
  { name: 'Install customer-supplied ceiling fan', category: 'ventilation', default_unit_price_ex_gst: 35, default_labour_hours: 1.0 },
  { name: 'Hardwire 240V smoke alarm', category: 'safety', default_unit_price_ex_gst: 30, default_labour_hours: 0.5 },
  { name: 'Install outdoor IP-rated LED light', category: 'lighting', default_unit_price_ex_gst: 32, default_labour_hours: 0.6 },
]

const BOOK: PricingBook = { hourly_rate: 110, default_markup_pct: 28, min_labour_hours: 2, gst_registered: true }

describe('matchAssembly', () => {
  it('maps a GPO take-off item to the GPO assembly', () => {
    expect(matchAssembly('Double GPO (standard)', ASSEMBLIES)?.name).toBe('Replace double GPO')
  })
  it('maps a recessed downlight to the LED downlight assembly', () => {
    expect(matchAssembly('L2 Recessed Downlight white IP44', ASSEMBLIES)?.name).toBe('Install LED downlight')
  })
  it('does NOT cross-match an exhaust fan to the ceiling fan assembly', () => {
    expect(matchAssembly('Exhaust Fan (E2)', ASSEMBLIES)).toBeNull()
  })
  it('returns null for an item with no catalogue match', () => {
    expect(matchAssembly('L6 Feature Pendant Light', ASSEMBLIES)).toBeNull()
  })
})

describe('matchAssembly — exact-name (add-to-catalogue path)', () => {
  // A "Security camera (CS)" take-off item shares NO curated SIGNAL phrase, so
  // it is unmatched against the seed catalogue. Once the tradie adds a custom
  // assembly named exactly like the item, re-pricing must match it by name.
  const SECURITY_CAM: AssemblyRow = {
    name: 'Security camera (CS)',
    category: 'security_camera',
    default_unit_price_ex_gst: 320,
    default_labour_hours: 1.5,
  }

  it('does not match a signal-less item against the seed catalogue', () => {
    expect(matchAssembly('Security camera (CS)', ASSEMBLIES)).toBeNull()
  })

  it('matches once an exact-name custom assembly is added', () => {
    const withCustom = [SECURITY_CAM, ...ASSEMBLIES]
    const m = matchAssemblyWithSignals('Security camera (CS)', withCustom)
    expect(m?.assembly.name).toBe('Security camera (CS)')
    expect(m?.signals).toContain('exact name')
  })

  it('is case- and punctuation-insensitive on the exact-name match', () => {
    const withCustom = [SECURITY_CAM, ...ASSEMBLIES]
    expect(matchAssembly('SECURITY CAMERA  (cs)', withCustom)?.name).toBe('Security camera (CS)')
  })

  it('lets an exact-name custom row outrank a looser signal match', () => {
    // "Data point" hits the 'data point' signal on a shared assembly, but the
    // tenant's own exactly-named row must win.
    const shared: AssemblyRow = { name: 'Generic data outlet', category: 'data', default_unit_price_ex_gst: 40, default_labour_hours: 0.5 }
    const custom: AssemblyRow = { name: 'Data point Cat 6 Ethernet', category: 'data', default_unit_price_ex_gst: 55, default_labour_hours: 0.6 }
    const m = matchAssemblyWithSignals('Data point Cat 6 Ethernet', [custom, shared])
    expect(m?.assembly.name).toBe('Data point Cat 6 Ethernet')
  })

  it('prices a freshly-added item end-to-end', () => {
    const bom = priceTakeoff([{ type: 'Security camera (CS)', count: 11 }], [SECURITY_CAM, ...ASSEMBLIES], BOOK)
    expect(bom.unmatched).toHaveLength(0)
    expect(bom.lines).toHaveLength(1)
    const line = bom.lines[0]
    expect(line.matched).toBe('Security camera (CS)')
    expect(line.unitPriceExGst).toBe(409.6) // 320 × 1.28
    expect(line.materialExGst).toBe(4505.6) // 11 × 409.6
    expect(line.labourHours).toBe(16.5) // 11 × 1.5
    expect(line.labourExGst).toBe(1815) // 16.5 × 110
  })
})

describe('priceTakeoff', () => {
  it('prices matched items, flags unmatched, applies markup + labour + GST', () => {
    const bom = priceTakeoff(
      [
        { type: 'Double GPO (standard)', count: 10 },
        { type: 'L2 Recessed Downlight white IP44', count: 5 },
        { type: 'Ceiling fan', count: 2 },
        { type: 'L6 Feature Pendant Light', count: 3 }, // unmatched
      ],
      ASSEMBLIES,
      BOOK,
    )
    expect(bom.lines).toHaveLength(3)
    expect(bom.unmatched).toEqual([{ type: 'L6 Feature Pendant Light', count: 3 }])

    const gpo = bom.lines.find((l) => l.matched === 'Replace double GPO')!
    expect(gpo.unitPriceExGst).toBe(28.16) // 22 × 1.28
    expect(gpo.materialExGst).toBe(281.6)
    expect(gpo.labourHours).toBe(3) // 10 × 0.3
    expect(gpo.labourExGst).toBe(330) // 3 × 110

    expect(bom.materialExGst).toBe(550.4)
    expect(bom.labourExGst).toBe(770)
    expect(bom.labourFloorAddedExGst).toBe(0) // 7 hrs ≥ 2
    expect(bom.subtotalExGst).toBe(1320.4)
    expect(bom.gstExGst).toBe(132.04)
    expect(bom.totalIncGst).toBe(1452.44)
  })

  it('builds a full audit trace per priced line (count source, match signals, formulas)', () => {
    const bom = priceTakeoff(
      [{ type: 'Double GPO (standard)', count: 4, confidence: 'medium', note: 'left wall 2, amenities 1, reception 1 = 4' }],
      ASSEMBLIES,
      BOOK,
    )
    const trace = bom.lines[0].trace
    expect(trace.countSource).toEqual({ confidence: 'medium', tally: 'left wall 2, amenities 1, reception 1 = 4' })
    expect(trace.matchedSignals).toContain('double gpo')
    expect(trace.baseUnitPriceExGst).toBe(22)
    expect(trace.markupPct).toBe(28)
    expect(trace.materialFormula).toBe('4 × ($22.00 + 28%) = 4 × $28.16 = $112.64')
    expect(trace.unitLabourHours).toBe(0.3)
    expect(trace.hourlyRate).toBe(110)
    expect(trace.labourFormula).toBe('4 × 0.3h × $110.00/h = 1.2h = $132.00')
  })

  it('applies the min-labour floor on a tiny job', () => {
    const bom = priceTakeoff([{ type: 'Double GPO', count: 1 }], ASSEMBLIES, BOOK)
    // 0.3 labour hrs < 2.0 min → floor adds (2 − 0.3) × 110 = 187
    expect(bom.labourFloorAddedExGst).toBe(187)
    expect(bom.subtotalExGst).toBe(248.16) // 28.16 material + 33 labour + 187 floor
    expect(bom.totalIncGst).toBe(272.98)
  })

  it('omits GST when the tenant is not registered', () => {
    const bom = priceTakeoff([{ type: 'Double GPO', count: 10 }], ASSEMBLIES, { ...BOOK, gst_registered: false })
    expect(bom.gstExGst).toBe(0)
    expect(bom.totalIncGst).toBe(bom.subtotalExGst)
  })

  it('returns an all-unmatched bom (no fabricated prices) when nothing matches', () => {
    const bom = priceTakeoff([{ type: 'Antenna point', count: 4 }], ASSEMBLIES, BOOK)
    expect(bom.lines).toHaveLength(0)
    expect(bom.unmatched).toHaveLength(1)
    expect(bom.subtotalExGst).toBe(0)
    expect(bom.totalIncGst).toBe(0)
  })
})
