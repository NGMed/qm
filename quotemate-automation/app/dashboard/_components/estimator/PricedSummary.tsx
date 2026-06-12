'use client'

// The grounded BOM — every line traces to the tenant's catalogue + pricing
// book, and the per-line "how?" expands the full calculation chain. Nothing
// here is model-generated: unmatched items are flagged, never guessed.

import { Fragment, useId, useState } from 'react'
import { CATEGORIES } from '@/lib/estimate/categories'
import { money, type AddToCatalogueFn, type PricedBom } from './types'

type Props = {
  bom: PricedBom
  info: { catalogueSize: number; source: string } | null
  pricedAt?: string | null
  /** When supplied, each "not priced" item becomes an inline add-to-catalogue
   *  form (price + labour) that saves to the tenant's assemblies and re-prices.
   *  Absent → the items render as static chips (read-only contexts). */
  onAddToCatalogue?: AddToCatalogueFn
}

// Electrical + shared grounding categories for the optional add-form dropdown,
// derived from the single CATEGORIES source so labels never drift. Plumbing
// categories are omitted — the plan estimator is electrical-only.
const ELECTRICAL_CATEGORY_VALUES = new Set<string>([
  'downlight', 'gpo', 'smoke_alarm', 'fan', 'outdoor_light', 'rcbo', 'oven_cooktop',
  'ev_charger', 'switchboard', 'fault_find', 'strip_light', 'security_camera',
  'doorbell_intercom', 'sundry', 'general',
])
const CATEGORY_OPTIONS = CATEGORIES.filter((c) => ELECTRICAL_CATEGORY_VALUES.has(c.value))

