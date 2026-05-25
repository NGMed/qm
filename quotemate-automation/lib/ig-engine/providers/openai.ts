// ════════════════════════════════════════════════════════════════════
// IG Engine — OpenAI provider adapter (Phase 2).
//
// Calls openai/gpt-image-2 through the Vercel AI Gateway using the
// AI SDK's experimental_generateImage. Routes via the gateway's
// unified API + AI_GATEWAY_API_KEY — NOT a raw OpenAI key.
//
// CAPABILITY NOTE — what this MVP does NOT do:
//   · sourceImage (edit-with-reference) is NOT supported through
//     experimental_generateImage. Edit jobs throw with a clear "route
//     to Gemini" message so the router (Phase 3) can fall back.
//   · reference image (product photo attachment) is the same story.
//   · generateText (the judge path) is intentionally absent — the
//     judge uses Claude or Gemini, not gpt-image-2.
//
// Tomorrow's enhancement (out of Phase 2 scope): route OpenAI edits
// through `generateText` + `tools.imageGeneration` on a multimodal LLM
// model (e.g. openai/gpt-5.1-instant), which DOES accept image inputs.
// That path is more involved and not needed for Phase 3 routing to land.
//
// The AI SDK is DYNAMICALLY imported so the pure logic in this file
// stays import-light for the unit tests (same pattern as judge.ts).
// Best-effort surface: throws on failure; the verify-loop catches it.
// ════════════════════════════════════════════════════════════════════

import type {
  ImageBytes,
  ImageProvider,
  ProviderCapabilities,
  RenderImageRequest,
} from './base'

const DEFAULT_IMAGE_MODEL =
  process.env.OPENAI_IMAGE_MODEL ?? 'openai/gpt-image-2'

const CAPABILITIES: ProviderCapabilities = {
  // experimental_generateImage is text-to-image only on gpt-image-2 today.
  // Set these honestly so the router (Phase 3) avoids edit jobs.
  edit: false,
  textToImage: true,
  vision: false,
}

function requireGatewayKey(): string {
  const key = process.env.AI_GATEWAY_API_KEY
  if (!key) throw new Error('AI_GATEWAY_API_KEY not set')
  return key
}

/**
 * PURE — combine system + user (+ optional extraStrict) into the single
 * prompt string `experimental_generateImage` accepts. Separators help
 * gpt-image-2 distinguish authoritative rules from the brief.
 */
export function buildOpenAIPrompt(req: RenderImageRequest): string {
  const parts: string[] = [req.system, '---', req.user]
  if (req.extraStrict) parts.push('---', req.extraStrict)
  return parts.join('\n\n')
}

async function renderImage(req: RenderImageRequest): Promise<ImageBytes> {
  // Fail fast on missing env so the router falls back cleanly.
  requireGatewayKey()

  if (req.sourceImage) {
    throw new Error(
      'OpenAI provider does not support edit-with-reference yet — route this job to Gemini',
    )
  }
  if (req.reference) {
    throw new Error(
      'OpenAI provider does not support image-input via experimental_generateImage yet — route to Gemini for product-reference renders',
    )
  }

  const model = req.model ?? DEFAULT_IMAGE_MODEL
  const prompt = buildOpenAIPrompt(req)

  // Dynamic import — keeps test imports light (mirrors judge.ts +
  // lib/sms/intent.ts). The AI SDK reads AI_GATEWAY_API_KEY from env
  // automatically when the model id is prefixed (e.g. 'openai/...').
  const { experimental_generateImage: generateImage } = await import('ai')

  const out = await generateImage({
    model,
    prompt,
    // Cast: our aspectRatio strings come from image-config.ts'
    // SUPPORTED_ASPECT_RATIOS, which all match `${number}:${number}`,
    // but the AI SDK demands the template-literal type explicitly.
    ...(req.aspectRatio
      ? { aspectRatio: req.aspectRatio as `${number}:${number}` }
      : {}),
  })

  const img = out.images?.[0]
  if (!img?.base64) {
    throw new Error('OpenAI gateway returned no image data')
  }
  return {
    base64: img.base64,
    mime: img.mediaType ?? 'image/png',
  }
}

export const openaiProvider: ImageProvider = {
  name: 'openai',
  capabilities: CAPABILITIES,
  renderImage,
}
