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

// ─── COUNT ENFORCEMENT ───────────────────────────────────────────────
// Text-to-image models notoriously miscount when asked for "3" or "4"
// of something. Explicit position-by-position numbering ("fitting #1
// here, #2 here, #3 here") materially improves count accuracy. This
// block is REPEATED in multiple places in the prompt so the model
// can't ignore it.
function countEnforcement(noun: string, count: number): string {
  const n = count || 1
  const positionSlots = Array.from({ length: n }, (_, i) => `[${i + 1}]`).join(' ')
  return [
    `═══ COUNT IS NON-NEGOTIABLE ═══`,
    `Render EXACTLY ${n} ${noun}. NOT ${n - 1}. NOT ${n + 1}.`,
    `Before finalising the image, count them mentally: ${positionSlots}`,
    `If your draft has fewer, ADD MORE until ${n} are visible.`,
    `If your draft has more, REMOVE the extras until exactly ${n} remain.`,
    `If the camera angle won't fit ${n}, PULL BACK to a wider shot until all ${n} fit.`,
    `═══════════════════════════════`,
  ].join('\n')
}

// ─── PLACEMENT MAP ───────────────────────────────────────────────────
// Per-job-type guidance on WHERE each fitting goes. Stops the model
// clustering all N fittings in one spot or omitting some because
// "the room doesn't have space".
function placementMap(intake: PromptIntake): string {
  const count = intake.scope?.item_count ?? 0
  const n = count || 1

  switch (intake.job_type) {
    case 'downlights':
      // Even grid across the ceiling — N spread evenly.
      return [
        `PLACEMENT MAP — show ALL ${n} downlights spread across the ceiling:`,
        `  · ${n <= 4 ? 'single row' : '2-row grid'} pattern`,
        `  · spacing: equal distance between each fitting`,
        `  · all visible in a single ceiling-up viewing angle`,
      ].join('\n')

    case 'power_points':
      // GPOs along walls.
      return [
        `PLACEMENT MAP — show ALL ${n} double GPOs along the wall(s):`,
        `  · evenly spaced horizontally`,
        `  · all at standard ~30cm height above skirting`,
        `  · all visible in one wall-facing camera angle`,
      ].join('\n')

    case 'ceiling_fans':
      return [
        `PLACEMENT MAP — show ALL ${n} ceiling fan${n > 1 ? 's' : ''}:`,
        n === 1
          ? `  · single fan centred on the ceiling`
          : `  · one fan per room area, all visible in this frame`,
      ].join('\n')

    case 'smoke_alarms':
      // AS 3786 typical placement — one per "zone": hallway + bedroom + living.
      return [
        `PLACEMENT MAP — show ALL ${n} smoke alarms positioned per AS 3786:`,
        n === 1 ? `  · alarm #1: hallway ceiling near bedrooms` :
        n === 2 ? `  · alarm #1: hallway ceiling near bedrooms\n  · alarm #2: living/dining ceiling` :
        n === 3 ? `  · alarm #1: hallway ceiling near bedrooms\n  · alarm #2: living/dining ceiling\n  · alarm #3: bedroom ceiling (master)` :
        n === 4 ? `  · alarm #1: hallway ceiling near bedrooms\n  · alarm #2: living/dining ceiling\n  · alarm #3: master bedroom ceiling\n  · alarm #4: second bedroom ceiling` :
        `  · ${n} alarms total — distribute one per major room/hallway, all on the ceiling`,
        `  · all ${n} alarms must be visible in this frame; widen the angle if needed`,
        `  · each is small (~10cm diameter), white, circular, mounted flush on the ceiling`,
      ].join('\n')

    case 'outdoor_lighting':
      return [
        `PLACEMENT MAP — show ALL ${n} outdoor light fittings:`,
        `  · evenly spaced along the deck / eaves / outdoor wall`,
        `  · all visible in one outdoor camera angle`,
        `  · weatherproof gasket visible, mounted to the substrate`,
      ].join('\n')

    default:
      return ''
  }
}

