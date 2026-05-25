// IG Engine — OpenAI provider adapter tests.
//
// The renderImage path dynamically imports the AI SDK, so we only test
// the parts that don't need the SDK live: the pure prompt builder and
// the early-throw safety gates (missing key, source-image, reference).
// The actual call to experimental_generateImage is exercised end-to-end
// in the live verify loop, not here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildOpenAIPrompt, openaiProvider } from './openai'

describe('buildOpenAIPrompt', () => {
  it('combines system and user with a separator, system first', () => {
    const p = buildOpenAIPrompt({ system: 'SYS', user: 'USER' })
    expect(p).toContain('SYS')
    expect(p).toContain('USER')
    expect(p.indexOf('SYS')).toBeLessThan(p.indexOf('USER'))
  })

  it('appends extraStrict after the user message', () => {
    const p = buildOpenAIPrompt({ system: 'SYS', user: 'USER', extraStrict: 'FIX COUNT' })
    expect(p).toContain('FIX COUNT')
    expect(p.indexOf('USER')).toBeLessThan(p.indexOf('FIX COUNT'))
  })

  it('omits the extraStrict block when not provided', () => {
    const p = buildOpenAIPrompt({ system: 'SYS', user: 'USER' })
    // exactly one separator between SYS and USER, no trailing block
    expect(p.split('---').length).toBe(2)
  })
})

describe('openaiProvider.renderImage — early-throw safety', () => {
  const prev = process.env.AI_GATEWAY_API_KEY

  beforeEach(() => {
    process.env.AI_GATEWAY_API_KEY = 'test-gateway-key'
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.AI_GATEWAY_API_KEY
    else process.env.AI_GATEWAY_API_KEY = prev
  })

  it('throws when AI_GATEWAY_API_KEY is missing', async () => {
    delete process.env.AI_GATEWAY_API_KEY
    await expect(
      openaiProvider.renderImage({ system: 'SYS', user: 'USER' }),
    ).rejects.toThrow(/AI_GATEWAY_API_KEY/)
  })

  it('throws on edit-with-source (router must fall back to Gemini)', async () => {
    await expect(
      openaiProvider.renderImage({
        system: 'SYS',
        user: 'USER',
        sourceImage: { base64: 'X', mime: 'image/jpeg' },
      }),
    ).rejects.toThrow(/edit-with-reference|route this job to Gemini/i)
  })

  it('throws on reference image (router must fall back to Gemini)', async () => {
    await expect(
      openaiProvider.renderImage({
        system: 'SYS',
        user: 'USER',
        reference: {
          image: { base64: 'X', mime: 'image/png' },
          label: 'PRODUCT REFERENCE',
        },
      }),
    ).rejects.toThrow(/image-input|route to Gemini/i)
  })
})

describe('openaiProvider.capabilities', () => {
  it('honestly reports text-to-image only (no edit, no vision)', () => {
    expect(openaiProvider.name).toBe('openai')
    expect(openaiProvider.capabilities).toEqual({
      edit: false,
      textToImage: true,
      vision: false,
    })
  })
})
