// ═══════════════════════════════════════════════════════════════════
// AI preview prompts — CLEARED 2026-05-09 for a from-scratch revamp.
//
// All prior system instructions and rule/instruction content has been
// stripped. This file currently emits ONLY the customer data — no
// rules, no guardrails, no role descriptions, no count enforcement,
// no view-type rules, no anti-augmentation rules.
//
// What remains:
//   · PromptIntake / SystemUserPrompt types (call-site contract)
//   · Helper functions (humanise / colour temp / detect room)
//   · buildBrief() — emits customer verbatim words + structured specs
//     + named-list scaffolding (data only)
//   · buildPreviewPrompt + buildSamplePrompts — return empty system
//     instructions, attach brief + minimal shot label to user message
//
// Next step: write fresh systemInstruction content + user-message
// instruction layer to be filled in below where marked TODO.
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

// ─── Helpers (data formatting only) ───

function humaniseJobType(jobType: string): { plural: string; singular: string } {
  const plural = (jobType ?? '').replace(/_/g, ' ').trim() || 'fittings'
  const singular = /ss$/i.test(plural) ? plural : plural.replace(/s$/i, '')
  return { plural, singular }
}

function colorTempHuman(temp?: string | null): string | null {
  if (!temp || temp === 'unknown') return null
  if (/warm/i.test(temp)) return 'warm white (≈2700K–3000K)'
  if (/cool/i.test(temp)) return 'cool white (≈4000K–5000K)'
  if (/tri/i.test(temp)) return 'tri-colour selectable'
  if (/daylight|natural/i.test(temp)) return 'daylight (≈5000K–6500K)'
  return temp
}

function detectRoom(desc?: string | null): string | null {
  if (!desc) return null
  const m = desc.match(/\b(lounge|living\s*room|kitchen|bedroom|bathroom|dining|study|hallway|garage|deck|patio|courtyard|backyard|laundry|alfresco|ensuite)\b/i)
  return m ? m[1].toLowerCase().replace(/\s+/g, ' ') : null
}

function specLine(label: string, value: string | number | boolean | null | undefined): string | null {
  if (value === null || value === undefined || value === '' || value === 'unknown') return null
  if (typeof value === 'boolean') return `  · ${label}: ${value ? 'yes' : 'no'}`
  return `  · ${label}: ${value}`
}

// ─── Data-only brief (no rules, no enforcement language) ───
function buildBrief(intake: PromptIntake): string {
  const desc = (intake.scope?.description ?? '').trim()
  const callerName = intake.caller?.name?.trim() || null
  const room = detectRoom(desc)
  const { plural: jobLabelPlural, singular: jobLabelSingular } = humaniseJobType(intake.job_type)

  const count = (intake.scope?.item_count && intake.scope.item_count > 0)
    ? intake.scope.item_count
    : 1

  const specs = intake.scope?.specs ?? {}
  const access = intake.access ?? {}
  const property = intake.property ?? {}

  const specLines = [
    specLine('Item count', count),
    specLine('Indoor or outdoor', intake.scope?.indoor_outdoor),
    specLine('New install or replacing existing', intake.scope?.is_new_install === true ? 'new install' : intake.scope?.is_new_install === false ? 'replacing existing' : null),
    specLine('Existing wiring in place', intake.scope?.existing_wiring),
    specLine('Colour temperature', colorTempHuman(specs.color_temp)),
    specLine('Dimmable', specs.dimmable),
    specLine('Smart / Wi-Fi', specs.smart),
    specLine('Weatherproof / IP-rated', specs.weatherproof),
    specLine('Fitting supplied by', specs.supplied_by),
    specLine('Ceiling type', access.ceiling_type),
    specLine('Wall type', access.wall_type),
    specLine('Property bedrooms', property.bedrooms),
    specLine('Property levels', property.levels),
    specLine('Detected room', room),
    specLine('Customer urgency', intake.timing?.urgency),
  ].filter((l): l is string => l !== null)

  const itemLabel = jobLabelSingular.replace(/\b\w/g, c => c.toUpperCase())
  const namedList: string[] = []
  for (let i = 0; i < count; i++) {
    namedList.push(`  • ${itemLabel} #${i + 1} of ${count}`)
  }

  const lines: string[] = []
  lines.push(`CUSTOMER REQUEST (verbatim from SMS conversation):`)
  if (desc) lines.push(`  "${desc.slice(0, 600)}"`)
  if (callerName) lines.push(`  — from ${callerName}`)
  lines.push(``)
  lines.push(`JOB:`)
  lines.push(`  · Job type: ${jobLabelPlural}`)
  lines.push(`  · Count: ${count}`)
  lines.push(``)

  if (specLines.length > 0) {
    lines.push(`SPECS CAPTURED FROM CONVERSATION:`)
    for (const s of specLines) lines.push(s)
    lines.push(``)
  }

  lines.push(`ITEMS (${count}):`)
  for (const l of namedList) lines.push(l)

  return lines.join('\n')
}

// ════════════════════════════════════════════════════════════════════
// PREVIEW prompt — system instruction CLEARED
// ════════════════════════════════════════════════════════════════════

export function buildPreviewPrompt(intake: PromptIntake): SystemUserPrompt {
  const brief = buildBrief(intake)

  // TODO (revamp): write fresh system instruction for the photo-edit
  // preview surface. Should respect the customer specs above and the
  // attached reference photo.
  const system = ''

  const user = [
    brief,
    ``,
    `SHOT: AI Preview — edit attached customer photo.`,
  ].join('\n')

  return { system, user }
}

// ════════════════════════════════════════════════════════════════════
// SAMPLE prompts — system instructions CLEARED
// ════════════════════════════════════════════════════════════════════

export type SamplePromptSet = {
  wide: SystemUserPrompt
  detail: SystemUserPrompt
  lit: SystemUserPrompt
}

export type SamplePromptOpts = {
  usePhotoReference?: boolean
}

export function buildSamplePrompts(intake: PromptIntake, _opts: SamplePromptOpts = {}): SamplePromptSet | null {
  const brief = buildBrief(intake)

  // TODO (revamp): write fresh system instructions per shot type
  // (wide / close-up / in-use). Should respect the customer specs
  // above and (when present) the attached reference photo.
  const system = ''

  return {
    wide:   { system, user: `${brief}\n\nSHOT: Wide-angle sample.` },
    detail: { system, user: `${brief}\n\nSHOT: Close-up / macro sample.` },
    lit:    { system, user: `${brief}\n\nSHOT: In-use / dusk sample.` },
  }
}
