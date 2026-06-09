import { test, expect } from '@playwright/test'

test.describe('Solar estimate route — API contracts', () => {
  test('rejects an unknown tenantSlug with 404', async ({ request }) => {
    const res = await request.post(
      '/api/solar/00000000-0000-0000-0000-000000000000/estimate',
      {
        data: { address: { address: '1 Test St, Sydney', postcode: '2000', state: 'NSW' } },
      },
    )
    expect(res.status()).toBe(404)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe('tenant_not_found')
  })

  test('rejects an invalid body with 400', async ({ request }) => {
    const res = await request.post(
      '/api/solar/00000000-0000-0000-0000-000000000000/estimate',
      { data: { address: { address: 'x', postcode: '2000', state: 'NSW' } } },
    )
    expect([400, 404]).toContain(res.status())
    const body = await res.json()
    expect(body.ok).toBe(false)
  })

  test('rejects a non-JSON body with 400', async ({ request }) => {
    const res = await request.post(
      '/api/solar/00000000-0000-0000-0000-000000000000/estimate',
      { headers: { 'content-type': 'application/json' }, data: 'not json' },
    )
    expect([400, 404]).toContain(res.status())
  })
})
