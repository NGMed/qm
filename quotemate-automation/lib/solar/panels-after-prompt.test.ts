import { describe, it, expect } from 'vitest'
import { buildSolarPanelsAfterPrompt } from './panels-after-prompt'

describe('buildSolarPanelsAfterPrompt', () => {
  const prompt = buildSolarPanelsAfterPrompt({
    panelsCount: 15,
    systemKwDc: 6.0,
    orientation: 'south',
  })

  it('returns a system + user brief', () => {
    expect(prompt.system.length).toBeGreaterThan(40)
    expect(prompt.user.length).toBeGreaterThan(100)
  })

  it('grounds the render on the exact quoted panel count and size', () => {
    expect(prompt.user).toContain('15 dark monocrystalline solar panels')
    expect(prompt.user).toContain('6.0 kW')
  })

  it('places panels on the primary-orientation plane', () => {
    expect(prompt.user).toContain('south-facing roof plane(s)')
  })

  it('flat and unknown orientations fall back to the largest roof area', () => {
    for (const orientation of ['flat', 'unknown'] as const) {
      const p = buildSolarPanelsAfterPrompt({ panelsCount: 10, systemKwDc: 4, orientation })
      expect(p.user).toContain('largest unobstructed roof area')
      expect(p.user).not.toContain('-facing roof plane')
    }
  })

  it('keeps the strict do-not-change rules and bans text/watermarks', () => {
    expect(prompt.user).toContain('STRICT RULES')
    expect(prompt.user).toContain('Do NOT re-roof')
    expect(prompt.user).toMatch(/do NOT add text, labels, watermarks or people/i)
    expect(prompt.system).toContain('ONE change only')
  })

  it('sanitises a fractional or zero panel count', () => {
    const fractional = buildSolarPanelsAfterPrompt({
      panelsCount: 12.6,
      systemKwDc: 5,
      orientation: 'north',
    })
    expect(fractional.user).toContain('13 dark monocrystalline')
    const zero = buildSolarPanelsAfterPrompt({ panelsCount: 0, systemKwDc: 0.4, orientation: 'north' })
    expect(zero.user).toContain('1 dark monocrystalline')
  })
})
