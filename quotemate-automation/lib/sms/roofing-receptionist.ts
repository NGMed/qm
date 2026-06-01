// ════════════════════════════════════════════════════════════════════
// SMS roofing receptionist — pure per-turn decision.
//
// Given the conversation's persisted roofing state (gathered slots + the
// step we last asked about) and the customer's new inbound message,
// decide what happens this turn:
//   • ask        — fold the answer in, send the next question.
//   • price      — enough gathered + quotable → run measureAndPriceRoofs.
//   • inspection — enough gathered but material/pitch forces an on-site
//                  inspection → send the inspection next-step.
//
// The route executes the I/O (measure, persist, MMS); this module is pure
// so the conversation logic is fully unit-tested.
// ════════════════════════════════════════════════════════════════════

import {
  applyRoofingAnswer,
  mapIntent,
  nextRoofingStep,
  parseYearBuilt,
  type RoofingSlots,
  type RoofingStep,
} from './roofing-intake'

/** Persisted on sms_conversations.roofing_state (jsonb). */
export type RoofingConversationState = {
  slots: RoofingSlots
  /** The step we asked the customer about last turn (null on the opener). */
  last_step?: RoofingStep | null
}

const ANSWERABLE_STEPS: ReadonlySet<RoofingStep> = new Set<RoofingStep>([
  'address',
  'confirm_address',
  'intent',
  'material',
  'pitch',
])

export type RoofingTurnDecision =
  | { action: 'ask'; slots: RoofingSlots; step: RoofingStep; reply: string }
  | { action: 'price'; slots: RoofingSlots }
  | { action: 'inspection'; slots: RoofingSlots; reason: string }

/**
 * PURE — advance the roofing conversation one turn.
 *
 * Folds the customer's message into the slot we last asked about (or, on
 * the opener where there's no prior step, opportunistically reads the
 * intent + any build year from the first message), then asks for the next
 * missing input or signals ready-to-price / inspection.
 */
export function advanceRoofing(
  prev: RoofingConversationState | null | undefined,
  inbound: string,
): RoofingTurnDecision {
  let slots: RoofingSlots = { ...(prev?.slots ?? {}) }
  const lastStep = prev?.last_step ?? null

  if (lastStep && ANSWERABLE_STEPS.has(lastStep)) {
    slots = applyRoofingAnswer(slots, lastStep, inbound)
  } else {
    // Opener (or a non-answerable prior step): glean what we can from the
    // first message so an obvious "I need a re-roof" doesn't get re-asked.
    if (!slots.intent) {
      const intent = mapIntent(inbound)
      if (intent) slots.intent = intent
    }
    if (slots.year_built == null) {
      const y = parseYearBuilt(inbound)
      if (y != null) slots.year_built = y
    }
  }

  const next = nextRoofingStep(slots)
  if (next.step === 'ready') {
    return { action: 'price', slots }
  }
  if (next.step === 'inspection') {
    return { action: 'inspection', slots, reason: next.reason ?? 'on-site inspection required' }
  }
  return { action: 'ask', slots, step: next.step, reply: next.question ?? '' }
}

/** PURE — the roofing_state to persist after a turn (for ask outcomes the
 *  last_step is the step we just asked; price/inspection are terminal so
 *  last_step is cleared). */
export function nextRoofingConversationState(
  decision: RoofingTurnDecision,
): RoofingConversationState {
  return {
    slots: decision.slots,
    last_step: decision.action === 'ask' ? decision.step : null,
  }
}
