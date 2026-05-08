// ═══════════════════════════════════════════════════════════════════
// AI preview prompts — per job_type templates for Gemini 2.5 Flash Image.
//
// Two surfaces:
//
//   1. PREVIEW   — buildPreviewPrompt(intake)
//      ONE call per uploaded customer photo. Each call edits the
//      customer's actual photo to show the proposed work.
//
//   2. SAMPLES   — buildSamplePrompts(intake, mode)
//      Three renders (wide / close-up / in-use) showing a coherent
//      view of the same scene. Two modes:
//
//      mode='edit_customer_photo'
//         All three samples use the customer's first uploaded photo
//         as the reference image. Samples = customer's actual room
//         from three different camera positions / lighting states,
//         with the proposed work installed.
//
//      mode='text_to_image'
//         No customer photos available. Wide is text-to-image (anchor),
//         then detail + lit reference the wide. Samples = a generic
//         fictional Aussie home for representational purposes only.
//
// Accuracy rules (every prompt):
//   - JOB SPEC block at the top with EXACTLY N fittings, colour temp,
//     dimming, replace vs new
//   - Negative constraints (no people, pets, hands, text)
//   - Directive view-type wording (ULTRA-WIDE / MACRO CLOSE-UP /
//     DUSK INTERIOR — not "a sample of") so Gemini renders the right
//     framing instead of generic-ish output
// ═══════════════════════════════════════════════════════════════════

export type PromptIntake = {
  job_type: string
  scope?: {
    item_count?: number | null
    description?: string | null
    color_temp?: string | null
    dimmable?: boolean | null
  } | null
  access?: {
    ceiling_type?: string | null
    wall_type?: string | null
  } | null
  caller?: { name?: string | null } | null
}

export type SampleMode = 'edit_customer_photo' | 'text_to_image'

function detectRoom(desc?: string | null): string {
  if (!desc) return 'room'
  const m = desc.match(/\b(lounge|living\s*room|kitchen|bedroom|bathroom|dining|study|hallway|garage|deck|patio|courtyard|backyard|laundry)\b/i)
  return m ? m[1].toLowerCase().replace(/\s+/g, ' ') : 'room'
}

function colorTempHint(temp?: string | null): string {
  if (!temp) return '2700K-3000K (warm white)'
  if (/cool/i.test(temp)) return '4000K-5000K (cool white)'
  if (/tri/i.test(temp)) return '3000K-5000K (tri-colour, render as warm 3000K)'
  if (/daylight|natural/i.test(temp)) return '5000K-6500K (daylight)'
  return '2700K-3000K (warm white)'
}

function footerText(label: 'preview' | 'wide' | 'detail' | 'lit' = 'preview'): string {
  const watermark =
    label === 'preview'
      ? `WATERMARK: small semi-transparent "AI PREVIEW" in the bottom-right corner.`
      : `WATERMARK: small semi-transparent "AI SAMPLE" in the bottom-right corner.`
  return [
    watermark,
    `STYLE: photorealistic, modern Australian residential interior, magazine-quality.`,
    `OUTPUT: a single image, 4:3 aspect, no text overlays beyond the watermark, no captions, no logos.`,
    `NEGATIVE: do NOT include people, pets, hands, text labels, ruler-style call-outs, annotations, or watermarks beyond the one specified above.`,
  ].join('\n')
}

