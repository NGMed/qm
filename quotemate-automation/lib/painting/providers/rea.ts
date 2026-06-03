// ════════════════════════════════════════════════════════════════════
// Painting — realestate.com.au property-data provider.
//
// ⚠ HONEST PROVENANCE (verified 2026-06-03):
// realestate.com.au has NO official API that returns property attributes.
//   • The "Partner Platform" (partner.realestate.com.au) is push-only
//     listing syndication for agency software vendors — you upload
//     listings, you cannot look up a property's floor area. It also
//     requires being engaged by a paying REA agency, so a tradie SaaS
//     can't qualify.
//   • PropTrack (REA's data arm) is enterprise-only (banks/valuers) and
//     does NOT expose internal floor area anyway.
// The building size DOES live in the public listing page's embedded
// `window.ArgonautExchange` JSON (`propertySizes.building`), but that
// page is Akamai-walled and scraping it is against REA's ToS — so the
// only ways to power this provider are:
//   (a) a managed scraper (Apify / Zyte / Bright Data) — paid, ToS-grey
//   (b) the customer/tradie pasting the listing URL or the building size
//
// This adapter is built so EITHER can be injected later via `fetchListing`
// without touching the orchestrator or UI. With nothing configured it
// returns a clean `rea_not_configured` failure (the route then falls back
// to the demo/mock provider when the dashboard's demo toggle is on).
// ════════════════════════════════════════════════════════════════════

import type { PropertyDataProvider } from './base'
import type {
  PaintAddressInput,
  PropertyFacts,
  PropertyLookupResult,
} from '../types'

/**
 * The shape a scraper/paste backend must return — a thin projection of
 * the realestate.com.au listing's `propertySizes` + attributes. Building
 * size is the field that matters; everything else is enrichment.
 */
export type ReaListingData = {
  /** Internal building size in m² (propertySizes.building.displayValue). */
  building_m2: number | null
  land_m2: number | null
  bedrooms: number | null
  bathrooms: number | null
  storeys: number | null
  year_built: number | null
  property_type: string | null
  has_floor_plan: boolean
}

/**
 * Injected fetch — resolves an address to a realestate.com.au listing.
 * Supply a managed-scraper implementation, or a paste-backed one that
 * just returns what the user typed in. Returns null when there's no
 * listing for the address. May throw on transport errors.
 */
export type FetchReaListing = (
  input: PaintAddressInput,
) => Promise<ReaListingData | null>

export type ReaListingProviderOpts = {
  /** The scraper / paste backend. When omitted, the provider is inert. */
  fetchListing?: FetchReaListing
}

export class ReaListingProvider implements PropertyDataProvider {
  readonly name = 'rea' as const

  private readonly fetchListing?: FetchReaListing

  constructor(opts: ReaListingProviderOpts = {}) {
    this.fetchListing = opts.fetchListing
  }

  async lookup(input: PaintAddressInput): Promise<PropertyLookupResult> {
    if (!this.fetchListing) {
      return {
        ok: false,
        code: 'rea_not_configured',
        detail:
          'realestate.com.au has no usable lookup API. Wire a managed scraper (Apify/Zyte) or use the paste path to enable this tab. The demo toggle returns sample data in the meantime.',
      }
    }

    let listing: ReaListingData | null
    try {
      listing = await this.fetchListing(input)
    } catch (e) {
      return {
        ok: false,
        code: 'provider_unavailable',
        detail: e instanceof Error ? e.message : String(e),
      }
    }

    if (!listing) {
      return {
        ok: false,
        code: 'no_data_for_address',
        detail:
          'No realestate.com.au listing was found for this address. Most homes are not currently listed — use the Other tools tab or a site measure.',
      }
    }

    const facts: PropertyFacts = {
      floor_area_m2: listing.building_m2,
      floor_area_source: listing.building_m2 != null ? 'listing' : null,
      footprint_m2: null,
      storeys: listing.storeys,
      bedrooms: listing.bedrooms,
      bathrooms: listing.bathrooms,
      year_built: listing.year_built,
      property_type: listing.property_type,
      land_size_m2: listing.land_m2,
      has_floor_plan: listing.has_floor_plan,
      source: 'rea',
      capture_note:
        'From a realestate.com.au listing. Building size is a lower bound if the home was renovated after listing.',
    }

    return {
      ok: true,
      provider: 'rea',
      warnings:
        listing.building_m2 == null
          ? ['The listing did not publish a building size — floor area had to be inferred.']
          : [],
      facts,
    }
  }
}
