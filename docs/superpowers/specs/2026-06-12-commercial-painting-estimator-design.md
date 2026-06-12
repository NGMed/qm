# Commercial Painting Estimator — design spec

**Date:** 2026-06-12
**Status:** Approved design, pending implementation plan
**Pilot job:** IGA Swan Street, 480 Swan St, Richmond VIC 3121 (Sarris Architecture set AS73, rev CP1)

---

## 1. What we're building

A tradie-facing dashboard tool — its own **"Commercial Painting" tab** — that turns uploaded
construction documents into a confirmed painting takeoff and a single tender-style priced quote,
showing labour (hours / crew / days), materials (litres / products / $), and equipment, plus a
Gemini "after repaint" preview generated from a real site photo.

Pipeline: **upload → classify → AI takeoff (+ reconciliation) → confirm → price → quote + preview**.

### What this is NOT

- Not the existing **residential** painting tool (`lib/painting/`, `/dashboard/painting`) — that
  flow prices from *address-derived property facts* ($/m² × floor area → G/B/B tiers). This tool
  prices from *uploaded plan documents* (surface-by-surface takeoff → tender price). They coexist;
  this spec does not modify the residential flow.
- Not a customer-facing portal (possible later; nothing in this design precludes it).
- Not a full strategy-v9 `trades` registry build. Commercial painting lands as an **estimator
  extension** (the same way the electrical Estimator Beta did). A `docs/strategy.md` iteration
  entry must record this before code lands.

## 2. Decisions (settled in brainstorming, 2026-06-12)

| Decision | Choice |
|---|---|
| Audience | Tradie-facing dashboard tool |
| Navigation | Own **Commercial Painting** tab (shared engine underneath, per Approach A) |
| Architecture | Extend Estimator-Beta plumbing (`plan_uploads`/`plan_extractions` + `trade` column); new pure painting pricer; do NOT fork the workspace |
| Quote shape | Single tender price + optional "separate price" line items (no G/B/B) |
| Takeoff scope | Full AI takeoff from plans; reconciliation pass when a measurements doc is uploaded |
| Rates | Seed researched AU commercial defaults in a `paint_rates` table, flagged tunable per-tenant, pending painter validation |
| Models | Anthropic (Sonnet 4.6 classification, Opus 4.8 extraction); **Gemini repaint preview IS in v1** via the existing `lib/ig-engine` provider |
| Pricing discipline | Pure TypeScript, no LLM in the money path, unmatched lines returned unpriced — identical discipline to `lib/estimation/price.ts` |

## 3. Inputs

One required document type; everything else optional. Uploads are auto-classified and the user
can correct the classification.

| `doc_type` | Required | Example (pilot) | Used for |
|---|---|---|---|
| `plan_set` | **Yes** | `AS73 IGA Swan Street [CP1].pdf` (15 pp: floor plans, finishes schedule w/ Dulux specs, RCP, internal elevations) | Primary takeoff source |
| `measurement_takeoff` | No | `IGA Swan Street painting areas measurments.pdf` (34 line items, m²) | Reconciliation ground-truth |
| `services_layout` | No | `ESS26073_M200_P1_DUCTWORK LAYOUT.pdf` | Exposed-ceiling spray scope, masking/access context |
| `site_photo` | No | `IGA 2.pdf` (image-only) | Gemini repaint preview source |
| `other` | No | anything else | Extra analysis context only |

Limits: PDF or image, ≤ 32 MB/file (Anthropic PDF ceiling), multiple files per run.

## 4. Architecture

### 4.1 Shared plumbing (Approach A)

- `plan_uploads` and `plan_extractions` gain a `trade` column (`'electrical'` default,
  `'commercial_painting'` for this tool) and `plan_uploads` gains `doc_type`.
- A new `painting_run_id` grouping is needed because this tool takes **multiple files per run**
  (electrical is one PDF = one extraction). Model: a `paint_runs` table owning N `plan_uploads`
  and one current `plan_extractions` row.
- UI components shared from the estimator where the shape fits (editable-rows table pattern,
  history list, status polling); painting-specific columns and summary panels are new components
  under `app/dashboard/commercial-painting/_components/`.

### 4.2 New modules

