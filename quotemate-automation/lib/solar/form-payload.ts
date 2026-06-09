// Pure builder for the /solar/[tenantSlug] form → POST body. Keeps the
// client component dumb and the shape unit-testable. Matches
// SolarEstimateRequestSchema exactly: manual + panel_type are omitted
// when not applicable.

import type { SolarEstimateRequestBody } from './request-schema'

export function buildSolarFormPayload(state: {
  address: string
  postcode: string
  state: string
  manualOpen: boolean
  orientation: string
  roofSize: 'small' | 'medium' | 'large'
  storeys: 1 | 2 | 3
  panelType: 'standard_panels' | 'premium_panels' | 'unknown'
}): SolarEstimateRequestBody {
  const payload: SolarEstimateRequestBody = {
    address: {
      address: state.address.trim(),
      postcode: state.postcode.trim(),
      state: state.state as SolarEstimateRequestBody['address']['state'],
    },
  }
  if (state.manualOpen) {
    payload.manual = {
      orientation: state.orientation as NonNullable<SolarEstimateRequestBody['manual']>['orientation'],
      roof_size: state.roofSize,
      storeys: state.storeys,
    }
  }
  if (state.panelType !== 'unknown') {
    payload.panel_type = state.panelType
  }
  return payload
}
