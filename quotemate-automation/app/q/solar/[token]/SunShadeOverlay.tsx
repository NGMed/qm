'use client'

// Sun & shade overlay — the roof irradiance heatmap with one CLICKABLE,
// score-coloured dot per roof face (replaces the old overlapping text
// boxes). Tap a dot to reveal that face's sun score, area and how it
// compares to the best face; the best plane is a larger ringed dot with
// a star. A traffic-light legend (green → red) sits under the image.
//
// Positions are the same deterministic anchors the model already computes
// (panel centroid projected through the raster bbox) — never AI-placed.

import { useEffect, useState } from 'react'
import type { SolarSunMarker } from '@/lib/solar/sun-view'
import { SUN_SCORE_COPY, SUN_SCORE_MARKER_COLOR, SUN_SCORE_ORDER } from '@/lib/solar/sun-score'

type Props = {
  heatmapSrc: string
  alt: string
  markers: SolarSunMarker[]
  caption: string | null
}

export function SunShadeOverlay({ heatmapSrc, alt, markers, caption }: Props) {
  const [openIdx, setOpenIdx] = useState<number | null>(null)

  // Escape closes any open popover.
  useEffect(() => {
    if (openIdx === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenIdx(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openIdx])

  return (
    <div className="mt-5 border border-ink-line bg-ink-card">
      {/* Tapping the heatmap (anywhere but a dot) closes the popover. */}
      <div className="relative" onClick={() => setOpenIdx(null)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={heatmapSrc} alt={alt} className="block w-full" style={{ imageRendering: 'pixelated' }} />
        {markers.map((m, i) => (
          <Dot
            key={`${m.orientation}-${i}`}
            m={m}
            open={openIdx === i}
            onToggle={() => setOpenIdx((cur) => (cur === i ? null : i))}
          />
        ))}
      </div>

      {/* Traffic-light legend — always agrees with the dot colours. */}
      {markers.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-ink-line px-4 py-3">
          <span className="font-mono text-[0.6rem] font-semibold uppercase tracking-[0.14em] text-text-dim">
            Sun score
          </span>
          {SUN_SCORE_ORDER.map((label) => (
            <span key={label} className="inline-flex items-center gap-1.5">
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: SUN_SCORE_MARKER_COLOR[label] }}
                aria-hidden="true"
              />
              <span className="font-mono text-[0.62rem] text-text-sec">{SUN_SCORE_COPY[label]}</span>
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <span className="text-xs leading-none text-accent" aria-hidden="true">
              ★
            </span>
            <span className="font-mono text-[0.62rem] text-text-sec">Best spot</span>
          </span>
        </div>
      )}

      {caption && (
        <div className="border-t border-ink-line px-5 py-3 text-xs leading-relaxed text-text-dim">
          {markers.length > 0
            ? 'Tap a dot to see each roof face’s sun score — the starred dot is the best place for panels. '
            : ''}
          {caption}
        </div>
      )}
    </div>
  )
}

function Dot({ m, open, onToggle }: { m: SolarSunMarker; open: boolean; onToggle: () => void }) {
  const color = SUN_SCORE_MARKER_COLOR[m.score_label]
  // Keep the popover inside the image: drop below when the dot is near the
  // top, and align its edge when the dot is near a side.
  const placeBelow = m.y_pct < 26
  const halign: 'left' | 'center' | 'right' = m.x_pct < 18 ? 'left' : m.x_pct > 82 ? 'right' : 'center'

  return (
    <div
      className="absolute"
      style={{
        left: `${m.x_pct}%`,
        top: `${m.y_pct}%`,
        transform: 'translate(-50%, -50%)',
        zIndex: open ? 30 : m.is_best ? 20 : 10,
      }}
    >
      <div className="relative inline-flex">
        {m.is_best && (
          <span
            className="absolute inset-0 animate-ping rounded-full"
            style={{ backgroundColor: color, opacity: 0.5 }}
            aria-hidden="true"
          />
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          aria-expanded={open ? 'true' : 'false'}
          aria-label={`${m.is_best ? 'Best spot. ' : ''}${m.orientation} face — ${m.score_copy}, ${m.area_m2.toLocaleString('en-AU')} square metres, ${m.relative_pct}% of the best face`}
          className={`relative flex items-center justify-center rounded-full border-2 border-white transition-transform duration-150 hover:scale-125 focus-visible:scale-125 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
            m.is_best ? 'h-6 w-6' : 'h-4 w-4'
          } ${open ? 'scale-125' : ''}`}
          style={{ backgroundColor: color, boxShadow: '0 0 0 1px rgba(0,0,0,0.45), 0 1px 4px rgba(0,0,0,0.55)' }}
        >
          {m.is_best && <span className="text-[11px] font-bold leading-none text-white">★</span>}
        </button>
      </div>

      {open && <Popover m={m} color={color} placeBelow={placeBelow} halign={halign} />}
    </div>
  )
}

function Popover({
  m,
  color,
  placeBelow,
  halign,
}: {
  m: SolarSunMarker
  color: string
  placeBelow: boolean
  halign: 'left' | 'center' | 'right'
}) {
  const vpos = placeBelow ? 'top-full mt-2' : 'bottom-full mb-2'
  const hpos =
    halign === 'left' ? 'left-0' : halign === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2'

  return (
    <div
      role="dialog"
      aria-label={`${m.orientation} face sun score`}
      onClick={(e) => e.stopPropagation()}
      className={`absolute ${vpos} ${hpos} z-40 w-44 border bg-ink-deep/95 px-3 py-2.5 shadow-xl backdrop-blur-sm`}
      style={{ borderColor: color }}
    >
      <div className="flex items-center gap-1.5">
        {m.is_best && (
          <span className="text-xs leading-none text-accent" aria-hidden="true">
            ★
          </span>
        )}
        <span className="font-mono text-[0.66rem] font-bold uppercase tracking-[0.1em] text-text-pri">
          {m.is_best ? 'Best spot · ' : ''}
          {m.orientation} face
        </span>
      </div>

      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
        <span className="font-mono text-[0.62rem] uppercase tracking-[0.08em] text-text-sec">
          {m.score_copy}
        </span>
      </div>

      <dl className="mt-2 space-y-1 font-mono text-[0.6rem] text-text-dim">
        <div className="flex items-baseline justify-between gap-3">
          <dt>Roof area</dt>
          <dd className="tabular-nums text-text-sec">{m.area_m2.toLocaleString('en-AU')} m²</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt>Sun vs best</dt>
          <dd className="tabular-nums text-text-sec">{m.relative_pct}%</dd>
        </div>
      </dl>
    </div>
  )
}
