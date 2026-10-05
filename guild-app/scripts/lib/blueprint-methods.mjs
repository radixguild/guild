// blueprint-methods.mjs — scrape the escrow blueprint's public ABI from source.
//
// Why this exists. `docs/ESCROW-METHOD-INVENTORY.md` is a hand-maintained method
// catalog. Its own banner records the failure: "no regenerator exists in this
// repo, so it does NOT self-heal" — and four ABI changes duly landed without it
// moving. By 2026-08-09 its `Line` column was off by 120–940 lines and its
// params column described a signature nobody could call: `Bucket` where the code
// takes `Proof`, a `claim_task` arg that no longer exists, a `create_task` arg
// that was added later.
//
// Same thesis as P1-4 and the same fix. A fact that is copied by hand into a doc
// drifts; the answer is not to copy it more carefully but to stop copying it.
// The catalog's mechanical columns are derived here and byte-checked in CI, so
// the doc cannot silently disagree with `lib.rs` again. Prose and auth
// commentary stay human-owned, outside the generated block.

import { readFileSync } from 'node:fs'

/** The blueprint's public methods sit at exactly this indent inside `mod escrow`. */
const PUB_FN = /^ {8}pub fn ([a-z_0-9]+)\s*\(/

/**
 * Split a parameter list on top-level commas only.
 *
 * `Option<ResourceAddress>` and `(Decimal, Decimal)` both contain commas that are
 * NOT parameter separators. A naive `.split(',')` turns one param into two and
 * silently inflates the arity — the exact class of bug the instantiate gate was
 * written to catch, so it is not repeated here.
 */
export function splitTopLevel(s) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '<' || ch === '(' || ch === '[') depth++
    else if (ch === '>' || ch === ')' || ch === ']') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) out.push(cur)
  return out.map((x) => x.trim()).filter(Boolean)
}

/**
 * Read one method starting at `lines[i]`, which must match PUB_FN.
 *
 * Signatures span multiple lines (`instantiate` runs to eleven), so the header is
 * accumulated until parenthesis depth returns to zero. The return type is
 * whatever follows `->` before the opening brace; absent means unit.
 */
function readSignature(lines, i) {
  let depth = 0
  let header = ''
  let j = i
  for (; j < lines.length; j++) {
    for (const ch of lines[j]) {
      if (ch === '(') depth++
      else if (ch === ')') depth--
    }
    header += lines[j].trim() + ' '
    if (depth === 0 && header.includes('(')) break
  }

  // Find the paren that closes the ARGUMENT LIST, by depth.
  //
  // NOT `lastIndexOf(')')`: a tuple return like `-> (Global<Escrow>, Bucket, Bucket)`
  // ends in a paren too, so lastIndexOf swallows the whole return type into the
  // argument list — reporting `) -> (Global<Escrow>, Bucket, Bucket` as an eleventh
  // parameter and `()` as the return. Measured on `instantiate`, `resolve_dispute`
  // and every `get_*` returning a tuple.
  const open = header.indexOf('(')
  let close = -1
  {
    let depth = 0
    for (let k = open; k < header.length; k++) {
      if (header[k] === '(') depth++
      else if (header[k] === ')') {
        depth--
        if (depth === 0) {
          close = k
          break
        }
      }
    }
  }
  if (close === -1) throw new Error(`unbalanced parens in signature: ${header.slice(0, 120)}`)

  const tail = header.slice(close + 1)
  const arrow = tail.indexOf('->')
  let returns = '()'
  if (arrow !== -1) {
    returns = tail
      .slice(arrow + 2)
      .replace(/\{[\s\S]*$/, '')
      .trim()
  }

  const params = splitTopLevel(header.slice(open + 1, close))

  return { header, params, returns: returns || '()', endLine: j }
}

/**
 * Every public method of the blueprint, in source order.
 *
 * `line` is 1-indexed to match an editor and `file_path:line` links. `self` is
 * kept in `params` because dropping it would misrepresent `&self` (read-only)
 * versus `&mut self`, which is a real distinction for an auditor.
 */
export function scrapeMethods(libRsPath) {
  const src = readFileSync(libRsPath, 'utf8')
  const lines = src.split('\n')
  const methods = []

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PUB_FN)
    if (!m) continue
    const { params, returns, endLine } = readSignature(lines, i)
    methods.push({
      name: m[1],
      line: i + 1,
      params,
      returns,
      mutates: params.some((p) => p === '&mut self'),
      readOnly: params.some((p) => p === '&self'),
    })
    i = endLine
  }

  if (methods.length === 0) {
    throw new Error(
      `scrapeMethods found NO public methods in ${libRsPath}. That is not a valid ` +
        'blueprint — the indent pattern probably changed. Refusing to report an ' +
        'empty ABI, which would look like a passing check.'
    )
  }
  return methods
}

