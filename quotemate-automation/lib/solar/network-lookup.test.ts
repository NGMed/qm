import { describe, it, expect } from 'vitest'
import { resolveNetworkFromPostcode } from './network-lookup'

describe('resolveNetworkFromPostcode', () => {
  it('resolves Sydney CBD (2000) to Ausgrid', () => {
    expect(resolveNetworkFromPostcode('2000')).toBe('Ausgrid')
  })

  it('resolves Brisbane CBD (4000) to Energex', () => {
    expect(resolveNetworkFromPostcode('4000')).toBe('Energex')
  })

  it('resolves Camden NSW (2570) to Endeavour', () => {
    expect(resolveNetworkFromPostcode('2570')).toBe('Endeavour')
  })

  it('resolves a regional NSW postcode (2650) to Essential via prefix2', () => {
    // 2650 = Wagga Wagga — prefix "26" → Essential
    expect(resolveNetworkFromPostcode('2650')).toBe('Essential')
  })

  it('resolves a regional QLD postcode (4870) to Ergon via prefix3', () => {
    // 4870 = Cairns — prefix "487" → Ergon
    expect(resolveNetworkFromPostcode('4870')).toBe('Ergon')
  })

  it('falls back to "default" for an unrecognised postcode', () => {
    expect(resolveNetworkFromPostcode('9999')).toBe('default')
  })

  it('falls back to "default" for an empty string', () => {
    expect(resolveNetworkFromPostcode('')).toBe('default')
  })

  it('trims leading/trailing spaces before lookup', () => {
    expect(resolveNetworkFromPostcode(' 2000 ')).toBe('Ausgrid')
  })

  it('returns a non-empty string for all inputs', () => {
    const postcodes = ['2000', '4000', '3000', '5000', '6000', '7000', '0800', '2570', '4350']
    for (const pc of postcodes) {
      const net = resolveNetworkFromPostcode(pc)
      expect(typeof net).toBe('string')
      expect(net.length).toBeGreaterThan(0)
    }
  })
})
