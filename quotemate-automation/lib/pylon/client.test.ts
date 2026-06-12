import { describe, it, expect, vi } from 'vitest'
import {
  pylonEnabled,
  pylonLeadPushEnabled,
  fetchPylonStcAmount,
  pushPylonOpportunity,
} from './client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('pylonEnabled', () => {
  it('requires the env gate AND a key', () => {
    expect(pylonEnabled({ PYLON_ENABLED: 'true', PYLON_API_KEY: 'k' })).toBe(true)
    expect(pylonEnabled({ PYLON_ENABLED: '1', PYLON_API_KEY: 'k' })).toBe(true)
    expect(pylonEnabled({ PYLON_ENABLED: 'true' })).toBe(false)
    expect(pylonEnabled({ PYLON_API_KEY: 'k' })).toBe(false)
    expect(pylonEnabled({ PYLON_ENABLED: 'false', PYLON_API_KEY: 'k' })).toBe(false)
    expect(pylonEnabled({})).toBe(false)
  })
})

describe('pylonLeadPushEnabled', () => {
  const base = { PYLON_ENABLED: 'true', PYLON_API_KEY: 'k' }
  it('tenant allowlist semantics', () => {
    expect(
      pylonLeadPushEnabled({ ...base, PYLON_LEAD_PUSH_TENANTS: 'a, b' }, 'b'),
    ).toBe(true)
    expect(pylonLeadPushEnabled({ ...base, PYLON_LEAD_PUSH_TENANTS: 'a' }, 'b')).toBe(false)
    expect(pylonLeadPushEnabled({ ...base, PYLON_LEAD_PUSH_TENANTS: '*' }, 'anything')).toBe(true)
    expect(pylonLeadPushEnabled({ ...base }, 'a')).toBe(false) // empty allowlist
    expect(pylonLeadPushEnabled({ ...base, PYLON_LEAD_PUSH_TENANTS: '*' }, null)).toBe(false)
  })
  it('master gate off → always false', () => {
    expect(
      pylonLeadPushEnabled({ PYLON_ENABLED: 'false', PYLON_API_KEY: 'k', PYLON_LEAD_PUSH_TENANTS: '*' }, 'a'),
    ).toBe(false)
  })
})

describe('fetchPylonStcAmount', () => {
  it('parses a flat payload', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ stcs: 68, zone: '3', zone_rating: 1.382, deeming_period: 5 }),
    )
    const res = await fetchPylonStcAmount(
      { output_kw: 10, site_postcode: '2570', installation_year: 2026 },
      { apiKey: 'k', fetchImpl },
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.stcs).toBe(68)
      expect(res.data.zone_rating).toBe(1.382)
    }
    // Request shape: bearer + query params.
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/v1/au/stc_amount?')
    expect(url).toContain('output_kw=10')
    expect(url).toContain('site_postcode=2570')
    expect(url).toContain('installation_year=2026')
    expect(url).toContain('sgu_kind=solar_deemed')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')
  })

  it('parses a JSON:API-wrapped payload', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { attributes: { stcs: '68', zone: '3' } } }),
    )
    const res = await fetchPylonStcAmount(
      { output_kw: 10, site_postcode: '2570', installation_year: 2026 },
      { apiKey: 'k', fetchImpl },
    )
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.stcs).toBe(68)
  })

  it('disabled result when no key is available', async () => {
    const res = await fetchPylonStcAmount(
      { output_kw: 10, site_postcode: '2570', installation_year: 2026 },
      { apiKey: undefined, fetchImpl: vi.fn() },
    )
    // Falls back to process.env.PYLON_API_KEY which is unset in tests.
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('disabled')
  })

  it('http_error result on a non-2xx without throwing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'nope' }, 401))
    const res = await fetchPylonStcAmount(
      { output_kw: 10, site_postcode: '2570', installation_year: 2026 },
      { apiKey: 'bad', fetchImpl },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('http_error')
      expect(res.detail).toContain('401')
    }
  })

  it('network_error result on fetch rejection without throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const res = await fetchPylonStcAmount(
      { output_kw: 10, site_postcode: '2570', installation_year: 2026 },
      { apiKey: 'k', fetchImpl },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('network_error')
  })

  it('invalid_response when stcs is missing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ zone: '3' }))
    const res = await fetchPylonStcAmount(
      { output_kw: 10, site_postcode: '2570', installation_year: 2026 },
      { apiKey: 'k', fetchImpl },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('invalid_response')
  })
})

describe('pushPylonOpportunity', () => {
  it('POSTs the lead as JSON with the bearer header', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }))
    const res = await pushPylonOpportunity(
      {
        name: 'Jane Customer',
        phone: '+61400000000',
        address: '12 Test St',
        summary: '10 kW solar',
      },
      { apiKey: 'k', fetchImpl },
    )
    expect(res.ok).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/v1/opportunities_form')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body.name).toBe('Jane Customer')
    expect(body.notes).toBe('10 kW solar')
  })

  it('never throws on failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom')
    })
    const res = await pushPylonOpportunity({ name: 'X' }, { apiKey: 'k', fetchImpl })
    expect(res.ok).toBe(false)
  })
})