// ─── JOB SPEC BLOCK ──────────────────────────────────────────────────
// Structured "must-match" summary. Surfaced near the top of every prompt.
// The count is repeated three times across the spec block + count
// enforcement + placement map — this is intentional, not a typo.
function jobSpec(intake: PromptIntake): string | null {
  const count = intake.scope?.item_count ?? 0
  const room = detectRoom(intake.scope?.description)
  const ceiling = intake.access?.ceiling_type ?? 'flat plaster'
  const tempK = colorTempHint(intake.scope?.color_temp)
  const dimmable = intake.scope?.dimmable === true ? 'dimmable' : 'non-dimmable'
  const desc = (intake.scope?.description ?? '').trim()

  let baseSpec: string[] | null = null

  switch (intake.job_type) {
    case 'downlights':
      baseSpec = [
        `JOB SPEC — RENDER MUST MATCH EXACTLY:`,
        `  · Job type: downlight installation`,
        `  · Count: EXACTLY ${count || 6} downlight fittings — count them, no more, no fewer`,
        `  · Room: ${room}`,
        `  · Ceiling: ${ceiling}`,
        `  · Colour temperature: ${tempK}`,
        `  · Dimming: ${dimmable}`,
        `  · Layout: evenly spaced across the ceiling, all visible in one frame`,
        `  · Status: lights ON, beam visible from each fitting`,
      ]
      break

    case 'power_points':
      baseSpec = [
        `JOB SPEC — RENDER MUST MATCH EXACTLY:`,
        `  · Job type: GPO (general purpose outlet) installation`,
        `  · Count: EXACTLY ${count || 4} double GPOs — count them, no more, no fewer`,
        `  · Room: ${room}`,
        `  · Faceplate: white, AS/NZS 3112 standard Australian 3-pin double socket`,
        `  · Mounting height: standard ~30cm above skirting`,
        `  · Spacing: evenly distributed along the wall(s), all visible in one frame`,
      ]
      break

    case 'ceiling_fans':
      baseSpec = [
        `JOB SPEC — RENDER MUST MATCH EXACTLY:`,
        `  · Job type: ceiling fan installation`,
        `  · Count: EXACTLY ${count || 1} ceiling fan${count > 1 ? 's' : ''}`,
        `  · Room: ${room}`,
        `  · Ceiling: ${ceiling}`,
        `  · Style: modern 3-blade, matte white or brushed nickel finish`,
        `  · Light kit: integrated LED downlight in the centre of the fan`,
      ]
      break

    case 'smoke_alarms':
      baseSpec = [
        `JOB SPEC — RENDER MUST MATCH EXACTLY:`,
        `  · Job type: hardwired photoelectric smoke alarm installation`,
        `  · Count: EXACTLY ${count || 4} smoke alarms — must show ALL of them in the frame`,
        `  · Room: ${room} / hallway / multi-area distribution`,
        `  · Fitting: small white circular, ~10cm diameter, AS 3786 compliant, photoelectric`,
        `  · Mounting: flush on the ${ceiling} ceiling`,
        `  · Spacing: minimum 30cm from any wall, distributed across rooms per AS 3786`,
      ]
      break

    case 'outdoor_lighting':
      baseSpec = [
        `JOB SPEC — RENDER MUST MATCH EXACTLY:`,
        `  · Job type: outdoor LED light installation`,
        `  · Count: EXACTLY ${count || 4} weatherproof IP-rated fittings`,
        `  · Mounting area: deck / eaves / outdoor wall`,
        `  · Colour temperature: ${tempK}`,
        `  · Status: lights ON, warm welcoming glow at dusk`,
      ]
      break

    default:
      return null
  }

  // Append the placement map, count enforcement, and customer description.
  const noun =
    intake.job_type === 'downlights' ? 'downlights' :
    intake.job_type === 'power_points' ? 'double GPOs' :
    intake.job_type === 'ceiling_fans' ? `ceiling fan${(count || 1) > 1 ? 's' : ''}` :
    intake.job_type === 'smoke_alarms' ? 'smoke alarms' :
    intake.job_type === 'outdoor_lighting' ? 'outdoor light fittings' :
    'fittings'

  return [
    baseSpec.join('\n'),
    desc ? `  · Customer description (verbatim): "${desc.slice(0, 240)}"` : '',
    '',
    placementMap(intake),
    '',
    countEnforcement(noun, count),
  ].filter(Boolean).join('\n')
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
  const fittingNoun = fittingSingular(intake.job_type)

  const sharedHeader = [
    `THE ATTACHED IMAGE IS THE CUSTOMER'S ACTUAL ROOM — same one used for the AI preview above. Generate a sample render of THIS SAME ROOM with the proposed work installed, framed as the specific view-type below.`,
    ``,
    `KEEP IDENTICAL TO THE REFERENCE PHOTO:`,
    `  · Same room — same walls, same floor, same furniture, same decor`,
    `  · Same general lighting + colour grading (unless explicitly changed below)`,
    `  · Recognisable as the customer's own room from any angle`,
  ].join('\n')

  // ─── WIDE — pull-back, full-room framing, ALL N fittings visible ───
  const wide = [
    sharedHeader,
    ``,
    spec,
    ``,
    `THIS SHOT — ULTRA-WIDE / FULL ROOM:`,
    `  · Pull the camera BACK far enough to fit ALL ${count || 'the requested'} fittings in one frame`,
    `  · Wider framing than the reference photo — ceiling, floor, walls, all major furniture all visible`,
    `  · Every single one of the ${count || 'requested'} fittings must be clearly visible and countable`,
    `  · Daytime ambient lighting — fittings powered ON, beams/glow visible`,
    `  · The customer should immediately recognise this as a wide-angle photo of THEIR room`,
    ``,
    `BEFORE FINALISING: count the ${fittingNoun} in the frame. There must be EXACTLY ${count || 'as specified'}. If fewer, widen the angle and add more.`,
    ``,
    footerText('wide'),
  ].join('\n')

  // ─── DETAIL — MACRO close-up of EXACTLY ONE fitting ───
  const detail = [
    sharedHeader,
    ``,
    spec,
    ``,
    `╔══════════════════════════════════════════════════════════╗`,
    `║  THIS SHOT IS A MACRO CLOSE-UP — NOT A WIDE-ANGLE SHOT  ║`,
    `╚══════════════════════════════════════════════════════════╝`,
    ``,
    `FRAMING (CRITICAL):`,
    `  · Show EXACTLY ONE ${fittingNoun} — a single fitting only, not multiple`,
    `  · The single ${fittingNoun} must FILL 60-80% of the frame`,
    `  · Camera distance: ~30-50 centimetres from the fitting`,
    `  · Tight, intimate crop — like a product-photography shot`,
    `  · NO other fittings visible in the frame, NO wide-angle composition`,
    ``,
    `THE SINGLE ${fittingNoun.toUpperCase()}:`,
    `  · Show its face plate, trim, finish, and surface texture in detail`,
    `  · ${tempK} colour temperature visible in any emitted light`,
    `  · This is the actual product being installed (or replaced) — show it clearly`,
    ``,
    `BACKGROUND:`,
    `  · Rest of the customer's room visible but BLURRED / out of focus (shallow depth-of-field bokeh)`,
    `  · Just enough context to tell it's the customer's room — not a wide pull-back`,
    ``,
    `REJECT THESE FRAMINGS (DO NOT PRODUCE):`,
    `  · A pull-back room view`,
    `  · Multiple fittings visible in the frame`,
    `  · The fitting smaller than 50% of the image`,
    ``,
    footerText('detail'),
  ].join('\n')

  // ─── LIT — dusk, lights illuminating the room ───
  const lit = [
    sharedHeader,
    ``,
    spec,
    ``,
    `THIS SHOT — IN USE / DUSK INTERIOR:`,
    `  · Same camera framing as the wide shot — wide enough to see ALL ${count || 'the requested'} fittings`,
    `  · Time of day: DUSK or EARLY NIGHT — windows show deep blue / purple sky outside`,
    `  · Interior is darker than the reference; the new fittings provide the dominant light`,
    `  · Warm cosy ambient glow from the fittings, gentle reflections on the floor + furniture`,
    `  · This MUST look meaningfully different from the wide shot (different time of day, lights as the dominant source)`,
    `  · ALL ${count || 'requested'} fittings must still be visible and powered ON`,
    ``,
    `BEFORE FINALISING: count the ${fittingNoun} in the frame. EXACTLY ${count || 'as specified'} — no fewer.`,
    ``,
    footerText('lit'),
  ].join('\n')

  return { wide, detail, lit }
}

