// Shared "send a quote SMS, attach its PDF as a best-effort MMS" glue.
//
// Every trade's customer-quote send repeats the same tail:
//   1. a PDF was (maybe) rendered → a storage path, or null
//   2. the SMS body already carries the durable PDF download link
//   3. sign a SHORT-LIVED public URL for the Twilio MMS media fetch —
//      best-effort: a signing failure must NOT block the SMS
//   4. dispatch, letting dispatchQuoteMessage drop the media to a plain
//      SMS if the carrier rejects the MMS (AU long codes routinely do)
//
// Copy-pasting that tail across estimate/draft, approve, edit, roofing and
// the plan estimator is how solar silently shipped with NO MMS at all. This
// helper is the single chokepoint so a new trade inherits the behaviour by
// construction. The body link itself stays caller-built (it's woven into
// trade-specific copy) via the pure *PdfUrl() helpers.
//
// Bucket-agnostic: the caller injects the signer (signQuotePdfUrl for the
// quote-pdfs bucket, signPlanPdfUrl for plan-pdfs).

import { dispatchQuoteMessage, type DispatchResult } from './dispatch'

export async function dispatchQuoteWithPdf(opts: {
  to: string
  text: string
  /** SMS sender override (defaults handled by dispatchQuoteMessage). */
  from?: string
  /** Storage path of the rendered PDF, or null when none was produced
   *  (Gotenberg unconfigured, inspection-routed, render failed). */
  pdfPath: string | null
  /** Best-effort signer → short-lived public URL for the Twilio MMS fetch.
   *  Only called when pdfPath is non-null; a throw degrades to plain SMS. */
  signMediaUrl: (path: string) => Promise<string>
}): Promise<DispatchResult> {
  let mediaUrl: string | undefined
  if (opts.pdfPath) {
    try {
      mediaUrl = await opts.signMediaUrl(opts.pdfPath)
    } catch (e) {
      console.warn(
        '[send-quote-pdf] MMS media sign failed — sending plain SMS (body link still carries the PDF)',
        e instanceof Error ? e.message : e,
      )
      mediaUrl = undefined
    }
  }

  return dispatchQuoteMessage({
    to: opts.to,
    text: opts.text,
    from: opts.from,
    ...(mediaUrl ? { mediaUrl } : {}),
  })
}
