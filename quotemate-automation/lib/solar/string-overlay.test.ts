import { describe, it, expect } from 'vitest'
import {
  buildStringOverlay,
  chunkIntoStrings,
  stringColor,
  STRING_OVERLAY_CAPTION,
  DEFAULT_STRING_MAX_PANELS,
} from './string-overlay'
import type { SolarPanelPlacement, SolarRoofPlane } from './types'

const SYD = { lat: -33.8688, lng: 151.2093 }

function makePanels(n: number, segment = 0, latRow = 0): SolarPanelPlacement[] {
  return Array.from({ length: n }, (_, i) => ({
    center: { lat: SYD.lat + latRow * 0.00003, lng: SYD.lng + i * 0.00002 },
    orientation: 'PORTRAIT' as const,
    segment_index: segment,
    yearly_energy_dc_kwh: 550,
  }))
}

const PLANES: SolarRoofPlane[] = [
  { pitch_degrees: 22, azimuth_degrees: 0, area_m2: 60, orientation: 'north' },
  { pitch_degrees: 18, azimuth_degrees: 90, area_m2: 40, orientation: 'east' },
]

describe('chunkIntoStrings', () => {
  it('splits into runs of at most maxLen', () => {
    expect(chunkIntoStrings([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
  it('one run when under the cap', () => {
    expect(chunkIntoStrings([1, 2, 3], 14)).toEqual([[1, 2, 3]])
  })
  it('guards degenerate maxLen to 1', () => {
    expect(chunkIntoStrings([1, 2], 0)).toEqual([[1], [2]])
    expect(chunkIntoStrings([1, 2], Number.NaN)).toEqual([[1], [2]])
  })
  it('empty input → no runs', () => {
    expect(chunkIntoStrings([], 5)).toEqual([])
  })
})

describe('buildStringOverlay', () => {
  it('one string per plane when each plane is under the cap', () => {
    const panels = [...makePanels(6, 0), ...makePanels(5, 1)]
    const out = buildStringOverlay({ panels, planes: PLANES, center: SYD })!
    expect(out.strings).toHaveLength(2)
    expect(out.strings[0]).toMatchObject({ string_number: 1, segment_index: 0, panels_count: 6 })
    expect(out.strings[1]).toMatchObject({ string_number: 2, segment_index: 1, panels_count: 5 })
  })

  it('splits a plane exceeding string_max_panels into multiple runs', () => {
    const out = buildStringOverlay({
      panels: makePanels(20, 0),
      planes: PLANES,
      center: SYD,
      string_max_panels: 14,
    })!
    expect(out.strings.map((s) => s.panels_count)).toEqual([14, 6])
    expect(out.strings.map((s) => s.string_number)).toEqual([1, 2])
  })

  it(`defaults the cap to ${DEFAULT_STRING_MAX_PANELS}`, () => {
    const out = buildStringOverlay({
      panels: makePanels(15, 0),
      planes: PLANES,
      center: SYD,
    })!
    expect(out.strings.map((s) => s.panels_count)).toEqual([14, 1])
  })

  it('strings never span planes', () => {
    const panels = [...makePanels(3, 0), ...makePanels(3, 1)]
    const out = buildStringOverlay({
      panels,
      planes: PLANES,
      center: SYD,
      string_max_panels: 14,
    })!
    // 6 panels would fit one 14-run, but the plane boundary forces two.
    expect(out.strings).toHaveLength(2)
  })

  it('respects panel_limit (headline tier slice)', () => {
    const out = buildStringOverlay({
      panels: makePanels(10, 0),
      planes: PLANES,
      center: SYD,
      panel_limit: 4,
    })!
    expect(out.strings[0].panels_count).toBe(4)
  })

  it('carries the mandatory indicative caption verbatim', () => {
    const out = buildStringOverlay({
      panels: makePanels(3, 0),
      planes: PLANES,
      center: SYD,
    })!
    expect(out.caption).toBe(STRING_OVERLAY_CAPTION)
    expect(STRING_OVERLAY_CAPTION).toBe(
      'Indicative string layout — final stringing is confirmed by your installer at site.',
    )
  })

  it('draws numbered terminals + an inverter marker', () => {
    const out = buildStringOverlay({
      panels: [...makePanels(6, 0), ...makePanels(5, 1)],
      planes: PLANES,
      center: SYD,
    })!
    expect(out.svg).toContain('>S1</text>')
    expect(out.svg).toContain('>S2</text>')
    expect(out.svg).toContain('>INV</text>')
    expect(out.svg.match(/<polyline /g)?.length).toBe(2)
  })

  it('assigns distinct colours per string', () => {
    const out = buildStringOverlay({
      panels: makePanels(20, 0),
      planes: PLANES,
      center: SYD,
    })!
    expect(out.strings[0].color).not.toBe(out.strings[1].color)
    expect(out.strings[0].color).toBe(stringColor(0))
  })

  it('degrades to null on empty geometry or a bad centre', () => {
    expect(buildStringOverlay({ panels: [], planes: PLANES, center: SYD })).toBeNull()
    expect(
      buildStringOverlay({
        panels: makePanels(3),
        planes: PLANES,
        center: { lat: Number.NaN, lng: 151 },
      }),
    ).toBeNull()
  })

  it('is deterministic — identical input, identical SVG', () => {
    const args = { panels: makePanels(7, 0), planes: PLANES, center: SYD }
    expect(buildStringOverlay(args)!.svg).toBe(buildStringOverlay(args)!.svg)
  })
})