// ─── JOB SPEC BLOCK ──────────────────────────────────────────────────
// Structured "must-match" summary. Surfaced near the top of every prompt.
function jobSpec(intake: PromptIntake): string | null {
  const count = intake.scope?.item_count ?? 0
  const room = detectRoom(intake.scope?.description)
  const ceiling = intake.access?.ceiling_type ?? 'flat plaster'
  const tempK = colorTempHint(intake.scope?.color_temp)
  const dimmable = intake.scope?.dimmable === true ? 'dimmable' : 'non-dimmable'
  const desc = (intake.scope?.description ?? '').trim()

  switch (intake.job_type) {
    case 'downlights':
      return [
        `JOB SPEC — RENDER MUST MATCH EXACTLY:`,
        `  · Job type: downlight installation`,
        `  · Count: EXACTLY ${count || 6} downlight fittings — count them, no more, no fewer`,
        `  · Room: ${room}`,
        `  · Ceiling: ${ceiling}`,
        `  · Colour temperature: ${tempK}`,
        `  · Dimming: ${dimmable}`,
        `  · Layout: evenly spaced grid pattern across the ceiling`,
        `  · Status: lights ON, beam visible from each fitting`,
        desc ? `  · Customer description: "${desc.slice(0, 200)}"` : '',
      ].filter(Boolean).join('\n')

    case 'power_points':
      return [
        `JOB SPEC — RENDER MUST MATCH EXACTLY:`,
        `  · Job type: GPO (general purpose outlet) installation`,
        `  · Count: EXACTLY ${count || 4} double GPOs — count them, no more, no fewer`,
        `  · Room: ${room}`,
        `  · Faceplate: white, AS/NZS 3112 standard Australian 3-pin double socket`,
        `  · Mounting height: standard ~30cm above skirting`,
        `  · Spacing: evenly distributed along the wall(s)`,
        desc ? `  · Customer description: "${desc.slice(0, 200)}"` : '',
      ].filter(Boolean).join('\n')

    case 'ceiling_fans':
      return [
        `JOB SPEC — RENDER MUST MATCH EXACTLY:`,
        `  · Job type: ceiling fan installation`,
        `  · Count: EXACTLY ${count || 1} ceiling fan${count > 1 ? 's' : ''}`,
        `  · Room: ${room}`,
        `  · Ceiling: ${ceiling}`,
        `  · Style: modern 3-blade, matte white or brushed nickel finish`,
        `  · Light kit: integrated LED downlight in the centre of the fan`,
        desc ? `  · Customer description: "${desc.slice(0, 200)}"` : '',
      ].filter(Boolean).join('\n')

    case 'smoke_alarms':
      return [
        `JOB SPEC — RENDER MUST MATCH EXACTLY:`,
        `  · Job type: hardwired photoelectric smoke alarm installation`,
        `  · Count: EXACTLY ${count || 4} smoke alarms`,
        `  · Room: ${room} / hallway`,
        `  · Fitting: small white circular, ~10cm diameter, AS 3786 compliant`,
        `  · Mounting: ${ceiling} ceiling, central position per Australian standard`,
        desc ? `  · Customer description: "${desc.slice(0, 200)}"` : '',
      ].filter(Boolean).join('\n')

    case 'outdoor_lighting':
      return [
        `JOB SPEC — RENDER MUST MATCH EXACTLY:`,
        `  · Job type: outdoor LED light installation`,
        `  · Count: EXACTLY ${count || 4} weatherproof IP-rated fittings`,
        `  · Mounting area: deck / eaves / outdoor wall`,
        `  · Colour temperature: ${tempK}`,
        `  · Status: lights ON, warm welcoming glow at dusk`,
        desc ? `  · Customer description: "${desc.slice(0, 200)}"` : '',
      ].filter(Boolean).join('\n')

    default:
      return null
  }
}

// ════════════════════════════════════════════════════════════════════
// PREVIEW prompt (one per uploaded customer photo)
// ════════════════════════════════════════════════════════════════════

export function buildPreviewPrompt(intake: PromptIntake): string {
  const spec = jobSpec(intake)
  const room = detectRoom(intake.scope?.description)

  const header = [
    `You are an interior visualisation assistant for an Australian electrical contractor's customer preview.`,
    ``,
    `THE ATTACHED IMAGE IS THE CUSTOMER'S ACTUAL ROOM — taken before any electrical work has been done. Your job is to EDIT THAT IMAGE to show what it would look like with the proposed work completed. Treat it as the base scene, not as inspiration. Keep everything else identical.`,
  ].join('\n')

  const constraint = [
    `KEEP UNCHANGED: room layout, walls, floor, furniture, decor, ambient lighting, perspective, camera angle.`,
    `MODIFY ONLY: the specific fixture area for this job (ceiling for downlights/fans/smoke alarms, wall for GPOs, exterior surface for outdoor lighting).`,
    `STYLE: photorealistic, match the lighting + colour grading of the input photo.`,
    footerText('preview'),
  ].join('\n')

  if (!spec) {
    return [
      header,
      ``,
      `PROPOSED WORK: ${intake.scope?.description ?? '(unspecified electrical work)'}`,
      ``,
      constraint,
    ].join('\n')
  }

  return [
    header,
    ``,
    spec,
    ``,
    `Modify the customer's ${room} photo so it shows the work above completed cleanly. The customer must be able to recognise their own room while seeing the proposed change.`,
    ``,
    constraint,
  ].join('\n')
}

