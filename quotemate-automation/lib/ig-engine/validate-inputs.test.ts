// Stage 0 input validator — one assertion per rule. The validator's
// whole job is to refuse renders for bad inputs and to NEVER block on
// its own infrastructure failures (probe errors must be soft-skipped).

import { describe, expect, it } from 'vitest'
import type { PromptContext } from './prompts'
import {
  looksIndoorOnly,
  partitionResult,
  staticReasons,
  summariseReasons,
  validateImageInputs,
  type ValidationReason,
} from './validate-inputs'

function ctx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    intake: {
      job_type: 'downlights',
      scope: {
        item_count: 6,
        is_new_install: false,
        description: 'replace the old downlights in the lounge room',
      },
      caller: { name: 'Sarah' },
    },
    quote: { selected_tier: 'better', needs_inspection: false },
    lineItems: [
      {
        tier: 'better',
        description: '6 × Dimmable LED downlight (Brilliant)',
        quantity: 6,
        source: 'material',
        image_path: 'catalogue/downlight-brilliant.jpg',
      },
    ],
    corrections: [],
    ...overrides,
  }
}

describe('staticReasons — structural rules', () => {
  it('passes a fully-specified replacement render with one photo', () => {
    const r = staticReasons(ctx(), { photoPaths: ['intake/sarah/before.jpg'] })
    expect(r).toEqual([])
  })

  it('blocks when job_type is missing', () => {
    const r = staticReasons(
      ctx({ intake: { ...ctx().intake, job_type: '' } }),
      { photoPaths: ['intake/sarah/before.jpg'] },
    )
    expect(r.map((x) => x.code)).toContain('no_job_type')
  })

  it('blocks when there is no effective count and no per-job default', () => {
    const r = staticReasons(
      ctx({
        intake: {
          ...ctx().intake,
          // bathroom_renovation is variable-count and has no default
          job_type: 'bathroom_renovation',
          scope: { ...ctx().intake.scope, item_count: null },
        },
      }),
      { photoPaths: ['intake/sarah/before.jpg'] },
    )
    expect(r.map((x) => x.code)).toContain('no_effective_count')
  })

  it('accepts a missing count when the per-job default fills it in', () => {
    const r = staticReasons(
      ctx({
        intake: {
          ...ctx().intake,
          job_type: 'hot_water', // has SINGLE_ITEM_DEFAULT_COUNT = 1
          scope: { ...ctx().intake.scope, item_count: null },
        },
      }),
      { photoPaths: ['intake/sarah/before.jpg'] },
    )
    expect(r.map((x) => x.code)).not.toContain('no_effective_count')
  })

  it('blocks when there is no anchor product on the selected tier', () => {
    const r = staticReasons(
      ctx({ lineItems: [] }),
      { photoPaths: ['intake/sarah/before.jpg'] },
    )
    expect(r.map((x) => x.code)).toContain('no_anchor_product')
  })

  it('blocks a replacement render with no customer photo', () => {
    const r = staticReasons(ctx(), { photoPaths: [] })
    expect(r.map((x) => x.code)).toContain('replacement_without_source_photo')
  })

  it('does not block a new-install render with no customer photo', () => {
    const r = staticReasons(
      ctx({
        intake: {
          ...ctx().intake,
          scope: { ...ctx().intake.scope, is_new_install: true },
        },
      }),
      { photoPaths: [] },
    )
    expect(r.map((x) => x.code)).not.toContain('replacement_without_source_photo')
  })

  it('flags weatherproof+indoor as a soft warning, not a hard block', () => {
    const r = staticReasons(
      ctx({
        intake: {
          ...ctx().intake,
          scope: {
            ...ctx().intake.scope,
            specs: { weatherproof: true },
          },
        },
        lineItems: [
          {
            tier: 'better',
            description: 'Indoor LED ceiling rose',
            quantity: 1,
            source: 'material',
          },
        ],
      }),
      { photoPaths: ['intake/sarah/before.jpg'] },
    )
    const hit = r.find((x) => x.code === 'weatherproof_indoor_contradiction')
    expect(hit).toBeTruthy()
    expect(hit?.fatal).toBe(false)
  })
})