```
lib/commercial-painting/
  classify.ts        — doc_type classification (Sonnet 4.6: first-page image + filename)
  extract.ts         — buildPaintTakeoffPrompt() + parse (Opus 4.8, PDF file parts)
  reconcile.ts       — PURE: AI takeoff × parsed measurements doc → per-line source/delta flags
  price.ts           — PURE: confirmed takeoff × paint_rates → PricedPaintBom
  rates.ts           — paint_rates row types + tenant-overlay resolution
app/api/tenant/commercial-painting/
  upload/route.ts    — multi-file upload + classification
  extract/route.ts   — run takeoff (+ reconciliation if measurements doc present)
  price/route.ts     — price confirmed items
  preview/route.ts   — Gemini repaint preview from site_photo
app/dashboard/commercial-painting/
  page.tsx           — the tab (upload zone → takeoff editor → priced summary)
```

### 4.3 Takeoff item shape

Stored in `plan_extractions.items` / `corrected_items` jsonb (superset of the electrical shape —
existing rows remain valid):

```ts
type PaintTakeoffItem = {
  surface: string            // "Retail concrete ceiling (thermal panels)"
  room: string               // "Retail" | "BOH" | "Kitchen" | …
  substrate: string          // "concrete" | "plasterboard" | "suspension tile" | "timber" | …
  system: 'spray_matt' | 'flat' | 'low_sheen' | 'semi_gloss'
  unit: 'm2' | 'item'        // doors/frames are per-item
  quantity: number           // m² or count
  coats: number              // default 2
  height_m?: number          // drives access multiplier + equipment trigger
  confidence: 'high' | 'medium' | 'low'
  source: 'plan' | 'measurements' | 'both' | 'manual'
  delta_pct?: number         // when source='both' and the two disagree
  separate_price?: boolean   // "separate price for fridge window wall" pattern
  note?: string              // provenance: plan page / measurements line no.
}
```

### 4.4 Reconciliation rules (pure, unit-tested)

- Match AI lines to measurements-doc lines by normalised surface/room text + nearest area.
- `source: 'both'` when matched; record `delta_pct`. Deltas > 10% are flagged in the UI.
- Measurements-only lines come in as `source: 'measurements'`, confidence high.
- Plan-only lines stay `source: 'plan'` — flagged so the tradie checks whether the painter's
  takeoff genuinely excluded them.
- Nothing is silently dropped or silently preferred; the tradie resolves flags in the editor.

## 5. Pricing model

### 5.1 `paint_rates` reference table (migration-seeded)

Trade-scoped rows, tenant-overridable via the established overlay pattern. Seed values are
**researched AU commercial defaults, marked `is_default = true`**, to be tuned with a real
painter before production quoting. Two row kinds:

**Labour coverage** (`kind='labour'`): per `system × method`, m²/hr per painter — e.g.
spray ceiling ~25 m²/hr effective (incl. masking), roller walls ~10 m²/hr/coat, cut-in/trim
lower; doors priced per-unit hours.

**Materials** (`kind='material'`): per product — spread rate (m²/L/coat, typically 14–16),
$/L ex-GST, default product per system (ceiling flat, low-sheen acrylic, semi-gloss premium
for wet areas, sealer/undercoat).

**Modifiers** (columns or a `modifiers` jsonb on the pricing book overlay):

- height multiplier: ≤ 3.4 m × 1.0; 3.4–5 m × 1.25; > 5 m × 1.4 (the IGA job is 5.2 m)
- prep allowance % (default 10%), sundries % on materials (default 8%)
- equipment day-rates: scissor lift, scaffold — auto-added as line items when any priced
  surface has `height_m > 3.4`
- crew assumptions: hours/day (7.6), default crew size for days calculation

### 5.2 Math (pure functions in `price.ts`)

```
labour_hours(line)   = quantity ÷ coverage_rate(system, method) × coats
                       × height_multiplier(height_m) × (1 + prep_pct)
material_litres(line)= quantity × coats ÷ spread_rate(product)
material_$           = litres (rounded up to whole L) × $/L × (1 + sundries_pct)
equipment            = day_rate × ceil(total_days on triggered surfaces)
totals               = labour$ + material$ + equipment$ → ex-GST subtotal → GST → inc-GST
```

Every priced line carries a trace (formula strings + matched rate row), mirroring
`PriceTrace` in the electrical pricer. `separate_price` lines total independently and render
as optional add-ons on the quote. Lines whose system/product matches no rate row are returned
**unpriced** in an `unmatched` list — never guessed.