// ════════════════════════════════════════════════════════════════════
// SAMPLE prompts — three coherent views (wide / close-up / in-use)
// ════════════════════════════════════════════════════════════════════

export type SamplePromptSet = {
  // Generated FIRST. In edit_customer_photo mode, references the
  // customer's photo. In text_to_image mode, no reference (anchor).
  wide: string
  // Generated SECOND. References either the customer's photo (edit
  // mode) or the wide shot (text-to-image mode). Forces a MACRO
  // close-up framing.
  detail: string
  // Generated SECOND. Same reference rules as detail. Forces
  // dusk/night lighting state.
  lit: string
}

// ─── SHARED SCENE ANCHOR (text_to_image mode only) ───────────────────
function genericSceneAnchor(intake: PromptIntake): string {
  const room = detectRoom(intake.scope?.description)
  const ceiling = intake.access?.ceiling_type ?? 'flat plaster'
  return [
    `SHARED SCENE — ALL THREE SAMPLE IMAGES MUST SHOW THE SAME ROOM:`,
    `  Setting: a contemporary Australian residential ${room} interior`,
    `  Ceiling: ${ceiling}, painted matte white, ~2.7m height`,
    `  Walls: warm neutral cream / off-white painted plaster`,
    `  Flooring: blonde oak engineered timber, matte finish`,
    `  Furniture: minimalist — single sofa or armchair, low coffee table, no clutter`,
    `  Window: tall, sheer linen curtains, daylight visible outside`,
    `  Camera: eye-level, slightly off-centre, 35mm prime style`,
    `KEEP EVERYTHING ABOVE IDENTICAL across the wide / detail / in-use shots.`,
  ].join('\n')
}

export function buildSamplePrompts(intake: PromptIntake, mode: SampleMode): SamplePromptSet | null {
  const spec = jobSpec(intake)
  if (!spec) return null

  const tempK = colorTempHint(intake.scope?.color_temp)

  if (mode === 'edit_customer_photo') {
    return buildSamplePromptsForCustomerPhoto(intake, spec, tempK)
  }
  return buildSamplePromptsForTextToImage(intake, spec, tempK)
}

// ─── MODE A: customer photo is the reference ─────────────────────────
function buildSamplePromptsForCustomerPhoto(
  intake: PromptIntake,
  spec: string,
  tempK: string,
): SamplePromptSet {
  const count = intake.scope?.item_count ?? 0

  const sharedHeader = [
    `THE ATTACHED IMAGE IS THE CUSTOMER'S ACTUAL ROOM — same one used for the AI preview above. Generate a sample render of THIS SAME ROOM with the proposed work installed, framed as the specific view-type below.`,
    ``,
    `KEEP IDENTICAL TO THE REFERENCE PHOTO:`,
    `  · Same room — same walls, same floor, same furniture, same decor`,
    `  · Same general lighting + colour grading (unless explicitly changed below)`,
    `  · Recognisable as the customer's own room from any angle`,
  ].join('\n')

  // ─── WIDE — pull-back, full-room framing ───
  const wide = [
    sharedHeader,
    ``,
    spec,
    ``,
    `THIS SHOT — ULTRA-WIDE / FULL ROOM:`,
    `  · Pull the camera BACK so you see as much of the room as possible`,
    `  · Wider framing than the reference photo — show ceiling, floor, walls, all major furniture`,
    `  · ALL ${count || 'requested'} fittings clearly visible in this single frame, evenly spaced`,
    `  · Daytime ambient lighting — fittings powered ON, beams visible`,
    `  · The customer should immediately recognise this as a wide-angle photo of THEIR room`,
    ``,
    footerText('wide'),
  ].join('\n')

  // ─── DETAIL — macro close-up of one fitting ───
  const detail = [
    sharedHeader,
    ``,
    spec,
    ``,
    `THIS SHOT — MACRO CLOSE-UP / SINGLE FITTING:`,
    `  · Tight crop showing ONE fitting filling most of the frame`,
    `  · Camera distance ~50 centimetres from the fitting`,
    `  · The fitting's face plate, trim, and beam pattern must be clearly visible`,
    `  · Background: rest of the customer's room visible but in shallow bokeh / out of focus`,
    `  · ${tempK} colour temperature visible in any emitted light`,
    `  · This is NOT a wide-angle shot — it must look like a photographer crouched up close`,
    ``,
    footerText('detail'),
  ].join('\n')

  // ─── LIT — dusk / night-time, lights illuminating the room ───
  const lit = [
    sharedHeader,
    ``,
    spec,
    ``,
    `THIS SHOT — IN USE / DUSK INTERIOR:`,
    `  · Same camera framing as the reference photo (or close to it)`,
    `  · Time of day: DUSK or EARLY NIGHT — windows show deep blue / purple sky outside`,
    `  · Interior is darker than the reference; the new fittings provide the dominant light`,
    `  · Warm cosy ambient glow from the fittings, gentle reflections on the floor + furniture`,
    `  · This MUST look meaningfully different from the wide shot — sky outside, lights visibly working`,
    ``,
    footerText('lit'),
  ].join('\n')

  return { wide, detail, lit }
}

