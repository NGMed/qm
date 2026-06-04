// ════════════════════════════════════════════════════════════════════
// Signage — parse an HQ location roster CSV into studio rows.
//
// PURE. Self-contained RFC4180-ish parser (handles quoted fields,
// commas-in-quotes, escaped quotes, CRLF). Flexible header aliases so HQ's
// own export columns map without renaming. name is required; the rest are
// optional and null when blank.
// ════════════════════════════════════════════════════════════════════

export type StudioInput = {
  name: string
  address: string | null
  region: string | null
  state: string | null
  postcode: string | null
  contact_phone: string | null
  contact_email: string | null
}

/** Split CSV text into rows of fields, honouring quotes. */
function splitCsv(text: string): string[][] {
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"') inQuotes = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  // drop fully-blank rows
  return rows.filter((r) => r.some((f) => f.trim() !== ''))
}

const ALIASES = {
  name: ['name', 'studio', 'studio_name', 'location', 'location_name'],
  address: ['address', 'street', 'street_address', 'full_address'],
  region: ['region', 'area', 'market'],
  state: ['state', 'province'],
  postcode: ['postcode', 'post_code', 'zip', 'zip_code', 'postal_code'],
  contact_phone: ['contact_phone', 'phone', 'mobile', 'tel'],
  contact_email: ['contact_email', 'email', 'e-mail'],
}

export function parseStudiosCsv(text: string): { studios: StudioInput[]; errors: string[] } {
  const errors: string[] = []
  const rows = splitCsv(text ?? '')
  if (rows.length === 0) return { studios: [], errors: ['The file is empty.'] }

  const header = rows[0].map((h) => h.trim().toLowerCase())
  const colOf = (names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(n)
      if (i >= 0) return i
    }
    return -1
  }
  const cols = {
    name: colOf(ALIASES.name),
    address: colOf(ALIASES.address),
    region: colOf(ALIASES.region),
    state: colOf(ALIASES.state),
    postcode: colOf(ALIASES.postcode),
    contact_phone: colOf(ALIASES.contact_phone),
    contact_email: colOf(ALIASES.contact_email),
  }
  if (cols.name < 0) {
    return { studios: [], errors: ['CSV needs a "name" column (header row).'] }
  }

  const studios: StudioInput[] = []
  const seen = new Set<string>()
  const blank = (v: string) => (v.trim() === '' ? null : v.trim())
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]
    const get = (i: number) => (i >= 0 && i < cells.length ? cells[i] : '')
    const name = get(cols.name).trim()
    if (!name) {
      errors.push(`Row ${r + 1}: missing name — skipped.`)
      continue
    }
    const key = name.toLowerCase()
    if (seen.has(key)) {
      errors.push(`Row ${r + 1}: duplicate "${name}" — skipped.`)
      continue
    }
    seen.add(key)
    studios.push({
      name,
      address: blank(get(cols.address)),
      region: blank(get(cols.region)),
      state: blank(get(cols.state)),
      postcode: blank(get(cols.postcode)),
      contact_phone: blank(get(cols.contact_phone)),
      contact_email: blank(get(cols.contact_email)),
    })
  }
  return { studios, errors }
}
