'use client'

// /dashboard/signage/studios — manage real locations (replaces demo seeds).
//   • Add a studio by address (Geoscape autocomplete, reused from roofing).
//   • Bulk-import a roster CSV.
//   • Each studio shows a Google Street View storefront preview.
// Maintain Technology design system.

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { getBrowserSupabase } from '@/lib/supabase/client'
import { AddressAutocomplete } from '@/app/dashboard/roofing/_components/AddressAutocomplete'

type Studio = {
  id: string
  name: string
  region: string | null
  status: string
  address: string | null
  state: string | null
  postcode: string | null
}

export default function SignageStudiosPage() {
  const [token, setToken] = useState<string | null>(null)
  const [authState, setAuthState] = useState<'loading' | 'signed-out' | 'ready'>('loading')
  const [studios, setStudios] = useState<Studio[]>([])

  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [stateCode, setStateCode] = useState<string | null>(null)
  const [postcode, setPostcode] = useState<string | null>(null)
  const [region, setRegion] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [importMsg, setImportMsg] = useState<string | null>(null)

  const load = useCallback(async (t: string) => {
    const res = await fetch('/api/signage/studios', { headers: { Authorization: `Bearer ${t}` }, cache: 'no-store' })
    if (res.status === 401) return setAuthState('signed-out')
    const json = await res.json()
    if (json.ok) {
      setStudios(json.studios ?? [])
      setAuthState('ready')
    }
  }, [])

  useEffect(() => {
    getBrowserSupabase()
      .auth.getSession()
      .then(({ data: { session } }) => {
        const t = session?.access_token ?? null
        setToken(t)
        if (!t) return setAuthState('signed-out')
        void load(t)
      })
  }, [load])

  const addStudio = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!token) return
      setBusy(true)
      setErr(null)
      try {
        const res = await fetch('/api/signage/studios', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            address: address.trim() || undefined,
            state: stateCode || undefined,
            postcode: postcode || undefined,
            region: region.trim() || undefined,
          }),
        })
        const json = await res.json()
        if (!json.ok) setErr(json.error)
        else {
          setName('')
          setAddress('')
          setStateCode(null)
          setPostcode(null)
          setRegion('')
          await load(token)
        }
      } finally {
        setBusy(false)
      }
    },
    [token, name, address, stateCode, postcode, region, load],
  )

  const importCsv = useCallback(
    async (file: File) => {
      if (!token) return
      setBusy(true)
      setImportMsg(null)
      try {
        const fd = new FormData()
        fd.append('csv', file)
        const res = await fetch('/api/signage/studios/import', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd })
        const json = await res.json()
        if (!json.ok) setImportMsg(`Import failed: ${(json.issues ?? [json.error]).join('; ')}`)
        else setImportMsg(`Imported ${json.created} studio(s); ${json.skipped_existing} already existed.`)
        await load(token)
      } finally {
        setBusy(false)
      }
    },
    [token, load],
  )

  return (
    <main className="min-h-screen bg-ink-deep text-text-pri">
      <section className="relative z-10 mx-auto max-w-5xl px-6 pt-14 pb-8 sm:px-10 md:pt-16">
        <Breadcrumb />
        <h1 className="mt-6 font-extrabold uppercase leading-[0.95] tracking-[-0.035em] text-[clamp(2rem,4.5vw,3.25rem)]">
          Manage <span className="text-accent">studios</span>
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-text-sec">
          Add your real locations (these replace the demo rows). Type an address or bulk-import a CSV.
          Each studio shows a Street View storefront so you can spot-check signage before requesting photos.
        </p>
      </section>

      {authState === 'signed-out' && (
        <section className="mx-auto max-w-5xl px-6 pb-20 sm:px-10"><p className="text-text-sec">Sign in to manage studios.</p></section>
      )}

      {authState === 'ready' && (
        <section className="relative z-10 mx-auto max-w-5xl px-6 pb-24 sm:px-10">
          {/* Add a studio */}
          <form onSubmit={addStudio} className="grid gap-5 border border-ink-line bg-ink-card p-7 sm:p-8 md:grid-cols-2">
            <div className="md:col-span-2">
              <Label>Studio name</Label>
              <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="F45 Bondi" className={INPUT} />
            </div>
            <div className="md:col-span-2">
              <Label>Address</Label>
              <AddressAutocomplete
                accessToken={token}
                value={address}
                onChange={setAddress}
                onSelect={(s) => {
                  setAddress(s.address)
                  setStateCode(s.state)
                  setPostcode(s.postcode)
                }}
              />
            </div>
            <div>
              <Label>Region (optional)</Label>
              <input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="AU-NSW" className={INPUT} />
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={busy || !name.trim()}
                className="bg-accent px-6 py-3 font-mono text-sm font-semibold uppercase tracking-[0.14em] text-white hover:bg-accent-press disabled:opacity-50"
              >
                {busy ? 'Adding…' : 'Add studio'}
              </button>
            </div>
            {err && <p className="md:col-span-2 text-warning">{err}</p>}
          </form>

          {/* CSV import */}
          <div className="mt-5 border border-ink-line bg-ink-card p-7 sm:p-8">
            <Label>Bulk import (CSV)</Label>
            <p className="mb-3 text-sm text-text-sec">Columns: name (required), address, region, state, postcode, contact_phone, contact_email.</p>
            <input
              type="file"
              accept=".csv,text/csv"
              aria-label="Studio roster CSV"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void importCsv(f) }}
              className="block w-full text-sm text-text-sec file:mr-4 file:border-0 file:bg-ink-line file:px-4 file:py-2.5 file:font-mono file:text-xs file:font-semibold file:uppercase file:tracking-[0.12em] file:text-text-pri"
            />
            {importMsg && <p className="mt-3 text-sm text-text-sec">{importMsg}</p>}
          </div>

          {/* List */}
          <h2 className="mt-10 font-mono text-[0.8rem] font-semibold uppercase tracking-[0.18em] text-accent">
            {studios.length} studio{studios.length === 1 ? '' : 's'}
          </h2>
          <div className="mt-4 grid gap-3">
            {studios.map((s) => (
              <div key={s.id} className="flex items-center gap-4 border border-ink-line bg-ink-card p-4">
                <StreetThumb token={token} studio={s} />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm text-text-pri">{s.name}</div>
                  <div className="font-mono text-[0.7rem] uppercase tracking-[0.12em] text-text-dim">
                    {[s.region, s.address].filter(Boolean).join(' · ') || 'No address'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  )
}

function StreetThumb({ token, studio }: { token: string | null; studio: Studio }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!token || !studio.address) return
    let revoke: string | null = null
    const q = new URLSearchParams({ address: studio.address, state: studio.state ?? '', postcode: studio.postcode ?? '' })
    fetch(`/api/signage/street-view?${q.toString()}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (!r.ok) return
        const blob = await r.blob()
        revoke = URL.createObjectURL(blob)
        setSrc(revoke)
      })
      .catch(() => {})
    return () => {
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [token, studio.address, studio.state, studio.postcode])

  return (
    <div className="h-14 w-20 shrink-0 overflow-hidden border border-ink-line bg-ink-deep">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={`${studio.name} storefront`} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center font-mono text-[0.55rem] uppercase tracking-[0.1em] text-text-dim">
          {studio.address ? '…' : 'no addr'}
        </div>
      )}
    </div>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 font-mono text-[0.78rem] font-semibold uppercase tracking-[0.16em] text-text-dim">{children}</div>
}
function Breadcrumb() {
  return (
    <div className="flex flex-wrap items-center gap-3 font-mono text-[0.78rem] font-semibold uppercase tracking-[0.18em] text-text-dim">
      <Link href="/dashboard" className="hover:text-text-pri">Dashboard</Link>
      <span className="text-ink-line">/</span>
      <Link href="/dashboard/signage" className="hover:text-text-pri">Signage</Link>
      <span className="text-ink-line">/</span>
      <span className="text-text-pri">Studios</span>
    </div>
  )
}
const INPUT = 'w-full border border-ink-line bg-ink-deep px-4 py-3 font-mono text-base text-text-pri placeholder:text-text-dim focus:border-accent focus:outline-none'
