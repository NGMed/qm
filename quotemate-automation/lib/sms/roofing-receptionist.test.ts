// SMS roofing receptionist — per-turn decision tests. Drives a whole
// conversation through advanceRoofing the way the inbound route will.

import { describe, expect, it } from 'vitest'
import {
  advanceRoofing,
  nextRoofingConversationState,
  type RoofingConversationState,
} from './roofing-receptionist'

/** Simulate the route loop: feed messages, threading persisted state. */
function runConversation(messages: string[]) {
  let state: RoofingConversationState | null = null
  const decisions = []
  for (const m of messages) {
    const decision = advanceRoofing(state, m)
    decisions.push(decision)
    state = nextRoofingConversationState(decision)
    if (decision.action !== 'ask') break
  }
  return { decisions, state }
}

describe('advanceRoofing — full happy path to price', () => {
  it('gathers all inputs across turns then signals price', () => {
    const { decisions } = runConversation([
      'Hi, I need a re-roof quote', // opener — intent gleaned, asks address
      '670 London Rd, Chandler QLD 4155', // address
      'yes', // confirm
      'full re-roof', // intent (already set, harmless re-confirm)
      'colorbond', // material
      'standard', // pitch
    ])
    const steps = decisions.map((d) => (d.action === 'ask' ? d.step : d.action))
    // opener asks address (intent was gleaned), then confirm, then since
    // intent is already set it skips to material, then pitch, then price.
    expect(steps[0]).toBe('address')
    expect(steps).toContain('confirm_address')
    expect(steps).toContain('material')
    expect(steps).toContain('pitch')
    expect(steps[steps.length - 1]).toBe('price')
  })

  it('the opener gleans intent so it is not asked again', () => {
    const d = advanceRoofing(null, 'my roof is leaking badly')
    expect(d.slots.intent).toBe('leak_trace')
    // first question is the address, not intent
    expect(d.action).toBe('ask')
    if (d.action === 'ask') expect(d.step).toBe('address')
  })
})

describe('advanceRoofing — inspection fallback', () => {
  it('routes to inspection when the customer says fibro/asbestos', () => {
    const { decisions } = runConversation([
      'need a roof repair quote',
      '12 Smith St, Bondi NSW 2026',
      'yes',
      'repair a few spots', // intent patch_repair
      'fibro', // material → cement_sheet → inspection
    ])
    const last = decisions[decisions.length - 1]
    expect(last.action).toBe('inspection')
    if (last.action === 'inspection') expect(last.reason).toMatch(/asbestos/i)
  })

  it('routes to inspection when pitch is unknown', () => {
    const { decisions } = runConversation([
      're-roof please',
      '1 A St, Perth WA 6000',
      'yes',
      'whole roof',
      'colorbond',
      'not sure how steep', // pitch unknown → inspection
    ])
    expect(decisions[decisions.length - 1].action).toBe('inspection')
  })
})

describe('advanceRoofing — re-ask on unrecognised answer', () => {
  it('does not advance past material on gibberish', () => {
    let state: RoofingConversationState | null = {
      slots: { address: '1 A St', address_confirmed: true, intent: 'full_reroof' },
      last_step: 'material',
    }
    const d = advanceRoofing(state, 'it is sort of blueish')
    expect(d.action).toBe('ask')
    if (d.action === 'ask') expect(d.step).toBe('material')
    state = nextRoofingConversationState(d)
    expect(state.last_step).toBe('material')
  })
})

describe('nextRoofingConversationState', () => {
  it('keeps last_step for ask, clears it for terminal outcomes', () => {
    const ask = advanceRoofing(null, 'hello')
    expect(nextRoofingConversationState(ask).last_step).toBe('address')
    const priceState = nextRoofingConversationState({ action: 'price', slots: {} })
    expect(priceState.last_step).toBeNull()
  })
})
