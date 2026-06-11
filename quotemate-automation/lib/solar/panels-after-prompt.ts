// ════════════════════════════════════════════════════════════════════
// Solar — AI "panels installed" concept PROMPT (pure, no I/O).
//
// Split out from panels-after.ts so it can be unit-tested without
// pulling in the Supabase / Gemini clients that module instantiates at
// import time (same split as roofing's roof-after-prompt.ts).
//
// The brief is grounded HARD on the quoted system: exactly the tier's
// panel count, placed on the roof plane(s) facing the estimate's primary
// orientation, everything else pixel-faithful to the real aerial. The
// output is a clearly-labelled CONCEPT — never a design document.
// ════════════════════════════════════════════════════════════════════

import type { SolarOrientation } from './types'
import { orientationLabel } from './hero-overlay'

export type SolarPanelsAfterBrief = {
  /** Panels to render — the headline tier's exact count. */
  panelsCount: number
  /** DC system size, for the brief's context line. */
  systemKwDc: number
  /** Primary array orientation from the roof facts. */
  orientation: SolarOrientation
}

/**
 * PURE — the system+user brief for the "panels installed" render.
 * Grounded on "add ONLY solar panels" so Gemini doesn't reinvent the
 * building or its surroundings (it's an aerial of a REAL property).
 */
export function buildSolarPanelsAfterPrompt(
  brief: SolarPanelsAfterBrief,
): { system: string; user: string } {
  const count = Math.max(1, Math.round(brief.panelsCount))
  const label = orientationLabel(brief.orientation).toLowerCase()
  const placement =
    brief.orientation === 'flat' || brief.orientation === 'unknown'
      ? 'on the largest unobstructed roof area'
      : `concentrated on the ${label}-facing roof plane(s)`

  const system =
    'You are an architectural visualiser editing a real top-down satellite ' +
    'aerial photo of a property. You make ONE change only: install ' +
    'residential solar panels on the existing roof. Everything else stays ' +
    'pixel-faithful to the source photo.'
  const user =
    `Render this exact aerial with ${count} dark monocrystalline solar ` +
    `panels (about ${brief.systemKwDc.toFixed(1)} kW) neatly installed in a ` +
    `realistic rectangular grid layout, ${placement}, following the roof's ` +
    'existing ridge lines and leaving sensible edge setbacks. ' +
    'STRICT RULES: keep the exact same building footprint, roof shape, ' +
    'ridges, valleys and number of structures; keep the ground, driveway, ' +
    'trees, pool, fences, vehicles, neighbouring buildings and the camera ' +
    'angle / zoom completely unchanged. Do NOT re-roof or recolour the ' +
    'roof surface, do NOT add or remove buildings, do NOT rotate or ' +
    're-frame, do NOT add text, labels, watermarks or people. ' +
    'Photorealistic panels with consistent lighting and shadows matching ' +
    'the original aerial. The result must read as the SAME property ' +
    'photographed after the solar installation.'
  return { system, user }
}