### 5.3 Output: `PricedPaintBom`

Labour (hours, suggested crew, estimated days, $), materials (per-product litres + $),
equipment lines, optional separate-price section, assumptions list (rates source, prep %,
height multipliers applied), exclusions list (tiled surfaces, colours TBC by client, surfaces
marked excluded in the editor), ex-GST / GST / inc-GST totals.

## 6. Repaint preview (Gemini, v1)

Adapt the residential repaint pattern (`lib/painting/repaint-prompt.ts` + `lib/ig-engine`
Gemini provider) for commercial interiors/exteriors: source image = the uploaded `site_photo`
(e.g. `IGA 2.pdf` page rendered to PNG), prompt constrained to "repaint only the painted
surfaces in <scheme>; structure, fixtures, signage, framing pixel-faithful". One preview per
run, refine-able with a free-text instruction (same pattern as residential). Failure is
non-blocking — the quote works without a preview.

## 7. Database changes (migration 107 + `scripts/run-migration-107.mjs`)

1. `create table paint_runs` (id, tenant_id, status, created_at; RLS enabled, service-role
   grants — mirrors 099)
2. `alter table plan_uploads add column trade text not null default 'electrical'`,
   `add column doc_type text`, `add column paint_run_id uuid references paint_runs(id)`
   (nullable — electrical uploads never set it)
3. `alter table plan_extractions add column trade text not null default 'electrical'`
4. `create table paint_rates` (id, trade, tenant_id nullable for shared defaults, kind,
   system, method, product, coverage_m2_per_hr, spread_m2_per_l, price_per_l_ex_gst,
   unit_hours, is_default, …) + seed rows
5. Update `sql/init.sql` to stay representative.

## 8. Error handling

- Classification uncertain → default `other`, user corrects in UI.
- Extraction failure / unreadable PDF → run status `failed` with the model's note; user can retry.
- Low-confidence takeoff (> 50% of area in `low` lines) → banner recommending site measure
  before quoting (the commercial analogue of the inspection fallback; no $99 route here —
  commercial jobs always get human review via the confirm step).
- Gemini preview failure → quote unaffected; preview slot shows retry.
- Webhook-style long work: extraction runs via the existing fast-ack + `after()` pattern with
  status polling (Opus over a 15-page PDF will exceed interactive timeouts).

## 9. Testing & acceptance

**Unit (vitest):** `reconcile.ts` (matching, deltas, no-silent-drop), `price.ts` (coverage math,
height multipliers, rounding-up litres, equipment triggers, separate-price totals, GST),
`extract.ts` parse/normalise, classification fallback.

**Acceptance (the pilot documents, run end-to-end):**

1. Upload all four IGA files → classified correctly (plan_set / measurement_takeoff /
   services_layout / site_photo).
2. AI takeoff substantially reproduces the painter's 34-line manual takeoff (~1,100 m² total;
   retail ceiling ≈ 420 m² found; kitchen/bathroom lines carry `semi_gloss`).
3. Reconciliation flags only genuine deltas; measurements-only lines (e.g. "Qty one timber
   door") appear with high confidence.
4. Priced quote shows non-zero labour hours + days, per-product litres, and a lift-hire
   equipment line (5.2 m walls trigger it).
5. Gemini preview renders from `IGA 2.pdf` without altering building structure.

## 10. Phases (for the implementation plan)

0. `docs/strategy.md` iteration entry + run `strategy-reviewer`
1. Migration 107 + seed `paint_rates` + types
2. Upload & classification (API + tab skeleton)
3. Extraction + reconciliation (pure cores first, TDD)
4. Confirmation editor UI
5. Pricer + priced summary + quote output
6. Gemini repaint preview
7. End-to-end acceptance against the IGA documents + build report

## 11. Open items (not blockers)

- Real painter rates to replace seeded defaults (tracked by `is_default = true`).
- Quote PDF: reuse `lib/quote/pdf.ts` pattern — exact layout TBD in the plan.
- Naming: dashboard tab label "Commercial Painting" (residential tool keeps "Painting").
- v1.1 candidates: customer-facing upload portal, AI-only takeoff confidence tuning, duct/
  services painting as a scoped option, multi-colour scheme previews.
