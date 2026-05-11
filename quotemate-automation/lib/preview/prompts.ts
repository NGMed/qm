// ═══════════════════════════════════════════════════════════════════
// AI preview prompts — system instructions DELETED 2026-05-09.
//
// All systemInstruction content has been cleared. Every Gemini call
// now sends an empty system: '' and a minimal user message. The file
// retains only the type contract so the callers (generate.ts and
// samples.ts) still compile.
// ═══════════════════════════════════════════════════════════════════

export type PromptIntake = {
  job_type: string
  scope?: {
    item_count?: number | null
    is_new_install?: boolean | null
    existing_wiring?: boolean | null
    indoor_outdoor?: 'indoor' | 'outdoor' | 'both' | 'unknown' | null
    description?: string | null
    specs?: {
      color_temp?: 'warm_white' | 'cool_white' | 'tri_colour' | 'unknown' | null
      dimmable?: boolean | null
      smart?: boolean | null
      weatherproof?: boolean | null
      supplied_by?: 'tradie' | 'customer' | null
    } | null
  } | null
  access?: {
    roof_access?: boolean | null
    ceiling_type?: 'flat' | 'raked' | 'high' | 'unknown' | null
    wall_type?: 'plaster' | 'brick' | 'concrete' | 'tile' | 'unknown' | null
  } | null
  property?: {
    bedrooms?: number | null
    levels?: number | null
  } | null
  caller?: { name?: string | null } | null
  timing?: {
    urgency?: 'emergency' | 'this_week' | 'this_month' | 'flexible' | null
  } | null
}

export type SystemUserPrompt = {
  system: string
  user: string
}

export function buildPreviewPrompt(_intake: PromptIntake): SystemUserPrompt {
  return { system: '', user: '' }
}

export type SamplePromptSet = {
  wide: SystemUserPrompt
  detail: SystemUserPrompt
  lit: SystemUserPrompt
}

export type SamplePromptOpts = {
  usePhotoReference?: boolean
}

export function buildSamplePrompts(_intake: PromptIntake, _opts: SamplePromptOpts = {}): SamplePromptSet | null {
  const empty: SystemUserPrompt = { system: '', user: '' }
  return {
    wide:   empty,
    detail: empty,
    lit:    empty,
  }
}
