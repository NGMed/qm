'use client'

// /studio/[token]/upload — the franchisee-facing guided photo upload.
//
// No login: the tokenised link IS the capability. The studio takes the
// requested shots and submits; HQ's AI pre-checks them. Maintain design.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'

type Shot = { slot: string; label: string; instruction: string }

export default function StudioUploadPage() {
  const { token } = useParams<{ token: string }>()
  const router = useRouter()

  const [studioName, setStudioName] = useState<string>('')
  const [brand, setBrand] = useState<{ name: string; location_noun: string; hq_name: string } | null>(null)
  const [shots, setShots] = useState<Shot[]>([])
  const [files, setFiles] = useState<Record<string, File[]>>({})
  const [state, setState] = useState<'loading' | 'collect' | 'invalid' | 'done'>('loading')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/signage/request/${token}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return
        if (!json.ok) {
          setState('invalid')
          return
        }
        if (json.mode === 'report') {
          router.replace(`/studio/${token}/report`)
          return
        }
        setStudioName(json.studio_name)
        setBrand(json.brand ?? null)
        setShots(json.shots ?? [])
        setState('collect')
      })
      .catch(() => !cancelled && setState('invalid'))
    return () => {
      cancelled = true
    }
  }, [token, router])

  const onPick = useCallback((slot: string, list: FileList | null) => {
    setFiles((prev) => ({ ...prev, [slot]: list ? Array.from(list) : [] }))
  }, [])

  const totalFiles = useMemo(() => Object.values(files).reduce((n, f) => n + f.length, 0), [files])

  const submit = useCallback(async () => {
    setBusy(true)
    setErr(null)
    try {
      // Re-encode every photo through a canvas before upload. This is the
      // fix for the iOS Safari "The string did not match the expected
      // pattern." crash: appending a picked File straight into FormData can
      // throw inside WebKit, and full-size iPhone photos also blow past the
      // request-size limit. Canvas downscaling hands fetch a small, fresh,
      // in-memory JPEG Blob — which sidesteps both failure modes.
      const fd = new FormData()
      for (const [slot, list] of Object.entries(files)) {
        for (const f of list) {
          const prepared = await prepareImage(f)
          fd.append(slot, prepared.blob, prepared.filename)
        }
      }

      const res = await fetch(`/api/signage/request/${token}`, { method: 'POST', body: fd })
      let json: { ok?: boolean; error?: string } | null = null
      try {
        json = await res.json()
      } catch {
        json = null
      }
      if (!res.ok || !json?.ok) {
        setErr(humanError(json?.error ?? (res.status === 413 ? 'too_large' : 'unknown')))
        return
      }
      setState('done')
      setTimeout(() => router.push(`/studio/${token}/report`), 1200)
    } catch (e) {
      // Never surface a raw WebKit message (e.g. "The string did not match
      // the expected pattern.") to a franchisee — map it to plain guidance.
      console.error('signage submit failed', e)
      setErr('We couldn’t upload those photos. Please try again, or use smaller images.')
    } finally {
      setBusy(false)
    }
  }, [files, token, router])

  return (
    <main className="min-h-screen bg-ink-deep text-text-pri">
      <section className="mx-auto max-w-2xl px-6 pt-14 pb-10 sm:px-8">
        <a
          href="/dashboard/signage"
          className="mb-5 inline-flex items-center gap-2 font-mono text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-text-dim transition-colors hover:text-accent"
        >
          <span aria-hidden="true">&larr;</span> Back to signage
        </a>
        <div className="font-mono text-[0.78rem] font-semibold uppercase tracking-[0.18em] text-accent">
          {brand?.name ?? 'Brand'} compliance check
        </div>
        <h1 className="mt-3 font-extrabold uppercase leading-[0.95] tracking-[-0.03em] text-[clamp(2rem,7vw,3rem)]">
          {state === 'collect' ? studioName : 'Compliance check'}
        </h1>
        <p className="mt-4 text-base leading-relaxed text-text-sec">
          Take the photos below and submit. {brand?.hq_name ?? 'HQ'}&rsquo;s tool will pre-check them against the{' '}
          {brand?.name ?? 'brand'} standards and tell you what (if anything) needs fixing. This is a pre-check,
          not final {brand?.hq_name ?? 'HQ'} approval.
        </p>

        {state === 'loading' && <p className="mt-8 text-text-sec">Loading…</p>}
        {state === 'invalid' && (
          <div className="mt-8 border border-ink-line border-l-4 border-l-warning bg-ink-card p-6">
            <p className="text-text-sec">This link is invalid or has expired. Please contact {brand?.hq_name ?? 'HQ'} for a new one.</p>
          </div>
        )}
        {state === 'done' && (
          <div className="mt-8 border border-ink-line border-l-4 border-l-teal-glow bg-ink-card p-6">
            <p className="text-teal-glow">Submitted — preparing your report…</p>
          </div>
        )}

        {state === 'collect' && (
          <div className="mt-8 grid gap-5">
            {shots.map((s) => {
              const picked = files[s.slot]?.length ?? 0
              return (
                <div key={s.slot} className="border border-ink-line bg-ink-card p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-mono text-sm font-semibold uppercase tracking-[0.14em] text-accent">{s.label}</div>
                    {picked > 0 && <span className="font-mono text-[0.7rem] uppercase tracking-[0.12em] text-teal-glow">{picked} ✓</span>}
                  </div>
                  <p className="mt-2 text-sm text-text-sec">{s.instruction}</p>
                  {/* No `capture` attr: on mobile this lets the user EITHER
                      take a new photo OR pick one already in their gallery
                      (capture="environment" forced the live camera + blocked
                      the gallery, so phone-saved photos couldn't be chosen). */}
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    aria-label={`Upload photo for ${s.label}`}
                    onChange={(e) => onPick(s.slot, e.target.files)}
                    className="mt-3 block w-full text-sm text-text-sec file:mr-4 file:border-0 file:bg-accent file:px-4 file:py-2.5 file:font-mono file:text-xs file:font-semibold file:uppercase file:tracking-[0.12em] file:text-white"
                  />
                </div>
              )
            })}

            {err && <p className="text-warning">{err}</p>}

            <button
              type="button"
              onClick={submit}
              disabled={busy || totalFiles === 0}
              className="mt-2 inline-flex items-center justify-center gap-2 bg-accent px-6 py-4 font-mono text-sm font-semibold uppercase tracking-[0.14em] text-white transition-colors hover:bg-accent-press disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Submitting…' : <>Submit {totalFiles} photo{totalFiles === 1 ? '' : 's'} for review <span aria-hidden="true">&rarr;</span></>}
            </button>
          </div>
        )}
      </section>
    </main>
  )
}