/** Render the machine-owned table. Kept deterministic — no dates, no ordering by anything but source position. */
export function renderTable(methods) {
  const rows = methods.map((m) => {
    const args = m.params.filter((p) => p !== '&self' && p !== '&mut self')
    const argText = args.length ? args.map((a) => `\`${a}\``).join(', ') : '—'
    const recv = m.mutates ? '`&mut self`' : m.readOnly ? '`&self`' : '—'
    return `| \`${m.name}\` | ${m.line} | ${recv} | ${argText} | \`${m.returns}\` |`
  })
  return [
    '| Method | Line | Receiver | Arguments | Returns |',
    '|---|---|---|---|---|',
    ...rows,
  ].join('\n')
}

/**
 * Variant names of a Rust `enum`, in DECLARATION ORDER.
 *
 * That order matters beyond readability: for a `#[derive(..., ManifestSbor,
 * ...)]` enum, SBOR encodes a variant by its POSITIONAL discriminant — variant
 * index `i` is `Enum<iu8>(...)` on the wire — never by name. A manifest
 * builder that hand-writes `Enum<0u8>()` for `PayWorker` is therefore pinned
 * to the enum's SOURCE ORDER, not to the name "PayWorker" appearing anywhere.
 * Reordering the variants in Rust (not just renaming one) silently changes
 * what every existing `Enum<Nu8>` literal means on-chain, and nothing in a
 * TypeScript-only test catches that — the TS side has no idea what index
 * `PayWorker` is "supposed" to be, only what `encodeRuling` hard-codes. This
 * scraper is what lets a test assert the two agree, by reading the ordering
 * fact from the one place it is actually decided: the blueprint source.
 *
 * Handles both unit variants (`PayWorker,`) and struct-shaped ones
 * (`Split { worker_pct: Decimal, poster_pct: Decimal },`) — only the variant
 * NAME is extracted; field lists are discarded. Comments inside the enum body
 * are stripped before splitting so a trailing `// ...` on a variant line
 * can't be mistaken for part of it.
 */
function splitTopLevelVariants(s) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) out.push(cur)
  return out.map((x) => x.trim()).filter(Boolean)
}

export function scrapeEnumVariants(source, enumName) {
  const re = new RegExp(`pub enum ${enumName}\\s*\\{`)
  const m = re.exec(source)
  if (!m) {
    throw new Error(`scrapeEnumVariants: enum "${enumName}" not found in source`)
  }
  let depth = 1
  let i = m.index + m[0].length
  let body = ''
  for (; i < source.length && depth > 0; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) break
    }
    body += ch
  }
  if (depth !== 0) {
    throw new Error(`scrapeEnumVariants: unbalanced braces reading enum "${enumName}"`)
  }
  const noComments = body.replace(/\/\/[^\n]*/g, '')
  // NOT splitTopLevel: that helper tracks `< ( [` but not `{ }`, because
  // method parameter lists (its only other caller) never contain a brace.
  // Enum variants do — `Split { worker_pct: Decimal, poster_pct: Decimal }` —
  // and a naive top-level split on that comma turns one variant into two
  // ("Split" and a bogus "poster_pct"). Local to this function so the shared
  // helper's contract for scrapeMethods stays exactly as it was.
  const parts = splitTopLevelVariants(noComments)
  const variants = parts.map((p) => {
    const nameMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(p.trim())
    if (!nameMatch) {
      throw new Error(`scrapeEnumVariants: could not parse a variant name from "${p.trim()}"`)
    }
    return nameMatch[1]
  })
  if (variants.length === 0) {
    throw new Error(`scrapeEnumVariants: enum "${enumName}" parsed with ZERO variants — refusing to report an empty enum, which would look like a passing check against nothing.`)
  }
  return variants
}

export const BEGIN = '<!-- BEGIN GENERATED METHOD TABLE — do not edit by hand -->'
export const END = '<!-- END GENERATED METHOD TABLE -->'