// ─── MODE B: text-to-image (no customer photo) ───────────────────────
function buildSamplePromptsForTextToImage(
  intake: PromptIntake,
  spec: string,
  tempK: string,
): SamplePromptSet {
  const room = detectRoom(intake.scope?.description)
  const count = intake.scope?.item_count ?? 0
  const anchor = genericSceneAnchor(intake)

  const wide = [
    `You are producing a series of three coherent sample images of an electrical install for a customer preview. THIS IS IMAGE 1 OF 3 — the WIDE SHOT.`,
    ``,
    spec,
    ``,
    anchor,
    ``,
    `THIS SHOT — ULTRA-WIDE / FULL ROOM:`,
    `  · Pull the camera back ~3-4 metres — show the whole ${room}`,
    `  · ALL ${count || 'requested'} fittings visible in this single frame`,
    `  · Daytime ambient lighting through the window, fittings powered ON`,
    ``,
    footerText('wide'),
  ].join('\n')

  const detail = [
    `THE ATTACHED IMAGE IS THE WIDE SHOT YOU JUST GENERATED. Now produce IMAGE 2 OF 3 — a MACRO CLOSE-UP of one fitting from that same scene.`,
    ``,
    `KEEP IDENTICAL TO THE REFERENCE: same ceiling material + colour, same walls, same lighting, same fitting style, same finish.`,
    ``,
    `THIS SHOT — MACRO CLOSE-UP / SINGLE FITTING:`,
    `  · Tight close-up of ONE fitting, filling most of the frame`,
    `  · Camera distance ~50 centimetres`,
    `  · Face plate, trim, beam pattern clearly visible`,
    `  · Rest of the scene falls into shallow bokeh`,
    `  · ${tempK} colour temperature visible in the beam pattern`,
    ``,
    footerText('detail'),
  ].join('\n')

  const lit = [
    `THE ATTACHED IMAGE IS THE WIDE SHOT YOU JUST GENERATED. Now produce IMAGE 3 OF 3 — the SAME ROOM AT DUSK with the new fittings illuminating it.`,
    ``,
    `KEEP IDENTICAL TO THE REFERENCE: exact same room, same furniture position, same wall colour, same ceiling, same camera angle, same ${count || 'fittings'} count + placement.`,
    ``,
    `THIS SHOT — IN USE / DUSK INTERIOR:`,
    `  · Time of day: DUSK or EARLY NIGHT — sky outside in deep blue / purple twilight`,
    `  · Interior glow: ${tempK} from the new fittings, cosy ambient atmosphere`,
    `  · Subtle warm reflections on the timber floor + furniture`,
    `  · Must look VISUALLY DIFFERENT from the wide shot — different time of day, fittings now the dominant light source`,
    ``,
    footerText('lit'),
  ].join('\n')

  return { wide, detail, lit }
}