function humanError(code: string): string {
  if (code?.endsWith('_over_5mb')) return 'One of your photos is over 5MB — please use a smaller image.'
  if (code?.endsWith('_bad_type')) return 'Only JPG, PNG or WebP images are accepted.'
  if (code === 'no_photos') return 'Add at least one photo before submitting.'
  if (code === 'too_large') return 'Those photos were too large to upload — try selecting fewer at once.'
  if (code === 'invalid_or_expired') return 'This link is invalid or has expired.'
  return 'Something went wrong — please try again.'
}

// Downscale + re-encode a picked photo to a small in-memory JPEG Blob.
// Falls back to re-buffering the original bytes if canvas decoding fails —
// that alone is enough to dodge the iOS Safari File-in-FormData bug that
// surfaces as "The string did not match the expected pattern.".
async function prepareImage(file: File): Promise<{ blob: Blob; filename: string }> {
  try {
    const blob = await downscaleToJpeg(file, 2000, 0.82)
    if (blob && blob.size > 0) {
      return { blob, filename: replaceExt(file.name || 'photo', 'jpg') }
    }
  } catch {
    // fall through to the raw re-buffer path
  }
  const buf = await file.arrayBuffer()
  return {
    blob: new Blob([buf], { type: file.type || 'image/jpeg' }),
    filename: file.name || 'photo.jpg',
  }
}

function downscaleToJpeg(file: File, maxDim: number, quality: number): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const w = img.naturalWidth
      const h = img.naturalHeight
      if (!w || !h) return resolve(null)
      const scale = Math.min(1, maxDim / Math.max(w, h))
      const cw = Math.max(1, Math.round(w * scale))
      const ch = Math.max(1, Math.round(h * scale))
      const canvas = document.createElement('canvas')
      canvas.width = cw
      canvas.height = ch
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve(null)
      ctx.drawImage(img, 0, 0, cw, ch)
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('image decode failed'))
    }
    img.src = url
  })
}

function replaceExt(name: string, ext: string): string {
  return name.replace(/\.[^.]+$/, '') + '.' + ext
}
