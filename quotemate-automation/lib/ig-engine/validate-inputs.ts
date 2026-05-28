// ════════════════════════════════════════════════════════════════════
// Stage 0 — pre-flight input validation for the IG engine.
//
// Refuses to call Gemini when the inputs are unrenderable. Catches the
// class of defect that no amount of model retrying / judging will fix:
// missing count, missing anchor product, broken catalogue photo URL,
// replacement job with no source photo to edit, spec contradictions.
//
// Pure module — no fetch, no Supabase, no SDK. The one network probe
// (catalogue photo reachability) is injected via the `probeProductImage`
// dependency so the unit tests can mock it. generate.ts wires it to
// resolveProductImage(); tests pass a stub.
//
// Output: { ok: true } OR { ok: false, reasons: ValidationReason[] }.
// Each reason carries a stable `code` + operator-actionable `detail`
// so the dashboard can show "fix X in the catalogue" instead of just
// "render failed".
// ════════════════════════════════════════════════════════════════════

import {
  effectiveItemCount,
  isReplacementJob,
  pickAnchorImagePath,
  pickAnchorLine,
  type PromptContext,
} from './prompts'

export type ValidationCode =
  | 'no_job_type'
  | 'no_effective_count'
  | 'no_anchor_product'
  | 'anchor_photo_unreachable'
  | 'replacement_without_source_photo'
  | 'weatherproof_indoor_contradiction'
  | 'photo_paths_present_but_first_unreadable'

export type ValidationReason = {
  /** Stable identifier — the dashboard can map this to a fix-it CTA. */
  code: ValidationCode
  /** Human-readable, operator-actionable. */
  detail: string
  /** When false, the render is still allowed (soft warning). Defaults true. */
  fatal?: boolean
}

export type ValidationResult =
  | { ok: true; warnings: ValidationReason[] }
  | { ok: false; reasons: ValidationReason[] }

/** Injected probe — true iff the catalogue photo is reachable + a valid
 *  image. generate.ts wires this to resolveProductImage; tests stub it. */
export type ProbeProductImage = (
  pathOrUrl: string,
) => Promise<boolean>

export type ValidateOpts = {
  /** Storage paths of customer photos for this intake (intake.photo_paths). */
  photoPaths: string[]
  /** Optional probe — when omitted, anchor_photo_unreachable is downgraded
   *  to a warning. generate.ts always provides it in production. */
  probeProductImage?: ProbeProductImage
  /** Optional probe — true iff the first customer photo downloads cleanly.
   *  When omitted, that rule is skipped. */
  probeFirstCustomerPhoto?: (path: string) => Promise<boolean>
}

// ── Pure rule helpers ───────────────────────────────────────────────

const INDOOR_ONLY_HINTS = [
  'indoor',
  'lounge',
  'ceiling rose',
  'in-ceiling',
] as const

/** PURE — does the anchor line's description suggest an indoor-only product?
 *  Used by the weatherproof-indoor contradiction rule. Conservative: only
 *  flips on clear keywords so it never blocks a legitimate render. */
export function looksIndoorOnly(description: string | null): boolean {
  if (!description) return false
  const d = description.toLowerCase()
  return INDOOR_ONLY_HINTS.some((h) => d.includes(h))
}

/** PURE — fast structural checks against the context, no I/O. Returned
 *  reasons here are the bedrock failure classes the validator catches
 *  even without any probes. */
