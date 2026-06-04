---
active: true
iteration: 1
session_id: 4f8a2f3e-b0be-46b6-948a-f95bf0ab5a0e
max_iterations: 0
completion_promise: "All tests pass"
started_at: "2026-06-04T04:03:14Z"
---

Extend the signage compliance feature in quotemate-automation in priority order. Story 1 fix mobile photo capture on the franchisee upload page at app/studio/token/upload so phone camera and gallery uploads both work and actually submit, likely by relaxing the forcing capture attribute. Story 2 on app/dashboard/signage replace each sweep rows Copy Link control with a clickable Open button that opens the location upload page in a new browser tab, and add a Back button on the upload page that returns to the dashboard signage page. Story 3 replace demo studios with real-location sourcing via address autocomplete reusing the painting tools address component plus Google Places geocode, plus CSV bulk import of locations, and supplement the storefront shot with Google Street View Static. Do not use the Solar API. Story 4 expand the F45 brand shots beyond the current six based on docs/nov-global-signages.pdf such as external master logo, window wraps and racing stripe, main door decal, reception desk sign, Team Training decal, banners and A-frames, and add a brand shots editor in the dashboard. Keep shots as per-brand data, keep the flag-not-certify safety model, reuse the intake-photos bucket and the brand-driven engine, add migrations and env vars as needed. Run vitest and tsc after every change and finish only when all tests pass.