// Singular-form noun used in count-enforcement copy.
function fittingSingular(jobType: string): string {
  switch (jobType) {
    case 'downlights': return 'downlight'
    case 'power_points': return 'GPO'
    case 'ceiling_fans': return 'ceiling fan'
    case 'smoke_alarms': return 'smoke alarm'
    case 'outdoor_lighting': return 'outdoor light fitting'
    default: return 'fitting'
  }
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
  const fittingNoun = fittingSingular(intake.job_type)

  const wide = [
    `You are producing a series of three coherent sample images of an electrical install for a customer preview. THIS IS IMAGE 1 OF 3 — the WIDE SHOT.`,
    ``,
    spec,
    ``,
    anchor,
    ``,
    `THIS SHOT — ULTRA-WIDE / FULL ROOM:`,
    `  · Pull the camera back ~3-4 metres — show the whole ${room}`,
    `  · ALL ${count || 'the requested'} fittings visible in this single frame`,
    `  · Daytime ambient lighting through the window, fittings powered ON`,
    ``,
    `BEFORE FINALISING: count the ${fittingNoun} in the frame. EXACTLY ${count || 'as specified'} — no more, no fewer. Widen the angle if you can't fit them all.`,
    ``,
    footerText('wide'),
  ].join('\n')

  const detail = [
    `THE ATTACHED IMAGE IS THE WIDE SHOT YOU JUST GENERATED. Now produce IMAGE 2 OF 3 — a MACRO CLOSE-UP of ONE single fitting from that same scene.`,
    ``,
    `KEEP IDENTICAL TO THE REFERENCE: same ceiling material + colour, same walls, same lighting, same fitting style, same finish.`,
    ``,
    spec,
    ``,
    `╔══════════════════════════════════════════════════════════╗`,
    `║  THIS SHOT IS A MACRO CLOSE-UP — NOT A WIDE-ANGLE SHOT  ║`,
    `╚══════════════════════════════════════════════════════════╝`,
    ``,
    `FRAMING (CRITICAL):`,
    `  · Show EXACTLY ONE ${fittingNoun} — a single fitting only, not multiple`,
    `  · The single ${fittingNoun} must FILL 60-80% of the frame`,
    `  · Camera distance: ~30-50 centimetres`,
    `  · Tight, intimate crop — like a product-photography shot`,
    ``,
    `THE SINGLE ${fittingNoun.toUpperCase()}:`,
    `  · Show its face plate, trim, finish, and surface texture in detail`,
    `  · ${tempK} colour temperature visible in any emitted light`,
    `  · This is the actual product being installed/replaced — show it clearly`,
    ``,
    `BACKGROUND:`,
    `  · Rest of the scene visible but BLURRED in shallow depth-of-field bokeh`,
    ``,
    `REJECT THESE FRAMINGS (DO NOT PRODUCE):`,
    `  · A pull-back room view`,
    `  · Multiple fittings in the frame`,
    `  · The fitting smaller than 50% of the image`,
    ``,
    footerText('detail'),
  ].join('\n')

  const lit = [
    `THE ATTACHED IMAGE IS THE WIDE SHOT YOU JUST GENERATED. Now produce IMAGE 3 OF 3 — the SAME ROOM AT DUSK with the new fittings illuminating it.`,
    ``,
    `KEEP IDENTICAL TO THE REFERENCE: exact same room, same furniture position, same wall colour, same ceiling, same camera angle, same ${count || 'fittings'} count + placement.`,
    ``,
    spec,
    ``,
    `THIS SHOT — IN USE / DUSK INTERIOR:`,
    `  · Time of day: DUSK or EARLY NIGHT — sky outside in deep blue / purple twilight`,
    `  · Interior glow: ${tempK} from the new fittings, cosy ambient atmosphere`,
    `  · Subtle warm reflections on the timber floor + furniture`,
    `  · Must look VISUALLY DIFFERENT from the wide shot — different time of day, fittings now the dominant light source`,
    `  · ALL ${count || 'requested'} fittings still visible and powered ON`,
    ``,
    `BEFORE FINALISING: count the ${fittingNoun} in the frame. EXACTLY ${count || 'as specified'}.`,
    ``,
    footerText('lit'),
  ].join('\n')

  return { wide, detail, lit }
}