describe('looksIndoorOnly', () => {
  it('matches obvious indoor descriptions', () => {
    expect(looksIndoorOnly('Indoor LED batten')).toBe(true)
    expect(looksIndoorOnly('Pendant lounge fixture')).toBe(true)
    expect(looksIndoorOnly('In-ceiling speaker')).toBe(true)
  })
  it('does NOT match generic descriptions', () => {
    expect(looksIndoorOnly('Dimmable LED downlight (Brilliant)')).toBe(false)
    expect(looksIndoorOnly('Outdoor IP-rated GPO')).toBe(false)
    expect(looksIndoorOnly(null)).toBe(false)
  })
})

describe('validateImageInputs — async + probes', () => {
  it('ok=true with no warnings on a happy path', async () => {
    const r = await validateImageInputs(ctx(), {
      photoPaths: ['intake/sarah/before.jpg'],
      probeProductImage: async () => true,
      probeFirstCustomerPhoto: async () => true,
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.warnings).toEqual([])
  })

  it('fails when the catalogue product photo URL is broken', async () => {
    const r = await validateImageInputs(ctx(), {
      photoPaths: ['intake/sarah/before.jpg'],
      probeProductImage: async () => false,
      probeFirstCustomerPhoto: async () => true,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reasons.map((x) => x.code)).toContain('anchor_photo_unreachable')
  })

  it('fails when customer-photo listed but first one cannot be downloaded', async () => {
    const r = await validateImageInputs(ctx(), {
      photoPaths: ['intake/sarah/before.jpg'],
      probeProductImage: async () => true,
      probeFirstCustomerPhoto: async () => false,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reasons.map((x) => x.code)).toContain(
        'photo_paths_present_but_first_unreadable',
      )
    }
  })

  it('NEVER blocks the render when a probe throws (probe failure ≠ bad input)', async () => {
    const r = await validateImageInputs(ctx(), {
      photoPaths: ['intake/sarah/before.jpg'],
      probeProductImage: async () => {
        throw new Error('storage timeout')
      },
      probeFirstCustomerPhoto: async () => {
        throw new Error('network reset')
      },
    })
    expect(r.ok).toBe(true)
  })

  it('skips probe-backed rules when no probe is injected', async () => {
    const r = await validateImageInputs(ctx(), {
      photoPaths: ['intake/sarah/before.jpg'],
    })
    expect(r.ok).toBe(true)
  })

  it('passes a soft warning through to ok=true with the warning attached', async () => {
    const r = await validateImageInputs(
      ctx({
        intake: {
          ...ctx().intake,
          scope: {
            ...ctx().intake.scope,
            specs: { weatherproof: true },
          },
        },
        lineItems: [
          {
            tier: 'better',
            description: 'Indoor LED ceiling rose',
            quantity: 1,
            source: 'material',
          },
        ],
      }),
      { photoPaths: ['intake/sarah/before.jpg'] },
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.warnings.map((x) => x.code)).toContain(
        'weatherproof_indoor_contradiction',
      )
    }
  })
})

describe('partitionResult', () => {
  it('returns ok=true when only soft warnings are present', () => {
    const reasons: ValidationReason[] = [
      { code: 'weatherproof_indoor_contradiction', detail: 'x', fatal: false },
    ]
    const r = partitionResult(reasons)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.warnings).toHaveLength(1)
  })

  it('returns ok=false the moment any fatal reason is present', () => {
    const reasons: ValidationReason[] = [
      { code: 'weatherproof_indoor_contradiction', detail: 'soft', fatal: false },
      { code: 'no_anchor_product', detail: 'hard' },
    ]
    const r = partitionResult(reasons)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reasons.map((x) => x.code)).toEqual(['no_anchor_product'])
    }
  })
})

describe('summariseReasons', () => {
  it('joins codes + details into a single line capped at 500 chars', () => {
    const reasons: ValidationReason[] = [
      { code: 'no_job_type', detail: 'missing' },
      { code: 'no_anchor_product', detail: 'no material line' },
    ]
    const s = summariseReasons(reasons)
    expect(s).toContain('[no_job_type]')
    expect(s).toContain('[no_anchor_product]')
    expect(s.length).toBeLessThanOrEqual(500)
  })
})
