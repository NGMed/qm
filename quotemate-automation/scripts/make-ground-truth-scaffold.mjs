// Turn an AI extraction into a fill-in-the-blanks ground-truth scaffold.
//
// Pre-fills the AI's own detected item types with BLANK counts/prices, so the
// estimator just types real numbers next to items they already recognise —
// instead of authoring a take-off file from scratch. Then:
//   node scripts/estimation-eval.mjs <extraction.json> <this scaffold.json>
//
// Usage:
//   node scripts/make-ground-truth-scaffold.mjs <extraction.json> <out.json> [manual_hours]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const [, , exPath, outPath, manualHoursArg] = process.argv
if (!exPath || !outPath) {
  console.error('Usage: node scripts/make-ground-truth-scaffold.mjs <extraction.json> <out.json> [manual_hours]')
  process.exit(1)
}

const ex = JSON.parse(readFileSync(exPath, 'utf8'))
const items = (ex.items ?? []).map((i) => ({
  type: i.type ?? i.name ?? '',
  symbol: i.symbol ?? '',
  count: null, // ← estimator fills this with the real take-off count
  unit_price: null, // ← optional: AUD ex-GST, for $ variance
}))

const out = {
  plan: ex.plan ?? 'plan',
  _instructions:
    'Fill each item\'s "count" with the estimator\'s real take-off (and "unit_price" in AUD ex-GST if you want $ variance). Rows are pre-filled with the AI\'s detected item types — correct any wording, delete items that do not exist, add ones it missed. Unfilled (null) counts are skipped by the eval, so a partial fill still scores.',
  _source: `Scaffold generated from ${exPath} — counts intentionally blank.`,
  manual_hours: manualHoursArg ? Number(manualHoursArg) : 40,
  items,
}

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(out, null, 2))
console.log(`wrote ${outPath} — ${items.length} item(s), all counts blank (awaiting the estimator).`)