export function PricedSummary({ bom, info, pricedAt, onAddToCatalogue }: Props) {
  const [openTrace, setOpenTrace] = useState<number | null>(null)
  const traceId = useId()

  return (
    <section aria-label="Indicative estimate" className="motion-safe:animate-[fade-up_220ms_ease-out_both]">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="font-mono text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-accent">
            Indicative estimate
          </div>
          <h3 className="mt-1.5 font-extrabold uppercase tracking-tight text-xl text-text-pri sm:text-2xl">
            Bill of materials &amp; labour
          </h3>
        </div>
        {pricedAt && (
          <span className="font-mono text-[0.66rem] uppercase tracking-[0.12em] text-text-dim">
            Priced {new Date(pricedAt).toLocaleString('en-AU')}
          </span>
        )}
      </div>

      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-text-sec">
        Priced from your electrical catalogue at {money(bom.assumptions.hourlyRate)}/hr labour and{' '}
        {bom.assumptions.markupPct}% material markup — deterministic maths, no AI in any dollar figure.
        Items not in your catalogue are flagged below and not priced. Open a line’s{' '}
        <span className="font-mono text-xs uppercase">how?</span> for the full calculation chain.
      </p>

      {bom.lines.length > 0 && (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-ink-line font-mono text-[0.62rem] uppercase tracking-[0.12em] text-text-dim">
                <th scope="col" className="py-2.5 pr-3 font-semibold">
                  Item → assembly
                </th>
                <th scope="col" className="py-2.5 px-3 text-right font-semibold">
                  Qty
                </th>
                <th scope="col" className="py-2.5 px-3 text-right font-semibold">
                  Unit
                </th>
                <th scope="col" className="py-2.5 px-3 text-right font-semibold">
                  Material
                </th>
                <th scope="col" className="py-2.5 px-3 text-right font-semibold">
                  Labour
                </th>
                <th scope="col" className="py-2.5 pl-3 text-right font-semibold">
                  Line
                </th>
              </tr>
            </thead>
            <tbody>
              {bom.lines.map((l, i) => (
                <Fragment key={i}>
                  <tr className="border-b border-ink-line/60">
                    <td className="py-2.5 pr-3 text-sm text-text-pri">
                      {l.type}
                      <span className="block font-mono text-xs text-text-dim">
                        → {l.matched}
                        <button
                          type="button"
                          onClick={() => setOpenTrace((s) => (s === i ? null : i))}
                          aria-expanded={openTrace === i ? 'true' : 'false'}
                          aria-controls={`${traceId}-trace-${i}`}
                          className={`ml-2 font-semibold uppercase tracking-widest transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
                            openTrace === i ? 'text-accent' : 'text-text-dim hover:text-accent'
                          }`}
                        >
                          how?
                        </button>
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-sm tabular-nums text-text-sec">{l.count}</td>
                    <td className="py-2.5 px-3 text-right font-mono text-sm tabular-nums text-text-sec">
                      {money(l.unitPriceExGst)}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-sm tabular-nums text-text-sec">
                      {money(l.materialExGst)}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-sm tabular-nums text-text-sec">
                      {money(l.labourExGst)}
                      <span className="block text-xs text-text-dim">{l.labourHours}h</span>
                    </td>
                    <td className="py-2.5 pl-3 text-right font-mono text-sm font-semibold tabular-nums text-text-pri">
                      {money(l.lineExGst)}
                    </td>
                  </tr>
                  {openTrace === i && (
                    <tr id={`${traceId}-trace-${i}`} className="border-b border-ink-line/60 bg-ink-deep">
                      <td colSpan={6} className="px-4 py-4">
                        <TraceGrid line={l} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {bom.unmatched.length > 0 && (
        <div className="mt-5 border border-ink-line border-l-4 border-l-warning bg-ink-deep px-4 py-3">
          <div className="font-mono text-[0.66rem] font-semibold uppercase tracking-[0.14em] text-warning">
            Not priced — not in your catalogue ({bom.unmatched.length})
          </div>
          {onAddToCatalogue ? (
            <>
              <ul className="mt-3 space-y-2">
                {bom.unmatched.map((u) => (
                  <UnmatchedItem key={u.type} item={u} onAdd={onAddToCatalogue} />
                ))}
              </ul>
              <p className="mt-3 text-xs text-text-dim">
                Add one with its price + labour and we’ll re-price instantly — it’s saved to your
                catalogue so the next plan prices it automatically. Unmatched items are never guessed.
              </p>
            </>
          ) : (
            <>
              <ul className="mt-2 flex flex-wrap gap-2">
                {bom.unmatched.map((u, i) => (
                  <li key={i} className="border border-warning/50 px-2 py-1 font-mono text-xs text-text-sec">
                    {u.count}× {u.type}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-text-dim">
                Add these under Services / Catalogue and re-price — unmatched items are never guessed.
              </p>
            </>
          )}
        </div>
      )}

      <div className="mt-6 flex justify-end border-t border-ink-line pt-5">
        <dl className="w-full max-w-sm space-y-2 font-mono text-sm">
          <SumRow label="Materials" value={money(bom.materialExGst)} />
          <SumRow label="Labour" value={money(bom.labourExGst)} />
          {bom.labourFloorAddedExGst > 0 && (
            <SumRow label={`Min-labour top-up (${bom.assumptions.minLabourHours}h floor)`} value={money(bom.labourFloorAddedExGst)} />
          )}
          <SumRow label="Subtotal (ex GST)" value={money(bom.subtotalExGst)} />
          {bom.gstRegistered && <SumRow label="GST 10%" value={money(bom.gstExGst)} />}
          <div className="flex items-baseline justify-between gap-6 border-t border-ink-line pt-3 text-text-pri">
            <dt className="font-semibold uppercase tracking-[0.12em]">Total inc GST</dt>
            <dd className="text-2xl font-bold tabular-nums text-accent">{money(bom.totalIncGst)}</dd>
          </div>
        </dl>
      </div>

      {info && (
        <p className="mt-3 text-right font-mono text-[0.66rem] text-text-dim">
          catalogue: {info.catalogueSize} assemblies · pricing book: {info.source}
        </p>
      )}
    </section>
  )
}

// One "not priced" item as an inline add-to-catalogue form. The item name and
// count come from the take-off; the tradie supplies the two columns the plan
// can't infer (unit price + labour/unit). Saving persists a custom assembly
// named exactly like the item — which the deterministic exact-name matcher then
// links on re-price (lib/estimation/price.ts) — and the parent re-prices.
function UnmatchedItem({
  item,
  onAdd,
}: {
  item: { type: string; count: number }
  onAdd: AddToCatalogueFn
}) {
  const [open, setOpen] = useState(false)
  const [price, setPrice] = useState('')
  const [labour, setLabour] = useState('')
  const [category, setCategory] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState(false)
  const fid = useId()

  const priceNum = Number(price)
  const labourNum = Number(labour)
  const priceValid = price.trim() !== '' && Number.isFinite(priceNum) && priceNum >= 0
  const labourValid = labour.trim() === '' || (Number.isFinite(labourNum) && labourNum >= 0)
  const canSubmit = priceValid && labourValid && !busy

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    const res = await onAdd(
      { type: item.type, count: item.count },
      { priceExGst: priceNum, labourHours: labour.trim() === '' ? 0 : labourNum, category: category || undefined },
    )
    setBusy(false)
    if (res.ok) {
      // On success the parent re-prices and this item leaves bom.unmatched, so
      // the row unmounts. The flag only shows if the row lingers (re-price hiccup).
      setAdded(true)
      setOpen(false)
    } else {
      setError(res.error ?? 'Could not add to catalogue.')
    }
  }

  return (
    <li className="border border-warning/40 bg-ink-card">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <span className="font-mono text-xs text-text-sec">
          {item.count}× {item.type}
        </span>
        {added ? (
          <span className="font-mono text-[0.64rem] font-semibold uppercase tracking-[0.12em] text-teal-glow">
            ✓ added
          </span>
        ) : (
          <button
            type="button"
            onClick={() => {
              setOpen((s) => !s)
              setError(null)
            }}
            aria-expanded={open ? 'true' : 'false'}
            aria-controls={`${fid}-form`}
            className="font-mono text-[0.64rem] font-semibold uppercase tracking-[0.12em] text-accent transition-colors hover:text-accent-press focus-visible:outline-2 focus-visible:outline-accent"
          >
            {open ? 'Cancel' : '+ Add to catalogue'}
          </button>
        )}
      </div>

      {open && !added && (
        <form id={`${fid}-form`} onSubmit={submit} className="border-t border-ink-line px-3 py-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="block font-mono text-[0.58rem] font-semibold uppercase tracking-[0.12em] text-text-dim">
                Unit price ex GST
              </span>
              <div className="mt-1 flex items-center border border-ink-line bg-ink-deep focus-within:border-accent">
                <span className="pl-2 font-mono text-xs text-text-dim">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  required
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0.00"
                  aria-label={`Unit price ex GST for ${item.type}`}
                  className="w-full bg-transparent px-2 py-1.5 font-mono text-sm tabular-nums text-text-pri outline-none"
                />
              </div>
            </label>
            <label className="block">
              <span className="block font-mono text-[0.58rem] font-semibold uppercase tracking-[0.12em] text-text-dim">
                Labour hrs / unit
              </span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.25"
                value={labour}
                onChange={(e) => setLabour(e.target.value)}
                placeholder="0"
                aria-label={`Labour hours per unit for ${item.type}`}
                className="mt-1 w-full border border-ink-line bg-ink-deep px-2 py-1.5 font-mono text-sm tabular-nums text-text-pri outline-none focus:border-accent"
              />
            </label>
            <label className="block">
              <span className="block font-mono text-[0.58rem] font-semibold uppercase tracking-[0.12em] text-text-dim">
                Category <span className="normal-case text-text-dim/70">(optional)</span>
              </span>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                aria-label={`Catalogue category for ${item.type}`}
                className="mt-1 w-full border border-ink-line bg-ink-deep px-2 py-1.5 font-mono text-sm text-text-pri outline-none focus:border-accent"
              >
                <option value="">Auto (from name)</option>
                {CATEGORY_OPTIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {error && (
            <p role="alert" className="mt-2 font-mono text-xs text-warning">
              {error}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex items-center gap-2 bg-accent px-4 py-2 font-mono text-[0.64rem] font-semibold uppercase tracking-[0.12em] text-white transition-colors hover:bg-accent-press focus-visible:outline-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save to catalogue & re-price'}
            </button>
            <span className="font-mono text-[0.58rem] text-text-dim">
              Re-prices now from your pricing book and remembers it for next time.
            </span>
          </div>
        </form>
      )}
    </li>
  )
}

function TraceGrid({ line }: { line: PricedBom['lines'][number] }) {
  return (
    <div className="grid gap-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
      <TraceStep n="1" title="Count from drawing">
        {line.trace.countSource.tally ?? 'No zone tally recorded for this line.'}
        {line.trace.countSource.confidence && (
          <span className="ml-1.5 font-mono uppercase text-text-dim">[{line.trace.countSource.confidence} confidence]</span>
        )}
      </TraceStep>
      <TraceStep n="2" title="Catalogue match">
        “{line.type}” → <span className="text-text-pri">{line.matched}</span>
        {line.trace.matchedSignals.length > 0 && (
          <span className="block font-mono text-text-dim">matched on: {line.trace.matchedSignals.join(', ')}</span>
        )}
      </TraceStep>
      <TraceStep n="3" title="Material">
        <span className="font-mono">{line.trace.materialFormula}</span>
        <span className="block font-mono text-text-dim">
          base {money(line.trace.baseUnitPriceExGst)}/unit ex GST + {line.trace.markupPct}% markup
        </span>
      </TraceStep>
      <TraceStep n="4" title="Labour">
        <span className="font-mono">{line.trace.labourFormula}</span>
        <span className="block font-mono text-text-dim">
          {line.trace.unitLabourHours}h/unit at {money(line.trace.hourlyRate)}/h — labour is not marked up
        </span>
      </TraceStep>
    </div>
  )
}

function TraceStep({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <div className="border-l-2 border-l-ink-line pl-3">
      <div className="font-mono font-semibold uppercase tracking-[0.12em] text-text-dim">
        <span className="text-accent">{n}</span> · {title}
      </div>
      <p className="mt-1 leading-relaxed text-text-sec">{children}</p>
    </div>
  )
}

function SumRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-6 text-text-sec">
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}
