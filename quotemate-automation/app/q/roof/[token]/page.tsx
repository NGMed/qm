// Customer-facing public roofing quote page.
// Reached via the SMS/MMS link "Full breakdown + your roof image: {url}".
// Token-gated against roofing_measurements.public_token (unguessable);
// the service-role client is used because this is a public sharing
// surface — only the columns rendered below are exposed.
//
// Maintain Technology brand: dark navy, vibrant orange, all-caps display.

import { createClient } from '@supabase/supabase-js'
import { notFound } from 'next/navigation'
import type { MultiRoofQuote, RoofStructurePrice } from '@/lib/roofing/types'

export const dynamic = 'force-dynamic'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

type Row = {
  address: string | null
  state: string | null
  provider: string | null
  routing: string | null
  combined_area_m2: number | null
  combined_better_inc_gst: number | null
  quote: MultiRoofQuote | null
  public_token: string
}

function fmtAud(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  return '$' + Math.round(n).toLocaleString('en-AU')
}

export default async function RoofingQuotePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  if (!token || token.length < 8) notFound()

  const { data, error } = await supabase
    .from('roofing_measurements')
    .select('address, state, provider, routing, combined_area_m2, combined_better_inc_gst, quote, public_token')
    .eq('public_token', token)
    .maybeSingle()

  if (error || !data) notFound()
  const row = data as Row
  const quote = row.quote
  const structures: RoofStructurePrice[] = Array.isArray(quote?.structures) ? quote!.structures : []
  const isInspection = row.routing === 'inspection_required' || quote?.routing?.decision === 'inspection_required'
  const mapSrc = `/api/roofing/q/${row.public_token}/static-map`

  return (
    <main className="min-h-screen bg-ink-deep text-text-pri">
      <section className="mx-auto max-w-3xl px-6 pt-14 pb-10 sm:px-10">
        <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.18em] text-accent">
          QuoteMate · Roofing
        </div>
        <h1 className="mt-3 font-extrabold uppercase leading-[0.95] tracking-[-0.035em] text-[clamp(2rem,5vw,3.5rem)]">
          Your roof <span className="text-accent">quote</span>
        </h1>
        {row.address && (
          <p className="mt-4 text-lg text-text-sec">{row.address}</p>
        )}

        {/* Roof + Google Maps location */}
        <div className="mt-8 overflow-hidden border border-ink-line bg-ink-card">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={mapSrc}
            alt={`Satellite view of the roof at ${row.address ?? 'the property'}`}
            className="h-72 w-full object-cover sm:h-96"
          />
          <div className="px-5 py-3 font-mono text-xs uppercase tracking-[0.16em] text-text-dim">
            Geoscape measurement on the Google Maps location
          </div>
        </div>

        {isInspection ? (
          <div className="mt-8 border border-ink-line border-l-4 border-l-warning bg-ink-card px-6 py-5">
            <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-warning">
              On-site inspection needed
            </div>
            <p className="mt-2 text-base text-text-sec">
              {quote?.routing?.reason ??
                'This roof needs a quick on-site inspection before we can give an accurate price.'}
            </p>
          </div>
        ) : (
          <>
            {/* Combined total */}
            <div className="mt-8 border border-ink-line border-l-4 border-l-accent bg-ink-card p-6 sm:p-8">
              <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-accent">
                Estimate · {structures.length} structure{structures.length === 1 ? '' : 's'}
                {row.combined_area_m2 ? ` · ${Math.round(row.combined_area_m2)} m²` : ''}
              </div>
              <div className="mt-5 grid gap-5 sm:grid-cols-3">
                {(quote?.combined?.tiers ?? []).map((t, i) => (
                  <div key={i} className="border border-ink-line bg-ink-deep p-5">
                    <div className="font-mono text-[0.72rem] font-semibold uppercase tracking-[0.16em] text-text-dim">
                      {['Patch / repair', 'Re-roof', 'Upgrade'][i] ?? t.tier}
                    </div>
                    <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-accent sm:text-3xl">
                      {fmtAud(t.inc_gst)}
                    </div>
                    <div className="mt-1 font-mono text-[0.7rem] uppercase tracking-[0.14em] text-text-dim">
                      inc GST
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Per-structure breakdown */}
            {structures.length > 1 && (
              <div className="mt-8">
                <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-text-dim">
                  Per-structure breakdown
                </div>
                <div className="mt-4 grid gap-4">
                  {structures.map((s, i) => (
                    <div key={s.buildingId ?? i} className="border border-ink-line bg-ink-card p-5">
                      <div className="flex flex-wrap items-baseline justify-between gap-3">
                        <span className="font-extrabold uppercase tracking-[-0.02em] text-lg text-text-pri">
                          {s.label}
                        </span>
                        <span className="font-mono text-sm text-text-dim">
                          {s.metrics?.sloped_area_m2 != null ? `${Math.round(s.metrics.sloped_area_m2)} m²` : ''}
                        </span>
                      </div>
                      <div className="mt-3 grid grid-cols-3 gap-3">
                        {s.price?.tiers?.map((t, ti) => (
                          <div key={ti} className="font-mono text-sm">
                            <div className="text-[0.68rem] uppercase tracking-[0.14em] text-text-dim">{t.tier}</div>
                            <div className="mt-1 font-bold tabular-nums text-text-pri">{fmtAud(t.inc_gst)}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        <p className="mt-8 text-sm text-text-dim">
          Prices include GST and are indicative from a satellite measurement. A
          licensed roofer reviews every quote before any work is booked.
        </p>
      </section>

      <div className="bg-accent px-6 py-5 text-center text-white">
        <span className="font-mono text-sm font-semibold uppercase tracking-[0.16em]">
          QuoteMate · Roofing
        </span>
      </div>
    </main>
  )
}