// P7-02 (task 90): a second generated block for the `NftSwap` blueprint,
// which lives in its own module (src/nft_swap.rs) in the SAME package. Same
// drift argument as the escrow's block — a hand-maintained catalog for a
// second blueprint would rot exactly the same way the first one did, just
// with no history to point at yet as a warning. Distinct markers so
// `spliceBlock` can target either block independently.
export const NFT_SWAP_BEGIN = '<!-- BEGIN GENERATED METHOD TABLE (NftSwap) — do not edit by hand -->'
export const NFT_SWAP_END = '<!-- END GENERATED METHOD TABLE (NftSwap) -->'

/**
 * Replace a generated block in `doc`, or throw if its markers are missing.
 *
 * `begin`/`end` default to the escrow's own markers so every existing call
 * site (which only ever handled one blueprint) keeps working unchanged;
 * pass `NFT_SWAP_BEGIN`/`NFT_SWAP_END` to target the second block instead.
 */
export function spliceBlock(doc, table, begin = BEGIN, end = END) {
  const b = doc.indexOf(begin)
  const e = doc.indexOf(end)
  if (b === -1 || e === -1 || e < b) {
    throw new Error(
      `The generated-block markers are missing or out of order.\n` +
        `Expected ${begin} … ${end}. Without them there is nothing to keep in sync.`
    )
  }
  const body = [
    begin,
    '',
    `<!-- Regenerated by gen-method-inventory.mjs --write (kept in the private operations repository); it renders this block through guild-app/scripts/lib/blueprint-methods.mjs -->`,
    `<!-- Verified in CI: guild-app/tests/unit/method-inventory-gate.test.ts on every PR, and the private composed check (gen-method-inventory.mjs --check) -->`,
    '',
    table,
    '',
    end,
  ].join('\n')
  return doc.slice(0, b) + body + doc.slice(e + end.length)
}

// ── The hand-maintained half of the inventory ────────────────────────────────
//
// The generated blocks above cannot rot. Everything BELOW them could, and did:
// on 2026-09-21 the hand-written "Method Catalog" still listed 21 of the
// blueprint's 39 methods, every Line was stale, and thirteen rows carried a
// signature or return type the code no longer has — including `submit_task →
// Bucket — claim bond returned`, which stopped being true at the Wave B cutover
// (it returns `()`; the bond stays in its vault until a settlement path credits
// it). The site was making the same claim. The doc's own banner called those tables
// "unverified, kept for auth commentary only" for six weeks, and a warning
// banner turned out to be no substitute for a check.
//
// Same fix as the generated block, applied to what CAN be checked by machine:
// the hand tables no longer restate any signature, and `checkHandTables` pins
// their COVERAGE (no row missing, no row for something that no longer exists),
// the access class, the return type each catalog row opens with, and the
// credential shape. It does NOT read prose — say so wherever this is cited.

/** Access class per method, from `enable_method_auth!`: 'OWNER' | 'PUBLIC'. */
export function scrapeMethodAuth(source) {
  const start = source.indexOf('enable_method_auth!')
  // The macro closes at the first `}` indented exactly four spaces; the inner
  // `methods { … }` block closes at eight and so cannot match.
  const end = start === -1 ? -1 : source.indexOf('\n    }', start)
  if (start === -1 || end === -1) {
    throw new Error('scrapeMethodAuth: no enable_method_auth! block found in source')
  }
  const auth = new Map()
  for (const raw of source.slice(start, end).split('\n')) {
    const line = raw.trim()
    if (line.startsWith('//')) continue
    const m = /^([a-z_0-9]+)\s*=>\s*(.+?);/.exec(line)
    if (!m) continue
    const rule = m[2].trim()
    if (rule === 'PUBLIC') auth.set(m[1], 'PUBLIC')
    else if (/^restrict_to:\s*\[OWNER\]$/.test(rule)) auth.set(m[1], 'OWNER')
    else {
      // A third role is a real change to the auth model. Refuse to file it
      // under one of the two this parser knows rather than guessing.
      throw new Error(`scrapeMethodAuth: unrecognised rule for ${m[1]}: "${rule}"`)
    }
  }
  if (auth.size === 0) {
    throw new Error(
      'scrapeMethodAuth parsed ZERO methods out of enable_method_auth! — the PARSER is ' +
        'broken, not the blueprint. Refusing to report an empty auth model.'
    )
  }
  return auth
}

/** Event names registered in the blueprint's `#[events(...)]` attribute, in source order. */
export function scrapeRegisteredEvents(source) {
  const m = /#\[events\(([\s\S]*?)\)\]/.exec(source)
  if (!m) throw new Error('scrapeRegisteredEvents: no #[events(...)] attribute found in source')
  const events = m[1]
    .replace(/\/\/[^\n]*/g, '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  if (events.length === 0) {
    throw new Error('scrapeRegisteredEvents parsed ZERO events — the PARSER is broken.')
  }
  return events
}

