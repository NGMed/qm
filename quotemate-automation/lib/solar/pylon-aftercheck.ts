// Shared after()-body for the Pylon STC cross-check (premium quote
// §4.5), used by the estimate route AND the re-draft route. Runs the
// cross-check, merges any mismatch flags into the persisted row
// (guardrail_flags column + the estimate jsonb) and stamps
// context.pylon_stc_check. Error-checked + logged; never throws —
// Pylon being down leaves the row bit-identical.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { SolarEstimate } from './types'
import { runPylonStcCrossCheck } from './stc-crosscheck'

export async function applyPylonStcCrossCheck(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  estimate: SolarEstimate,
): Promise<void> {
  try {
    const result = await runPylonStcCrossCheck({ estimate })
    if (!result) return
    const mergedFlags = [...estimate.guardrail_flags, ...result.flags]
    const updatedEstimate: SolarEstimate = {
      ...estimate,
      guardrail_flags: mergedFlags,
      context: { ...estimate.context, pylon_stc_check: result.check },
    }
    const { error } = await supabase
      .from('solar_estimates')
      .update({ guardrail_flags: mergedFlags, estimate: updatedEstimate })
      .eq('public_token', estimate.token)
    if (error) {
      console.error('[solar/pylon] cross-check row update FAILED', {
        token: estimate.token.slice(0, 8) + '…',
        message: error.message,
      })
      return
    }
    if (result.flags.length > 0) {
      console.warn('[solar/pylon] STC mismatch flagged', result.flags)
    } else {
      console.log('[solar/pylon] STC counts verified against Pylon', {
        token: estimate.token.slice(0, 8) + '…',
      })
    }
  } catch (e) {
    console.warn(
      '[solar/pylon] cross-check skipped (non-fatal)',
      e instanceof Error ? e.message : e,
    )
  }
}
