// Migration 032 — the mandated-questions render. Proves a service with
// clarifying_questions gets a MUST-ASK block + the "no finish until
// answered" mandate, while a service without one keeps the exact legacy
// behaviour (universal name+suburb+scope only). The bound + scoping
// guards stop a huge custom catalogue blowing the prompt budget and stop
// inspection-only rows accidentally inheriting the quote questions.

import { describe, expect, it } from 'vitest'
import { customServicesDirective, type CustomServiceScope } from './dialog'

const withQs: CustomServiceScope = {
  name: 'Install rainwater tank',
  description: 'Connect tank to downpipe + overflow',
  always_inspection: false,
  clarifying_questions: [
    'What size is the tank, and is it on a prepared base?',
    'Downpipe + overflow only, or also a pump / house connection?',
    'One tank, or more than one?',
  ],
}
const noQs: CustomServiceScope = {
  name: 'Install widget',
  description: 'Some service',
  always_inspection: false,
  clarifying_questions: null,
}

describe('customServicesDirective — mandated clarifying questions (mig 032)', () => {
  it('renders the questions + the no-finish-until-answered mandate', () => {
    const out = customServicesDirective([withQs])
    expect(out).toContain('Install rainwater tank')
    expect(out).toContain('MUST ASK before any finish (one per turn, in order):')
    expect(out).toContain('1. What size is the tank, and is it on a prepared base?')
    expect(out).toContain('3. One tank, or more than one?')
    // The mandate itself — must block finish/draft until answered.
    expect(out).toMatch(/REQUIRED\s+per-job fields/i)
    expect(out).toMatch(/BEFORE action='finish'/)
    expect(out).toMatch(/Do NOT finish,\s+draft/i) // wraps across lines
    // Still must NOT route these to inspection.
    expect(out).toMatch(/do NOT escalate to inspection/i)
  })

  it('a service WITHOUT questions keeps the exact legacy behaviour', () => {
    const out = customServicesDirective([noQs])
    expect(out).toContain('Install widget')
    expect(out).not.toContain('MUST ASK before any finish')
  })

  it('mixed list: only the scripted service gets a MUST-ASK block', () => {
    const out = customServicesDirective([noQs, withQs])
    expect(out).toContain('Install widget')
    expect(out).toContain('Install rainwater tank')
    expect((out.match(/MUST ASK before any finish/g) ?? []).length).toBe(1)
  })

  it('bounds the questions per service (prompt-budget guard)', () => {
    const many: CustomServiceScope = {
      name: 'Big service',
      description: null,
      always_inspection: false,
      clarifying_questions: Array.from({ length: 12 }, (_, i) => `Q${i + 1}?`),
    }
    const out = customServicesDirective([many])
    expect(out).toContain('6. Q6?')
    expect(out).not.toContain('7. Q7?')
  })

  it('inspection-only rows do NOT inherit the quote questions', () => {
    const inspOnly: CustomServiceScope = {
      ...withQs,
      name: 'Switchboard upgrade',
      always_inspection: true,
    }
    const out = customServicesDirective([inspOnly])
    expect(out).toContain('Switchboard upgrade')
    expect(out).toContain('INSPECTION-ONLY')
    // Questions are a quote-path concern; an inspection-only row routes
    // to $199 and must not render a MUST-ASK block.
    expect(out).not.toContain('MUST ASK before any finish')
  })

  it('empty / undefined input → empty string (unchanged)', () => {
    expect(customServicesDirective(undefined)).toBe('')
    expect(customServicesDirective([])).toBe('')
  })
})