/** Top-level `pub enum` names, and `pub struct` names that are not events. */
export function scrapeTypeNames(source) {
  const enums = [...source.matchAll(/^pub enum ([A-Za-z0-9_]+)/gm)].map((m) => m[1])
  const structs = [...source.matchAll(/^pub struct ([A-Za-z0-9_]+)/gm)]
    .map((m) => m[1])
    .filter((n) => !n.endsWith('Event'))
  if (enums.length === 0 || structs.length === 0) {
    throw new Error('scrapeTypeNames found no enums or no structs — the PARSER is broken.')
  }
  return { enums, structs }
}

/** One section of the doc: from `heading` to the next heading of the same or a higher level. */
export function docSection(doc, heading) {
  const lines = doc.split('\n')
  const at = lines.findIndex((l) => l === heading || l.startsWith(heading + ' '))
  if (at === -1) throw new Error(`the inventory has no "${heading}" section — nothing to check`)
  const level = /^#+/.exec(heading)[0].length
  const out = []
  for (let i = at + 1; i < lines.length; i++) {
    const h = /^(#+) /.exec(lines[i])
    if (h && h[1].length <= level) break
    out.push(lines[i])
  }
  return out.join('\n')
}

/** Every markdown table in `section`, as `{ header, rows }` of trimmed cells. */
export function parseTables(section) {
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
  const tables = []
  let cur = null
  const lines = section.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim().startsWith('|')) {
      cur = null
      continue
    }
    if (/^\s*\|[\s:|-]+\|\s*$/.test(l)) continue // the |---|---| separator
    if (!cur) {
      cur = { header: cells(l), rows: [] }
      tables.push(cur)
    } else {
      cur.rows.push(cells(l))
    }
  }
  return tables
}

const untick = (s) => s.replace(/`/g, '').trim()

/** Problems with a name list: missing, unknown, duplicated. Both directions, always. */
function coverage(label, documented, actual, what) {
  const problems = []
  const seen = new Set()
  for (const n of documented) {
    if (seen.has(n)) problems.push(`${label}: \`${n}\` has more than one row`)
    seen.add(n)
    if (!actual.includes(n)) problems.push(`${label}: \`${n}\` is documented but is not ${what}`)
  }
  for (const n of actual) {
    if (!seen.has(n)) problems.push(`${label}: \`${n}\` is ${what} but has no row`)
  }
  return problems
}

// Columns that belong to the GENERATED block only. A hand table that grows one
// is a second copy of a mechanical fact, which is the rot this file exists to stop.
const MECHANICAL_COLUMNS = /^(line|params?|parameters|arguments|args|receiver|signature)$/i

/**
 * Check the hand-maintained sections of the inventory against the blueprint.
 * Returns a list of problems; empty means every checked property holds.
 *
 * `methods` is `scrapeMethods(lib.rs)`; `source` is lib.rs's text.
 */
