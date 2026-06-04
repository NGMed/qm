import { describe, it, expect } from 'vitest'
import { parseStudiosCsv } from './studios-csv'

describe('parseStudiosCsv', () => {
  it('parses a basic roster with the standard columns', () => {
    const csv = [
      'name,address,region,state,postcode,contact_phone,contact_email',
      'F45 Bondi,1 Hall St Bondi,AU-NSW,NSW,2026,+61400000001,bondi@f45.com',
      'F45 Surry Hills,5 Crown St,AU-NSW,NSW,2010,,surry@f45.com',
    ].join('\n')
    const { studios, errors } = parseStudiosCsv(csv)
    expect(errors).toEqual([])
    expect(studios).toHaveLength(2)
    expect(studios[0]).toMatchObject({ name: 'F45 Bondi', address: '1 Hall St Bondi', state: 'NSW', postcode: '2026' })
    expect(studios[1].contact_phone).toBeNull()
  })

  it('honours quoted fields with commas and escaped quotes', () => {
    const csv = 'name,address\n"F45, City","12 Main St, Unit ""3"", Sydney"'
    const { studios } = parseStudiosCsv(csv)
    expect(studios[0].name).toBe('F45, City')
    expect(studios[0].address).toBe('12 Main St, Unit "3", Sydney')
  })

  it('maps header aliases (studio/location, zip, phone, email)', () => {
    const csv = 'studio,full_address,zip,phone,email\nF45 Austin,100 Congress Ave,78701,512-555-0100,hi@f45.com'
    const { studios } = parseStudiosCsv(csv)
    expect(studios[0]).toMatchObject({ name: 'F45 Austin', postcode: '78701', contact_phone: '512-555-0100', contact_email: 'hi@f45.com' })
  })

  it('errors when there is no name column', () => {
    const { studios, errors } = parseStudiosCsv('address,region\n1 Hall St,NSW')
    expect(studios).toHaveLength(0)
    expect(errors[0]).toContain('name')
  })

  it('skips rows missing a name and de-dupes by name', () => {
    const csv = 'name,address\nF45 Bondi,1 Hall St\n,2 Lost St\nF45 Bondi,dupe'
    const { studios, errors } = parseStudiosCsv(csv)
    expect(studios).toHaveLength(1)
    expect(errors.some((e) => e.includes('missing name'))).toBe(true)
    expect(errors.some((e) => e.includes('duplicate'))).toBe(true)
  })

  it('returns an error for an empty file', () => {
    expect(parseStudiosCsv('').errors[0]).toContain('empty')
  })
})
