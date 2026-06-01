// Unit tests for the structurer's pure requested_specs parser.
//
// The structureIntake() call itself hits Anthropic (integration-level), so
// these tests pin the deterministic post-processing: the requested_specs_json
// blob the model emits must degrade to {} on anything malformed and never
// throw (degrade-never-block).

import { describe, expect, it } from 'vitest'
import { parseRequestedSpecs } from './structure'

describe('parseRequestedSpecs', () => {
  it('parses a well-formed JSON object string', () => {
    expect(parseRequestedSpecs('{"amperage":"15A"}')).toEqual({ amperage: '15A' })
    expect(parseRequestedSpecs('{"energy_source":"gas","litres":"250"}')).toEqual({
      energy_source: 'gas',
      litres: '250',
    })
  })

  it('returns {} for empty / "{}" / whitespace', () => {
    expect(parseRequestedSpecs('{}')).toEqual({})
    expect(parseRequestedSpecs('')).toEqual({})
    expect(parseRequestedSpecs('   ')).toEqual({})
  })

  it('returns {} for malformed JSON (never throws)', () => {
    expect(parseRequestedSpecs('{not json')).toEqual({})
    expect(parseRequestedSpecs('15A')).toEqual({})
  })

  it('returns {} for null / undefined / non-object JSON', () => {
    expect(parseRequestedSpecs(null)).toEqual({})
    expect(parseRequestedSpecs(undefined)).toEqual({})
    expect(parseRequestedSpecs('"a string"')).toEqual({})
    expect(parseRequestedSpecs('[1,2,3]')).toEqual({})
    expect(parseRequestedSpecs('42')).toEqual({})
  })

  it('coerces numeric / boolean values to strings', () => {
    expect(parseRequestedSpecs('{"litres":250,"smart":true}')).toEqual({
      litres: '250',
      smart: 'true',
    })
  })

  it('skips nested objects, arrays and null values, trims strings', () => {
    expect(
      parseRequestedSpecs('{"amperage":" 15A ","x":{"a":1},"y":[1],"z":null,"blank":"  "}'),
    ).toEqual({ amperage: '15A' })
  })

  it('accepts an already-parsed object (defensive)', () => {
    expect(parseRequestedSpecs({ ip_rating: 'IP56' })).toEqual({ ip_rating: 'IP56' })
  })
})
