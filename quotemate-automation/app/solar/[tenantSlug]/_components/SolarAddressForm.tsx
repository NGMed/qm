'use client'

import { useState } from 'react'
import { buildSolarFormPayload } from '@/lib/solar/form-payload'

const STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'] as const
const ORIENTATIONS = [
  'north', 'north_east', 'east', 'south_east',
  'south', 'south_west', 'west', 'north_west', 'flat', 'unknown',
] as const

export function SolarAddressForm({ tenantSlug }: { tenantSlug: string }) {
  const [address, setAddress] = useState('')
  const [postcode, setPostcode] = useState('')
  const [stateCode, setStateCode] = useState<string>('NSW')
  const [manualOpen, setManualOpen] = useState(false)
  const [orientation, setOrientation] = useState<string>('north')
  const [roofSize, setRoofSize] = useState<'small' | 'medium' | 'large'>('medium')
  const [storeys, setStoreys] = useState<1 | 2 | 3>(1)
  const [panelType, setPanelType] =
    useState<'standard_panels' | 'premium_panels' | 'unknown'>('standard_panels')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const payload = buildSolarFormPayload({
        address, postcode, state: stateCode, manualOpen,
        orientation, roofSize, storeys, panelType,
      })
      const res = await fetch(`/api/solar/${tenantSlug}/estimate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json()
      if (!res.ok || !body.ok) {
        setError(body?.error === 'engine_failed'
          ? 'We could not generate an estimate just now. Please try again shortly.'
          : 'Please check your address and try again.')
        setBusy(false)
        return
      }
      window.location.href = body.shareUrl as string
    } catch {
      setError('Something went wrong. Please try again.')
      setBusy(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" data-testid="solar-address-form">
      <label className="flex flex-col gap-1 text-sm text-text-sec">
        Street address
        <input
          data-testid="solar-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          required
          minLength={3}
          placeholder="1 Example St, Suburb"
          className="border border-ink-line bg-ink-deep px-3 py-2 text-text-pri"
        />
      </label>
      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm text-text-sec">
          Postcode
          <input
            data-testid="solar-postcode"
            value={postcode}
            onChange={(e) => setPostcode(e.target.value)}
            required
            className="border border-ink-line bg-ink-deep px-3 py-2 text-text-pri"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-text-sec">
          State
          <select
            data-testid="solar-state"
            value={stateCode}
            onChange={(e) => setStateCode(e.target.value)}
            className="border border-ink-line bg-ink-deep px-3 py-2 text-text-pri"
          >
            {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm text-text-sec">
        Panel grade
        <select
          value={panelType}
          onChange={(e) => setPanelType(e.target.value as typeof panelType)}
          className="border border-ink-line bg-ink-deep px-3 py-2 text-text-pri"
        >
          <option value="standard_panels">Standard panels</option>
          <option value="premium_panels">Premium panels</option>
          <option value="unknown">Not sure</option>
        </select>
      </label>

      <button
        type="button"
        data-testid="solar-manual-toggle"
        onClick={() => setManualOpen((v) => !v)}
        className="self-start text-xs uppercase tracking-[0.14em] text-accent"
      >
        {manualOpen ? 'Hide manual roof details' : "Can't find your roof? Add details"}
      </button>

      {manualOpen && (
        <div className="flex flex-col gap-3 border-l-4 border-l-accent pl-4" data-testid="solar-manual-block">
          <label className="flex flex-col gap-1 text-sm text-text-sec">
            Main roof direction
            <select
              data-testid="solar-orientation"
              value={orientation}
              onChange={(e) => setOrientation(e.target.value)}
              className="border border-ink-line bg-ink-deep px-3 py-2 text-text-pri"
            >
              {ORIENTATIONS.map((o) => <option key={o} value={o}>{o.replace('_', ' ')}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm text-text-sec">
            Roof size
            <select
              value={roofSize}
              onChange={(e) => setRoofSize(e.target.value as typeof roofSize)}
              className="border border-ink-line bg-ink-deep px-3 py-2 text-text-pri"
            >
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm text-text-sec">
            Storeys
            <select
              value={storeys}
              onChange={(e) => setStoreys(Number(e.target.value) as 1 | 2 | 3)}
              className="border border-ink-line bg-ink-deep px-3 py-2 text-text-pri"
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>
        </div>
      )}

      {error && <p className="text-sm text-red-400" data-testid="solar-error">{error}</p>}

      <button
        type="submit"
        data-testid="solar-submit"
        disabled={busy}
        className="bg-accent px-5 py-3 font-mono text-sm font-bold uppercase tracking-[0.14em] text-ink-deep disabled:opacity-60"
      >
        {busy ? 'Estimating…' : 'Get my solar estimate'}
      </button>
    </form>
  )
}