export function staticReasons(
  ctx: PromptContext,
  opts: { photoPaths: string[] },
): ValidationReason[] {
  const reasons: ValidationReason[] = []

  // Rule 1 — job_type is the trade-routing key for the whole prompt.
  const jobType = ctx.intake.job_type?.trim()
  if (!jobType) {
    reasons.push({
      code: 'no_job_type',
      detail:
        'Intake has no job_type — the renderer cannot pick a prompt or a product anchor without it.',
    })
  }

  // Rule 2 — effective count. effectiveItemCount() already applies the
  // SINGLE_ITEM_DEFAULT_COUNT table, so a null result means we have no
  // customer-stated count AND no sensible per-job-type default.
  if (effectiveItemCount(ctx) === null) {
    reasons.push({
      code: 'no_effective_count',
      detail: `No effective item count for job_type "${jobType ?? ''}" — capture a count during intake or add a SINGLE_ITEM_DEFAULT_COUNT for this job_type.`,
    })
  }

  // Rule 3 — anchor product is the brand/style/finish anchor for every
  // image in the quote. No anchor → Gemini falls back to a generic job
  // label, which is exactly the failure mode the engine is designed to
  // avoid.
  const anchorLine = pickAnchorLine(ctx)
  if (!anchorLine) {
    reasons.push({
      code: 'no_anchor_product',
      detail:
        'No headline material line on the selected tier — operator needs to add a non-sundries material to the quote or fix the tier line items.',
    })
  }

  // Rule 4 — replacement jobs need a source photo to edit (Stage 2
  // two-pass removal cannot run on empty photo_paths).
  if (isReplacementJob(ctx) && opts.photoPaths.length === 0) {
    reasons.push({
      code: 'replacement_without_source_photo',
      detail:
        'Replacement job (is_new_install=false) but no customer photo on the intake — ask the customer for a photo of the existing fitting before generating a preview.',
    })
  }

  // Rule 5 — weatherproof-indoor contradiction is a soft warning, not a
  // hard refusal. Gemini can still render a plausible image, but the
  // operator probably wants to fix the spec or the catalogue row.
  if (
    ctx.intake.scope?.specs?.weatherproof === true &&
    looksIndoorOnly(anchorLine?.description ?? null)
  ) {
    reasons.push({
      code: 'weatherproof_indoor_contradiction',
      detail: `Spec says weatherproof but anchor "${anchorLine?.description ?? ''}" looks indoor-only — check the catalogue row or the intake.`,
      fatal: false,
    })
  }

  return reasons
}

// ── Async wrapper: adds the probe-backed rules ──────────────────────

/**
 * Validate the context + storage state. Pure logic for the structural
 * rules, plus optional async probes for the photo reachability rules.
 *
 * Best-effort by design: any probe that throws is treated as "skip the
 * rule" rather than "block the render" — the validator never blocks on
 * its own infrastructure failures, only on confirmed bad inputs.
 */
export async function validateImageInputs(
  ctx: PromptContext,
  opts: ValidateOpts,
): Promise<ValidationResult> {
  const reasons = staticReasons(ctx, { photoPaths: opts.photoPaths })

  // Rule 6 — anchor photo is set but unreachable. Only run when we have
  // an anchor (no point probing if Rule 3 already failed) and a probe
  // was injected. When the catalogue path is set to a broken URL the
  // render silently degrades to a text-only run; this rule turns that
  // into a structured failure.
  const anchorImagePath = pickAnchorImagePath(ctx)
  if (anchorImagePath && opts.probeProductImage) {
    let ok = false
    try {
      ok = await opts.probeProductImage(anchorImagePath)
    } catch {
      ok = true // probe failure ≠ bad input — don't block
    }
    if (!ok) {
      reasons.push({
        code: 'anchor_photo_unreachable',
        detail: `Catalogue product photo for the anchor line is unreachable: "${anchorImagePath}". Fix the operator-catalogue image_path or clear it to fall back to text-only render.`,
      })
    }
  }

  // Rule 7 — customer photos listed but the first one won't download.
  // Same best-effort posture: probe failure does not block.
  if (opts.photoPaths.length > 0 && opts.probeFirstCustomerPhoto) {
    let ok = false
    try {
      ok = await opts.probeFirstCustomerPhoto(opts.photoPaths[0])
    } catch {
      ok = true
    }
    if (!ok) {
      reasons.push({
        code: 'photo_paths_present_but_first_unreadable',
        detail: `Customer photo "${opts.photoPaths[0]}" listed on the intake but cannot be downloaded from storage. Ask the customer to re-upload before generating a preview.`,
      })
    }
  }

  return partitionResult(reasons)
}

/** PURE — split reasons into fatal (→ ok:false) vs warnings (→ ok:true). */
export function partitionResult(
  reasons: ValidationReason[],
): ValidationResult {
  const fatal = reasons.filter((r) => r.fatal !== false)
  const warnings = reasons.filter((r) => r.fatal === false)
  if (fatal.length === 0) return { ok: true, warnings }
  return { ok: false, reasons: fatal }
}

/** PURE — single-line summary suitable for the `preview_error` column.
 *  Caps at 500 chars to match the column's existing slice contract. */
export function summariseReasons(reasons: ValidationReason[]): string {
  return reasons
    .map((r) => `[${r.code}] ${r.detail}`)
    .join(' | ')
    .slice(0, 500)
}