export function checkHandTables(doc, source, methods) {
  const problems = []
  const auth = scrapeMethodAuth(source)
  const byName = new Map(methods.map((m) => [m.name, m]))
  const hasParam = (m, type) => m.params.some((p) => new RegExp(`:\\s*${type}\\b`).test(p))
  // A parse that finds almost nothing must be loud: an empty table "covers"
  // an empty list perfectly, and that green would be worth nothing.
  const floor = (label, n, min) => {
    if (n < min) {
      problems.push(
        `${label}: parsed only ${n} rows (expected at least ${min}) — the PARSER or the ` +
          "section's layout is broken, so nothing below it was really checked"
      )
    }
  }
  const sections = {}
  for (const [key, heading] of [
    ['auth', '### Auth Model'],
    ['catalog', '## Method Catalog'],
    ['events', '## Events Emitted'],
    ['enums', '## Enums'],
    ['structs', '## Key Data Structures'],
  ]) {
    sections[key] = docSection(doc, heading)
    if (/\(line \d+\)/i.test(sections[key])) {
      problems.push(
        `${heading}: cites source by LINE NUMBER — it rots on the next insertion above it. ` +
          'Name the symbol; the generated table carries the line.'
      )
    }
    for (const t of parseTables(sections[key])) {
      const bad = t.header.filter((h) => MECHANICAL_COLUMNS.test(untick(h)))
      if (bad.length) {
        problems.push(
          `${heading}: a hand-maintained table has a mechanical column (${bad.join(', ')}). ` +
            'Signatures and line numbers live ONLY in the generated block.'
        )
      }
    }
  }

  // ── Auth Model: coverage, access class, credential shape ──────────────────
  const authRows = parseTables(sections.auth).flatMap((t) => t.rows)
  floor('Auth Model', authRows.length, 20)
  problems.push(
    ...coverage('Auth Model', authRows.map((r) => untick(r[0])), [...auth.keys()], 'in enable_method_auth!')
  )
  for (const [rawName, rule = ''] of authRows) {
    const name = untick(rawName)
    const declared = auth.get(name)
    const m = byName.get(name)
    if (!declared || !m) continue
    if (!rule.startsWith(declared)) {
      problems.push(`Auth Model: \`${name}\` is ${declared} in enable_method_auth! but the row says "${rule}"`)
    }
    // The three rows found wrong on 2026-09-21 all said "bucket-burn" for a
    // method PULL had converted to take a Proof. The parameter types are the
    // mechanical half of that claim, so they are what gets compared.
    const proof = hasParam(m, 'Proof')
    if (proof && !/Proof/.test(rule)) {
      problems.push(`Auth Model: \`${name}\` takes a Proof but its row does not say so: "${rule}"`)
    }
    if (!proof && /Proof check/i.test(rule)) {
      problems.push(`Auth Model: \`${name}\` takes no Proof but its row claims a Proof check`)
    }
    if (/bucket-burn/i.test(rule) && (proof || !hasParam(m, 'Bucket'))) {
      problems.push(
        `Auth Model: \`${name}\` is described as bucket-burn auth, but its parameters are ` +
          `[${m.params.join(', ')}]`
      )
    }
  }

  // ── Method Catalog: coverage, and the return type each row opens with ─────
  const catalogRows = parseTables(sections.catalog).flatMap((t) => t.rows)
  floor('Method Catalog', catalogRows.length, 20)
  problems.push(
    ...coverage('Method Catalog', catalogRows.map((r) => untick(r[0])), methods.map((m) => m.name), 'a `pub fn` in lib.rs')
  )
  for (const [rawName, returns = ''] of catalogRows) {
    const m = byName.get(untick(rawName))
    if (!m) continue
    if (!returns.startsWith(`\`${m.returns}\``)) {
      problems.push(
        `Method Catalog: \`${m.name}\` returns \`${m.returns}\` in lib.rs, but its row opens ` +
          `"${returns.slice(0, 60)}". Re-read the whole row — a changed return type usually ` +
          'means the money moves differently.'
      )
    }
  }

  // ── Events: coverage, and every named emitter must still exist ────────────
  const eventRows = parseTables(sections.events).flatMap((t) => t.rows)
  floor('Events Emitted', eventRows.length, 10)
  problems.push(
    ...coverage('Events Emitted', eventRows.map((r) => untick(r[0])), scrapeRegisteredEvents(source), 'registered in #[events(...)]')
  )
  for (const [rawEvent, emitters = ''] of eventRows) {
    for (const [, fn] of emitters.matchAll(/`([a-z_0-9]+)`/g)) {
      if (!byName.has(fn)) {
        problems.push(`Events Emitted: ${untick(rawEvent)} names \`${fn}\` as an emitter — no such \`pub fn\``)
      }
    }
  }

  // ── Enums (variant ORDER is an on-chain encoding) and structs ─────────────
  const { enums, structs } = scrapeTypeNames(source)
  const enumLines = [...sections.enums.matchAll(/^- `([A-Za-z0-9_]+)`: (.+)$/gm)]
  floor('Enums', enumLines.length, 3)
  problems.push(...coverage('Enums', enumLines.map((m) => m[1]), enums, 'a `pub enum` in lib.rs'))
  for (const [, name, list] of enumLines) {
    if (!enums.includes(name)) continue
    const documented = splitTopLevelVariants(list).map((v) => /^[A-Za-z0-9_]+/.exec(v)?.[0] ?? v)
    const actual = scrapeEnumVariants(source, name)
    if (documented.join(',') !== actual.join(',')) {
      problems.push(`Enums: \`${name}\` is [${actual.join(', ')}] in lib.rs, in that order; the doc says [${documented.join(', ')}]`)
    }
  }
  const structNames = [...sections.structs.matchAll(/^- `([A-Za-z0-9_]+)`/gm)].map((m) => m[1])
  floor('Key Data Structures', structNames.length, 3)
  problems.push(...coverage('Key Data Structures', structNames, structs, 'a non-event `pub struct` in lib.rs'))

  return problems
}
