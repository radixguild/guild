#!/usr/bin/env node
// verify-package-parity.mjs — check that the code a Radix package RUNS is the code this repository
// says it runs. Keyless, read-only, no dependencies beyond Node 20+.
//
//   node scripts/verify-package-parity.mjs                                  # every package in the manifest, against the chain
//   node scripts/verify-package-parity.mjs --package <package_rdx1…>        # one package from the manifest
//   node scripts/verify-package-parity.mjs --package <package_rdx1…> --wasm out/escrow-wave-b.wasm
//                                                                           # …and also compare a wasm you built yourself
//   node scripts/verify-package-parity.mjs --package <package_rdx1…> --gateway-response codes.json
//                                                                           # offline: use a saved Gateway response
//   … --expected <file>   (default verify/deployed-packages.json)   --gateway <url>   --json
//
// Exit 0 = every checked package MATCHES. 1 = at least one MISMATCH. 2 = usage, file or network
// error. 3 = the package has no entry in the expected-hash file.
//
// WHAT IT DOES
// ------------
// Reads the package's deployed code from a Radix Gateway (`POST /state/package/page/codes`), which
// returns the code bytes themselves (`code_hex`), not only a hash. It recomputes the Gateway's
// `code_hash_hex` (BLAKE2b-256 of those bytes) and stops if the two disagree. It then compares the
// SHA-256 of the deployed bytes with the expected SHA-256 recorded in the expected-hash file, and,
// with `--wasm`, with the SHA-256 of a local build. `sha256sum` on the built .wasm prints the same
// SHA-256, so a rebuild can be checked by hand too.
//
// WHAT A MATCH PROVES (and does not)
// ----------------------------------
// Chain bytes == recorded hash proves the chain runs the bytes this repository records. Built bytes ==
// chain bytes proves those bytes come from the source and recipe that produced the build (see
// docs/AUDITOR-GUIDE.md §5 and verify/rebuild-package.sh). A match says nothing about whether the
// source is correct; that is what audits and tests are for.
//
// Ported from the maintainer's private operations repository. Removed in the port: the private asset
// registry it read its expectations from, the deploy-gate wiring, and the history notes about
// packages that are no longer live. The hashing, the Gateway self-check and the exit codes are kept.

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

export const DEFAULT_GATEWAY = 'https://mainnet.radixdlt.com'
const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_EXPECTED = resolve(HERE, '..', 'verify', 'deployed-packages.json')

export const EXIT = { MATCH: 0, MISMATCH: 1, ERROR: 2, NO_EXPECTATION: 3 }

const PACKAGE_RE = /^package_rdx1[0-9a-z]{6,}$/
const HEX64_RE = /^[0-9a-f]{64}$/

export class UsageError extends Error {}

export function parseArgs(argv, env = {}) {
  const out = { json: false, gateway: env.RADIX_GATEWAY_URL || DEFAULT_GATEWAY, expected: DEFAULT_EXPECTED }
  const value = (i, flag) => {
    const v = argv[i]
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--package') out.package = value(++i, a)
    else if (a === '--wasm') out.wasm = value(++i, a)
    else if (a === '--expected') out.expected = value(++i, a)
    else if (a === '--gateway') out.gateway = value(++i, a)
    else if (a === '--gateway-response') out.gatewayResponse = value(++i, a)
    else if (a === '-h' || a === '--help') throw new UsageError('help')
    else throw new UsageError(`unknown argument ${a}`)
  }
  if (out.package && !PACKAGE_RE.test(out.package)) throw new UsageError(`not a mainnet package address: ${out.package}`)
  if ((out.wasm || out.gatewayResponse) && !out.package) throw new UsageError('--wasm and --gateway-response need --package')
  return out
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// Radix's code hash is BLAKE2b with a 32-byte digest. Node's OpenSSL offers BLAKE2b only at 64 bytes
// (`blake2b512`), and a 32-byte BLAKE2b is a different parameterisation, not a truncation, so it is
// implemented here (RFC 7693, unkeyed). BigInt arithmetic; fast enough for packages of ~500 KB.
export function blake2b256(input) {
  const IV = [
    0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
    0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
  ]
  const SIGMA = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  ]
  const M64 = (1n << 64n) - 1n
  const rotr = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M64
  const outlen = 32
  const h = IV.slice()
  h[0] ^= 0x01010000n ^ BigInt(outlen) // parameter block: digest length, no key, fanout 1, depth 1
  const data = Buffer.from(input)
  const blocks = Math.max(1, Math.ceil(data.length / 128))
  let t = 0n
  for (let b = 0; b < blocks; b++) {
    const chunk = Buffer.alloc(128)
    data.copy(chunk, 0, b * 128, Math.min(data.length, (b + 1) * 128))
    const last = b === blocks - 1
    t += BigInt(last ? data.length - b * 128 : 128)
    const m = []
    for (let i = 0; i < 16; i++) m.push(chunk.readBigUInt64LE(i * 8))
    const v = h.concat(IV)
    v[12] ^= t & M64
    v[13] ^= (t >> 64n) & M64
    if (last) v[14] ^= M64
    const G = (a, bI, c, d, x, y) => {
      v[a] = (v[a] + v[bI] + x) & M64; v[d] = rotr(v[d] ^ v[a], 32)
      v[c] = (v[c] + v[d]) & M64; v[bI] = rotr(v[bI] ^ v[c], 24)
      v[a] = (v[a] + v[bI] + y) & M64; v[d] = rotr(v[d] ^ v[a], 16)
      v[c] = (v[c] + v[d]) & M64; v[bI] = rotr(v[bI] ^ v[c], 63)
    }
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r]
      G(0, 4, 8, 12, m[s[0]], m[s[1]]); G(1, 5, 9, 13, m[s[2]], m[s[3]])
      G(2, 6, 10, 14, m[s[4]], m[s[5]]); G(3, 7, 11, 15, m[s[6]], m[s[7]])
      G(0, 5, 10, 15, m[s[8]], m[s[9]]); G(1, 6, 11, 12, m[s[10]], m[s[11]])
      G(2, 7, 8, 13, m[s[12]], m[s[13]]); G(3, 4, 9, 14, m[s[14]], m[s[15]])
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8]
  }
  const out = Buffer.alloc(64)
  for (let i = 0; i < 8; i++) out.writeBigUInt64LE(h[i], i * 8)
  return out.subarray(0, outlen).toString('hex')
}

/** Validate the expected-hash file and return its packages. Throws on any malformed entry. */
export function parseExpected(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.packages)) {
    throw new Error('expected-hash file: no "packages" array')
  }
  const seen = new Set()
  return json.packages.map((p, i) => {
    const where = `expected-hash file: packages[${i}]`
    if (!p || typeof p !== 'object') throw new Error(`${where} is not an object`)
    if (typeof p.id !== 'string' || !p.id) throw new Error(`${where}: missing id`)
    if (!PACKAGE_RE.test(p.address || '')) throw new Error(`${where} (${p.id}): not a mainnet package address`)
    if (seen.has(p.address)) throw new Error(`${where} (${p.id}): address listed twice`)
    seen.add(p.address)
    const sha = String(p.wasm_sha256 || '').toLowerCase()
    if (!HEX64_RE.test(sha)) throw new Error(`${where} (${p.id}): wasm_sha256 must be 64 hex chars`)
    const b2 = p.code_hash_blake2b256 == null ? null : String(p.code_hash_blake2b256).toLowerCase()
    if (b2 !== null && !HEX64_RE.test(b2)) throw new Error(`${where} (${p.id}): code_hash_blake2b256 must be 64 hex chars`)
    return { ...p, wasm_sha256: sha, code_hash_blake2b256: b2 }
  })
}

/**
 * Check a Gateway `/state/package/page/codes` response and hash its single code entry.
 * Throws if there is not exactly one entry or if the Gateway's own hash disagrees with its bytes.
 */
export function codeFromGatewayResponse(body, address) {
  if (!body || !Array.isArray(body.items) || body.items.length === 0) throw new Error(`no code entries returned for ${address}`)
  if (body.items.length !== 1) throw new Error(`${address} has ${body.items.length} code entries; this script handles one`)
  const it = body.items[0]
  if (typeof it.code_hex !== 'string' || !/^([0-9a-fA-F]{2})+$/.test(it.code_hex)) throw new Error(`${address}: code_hex missing or not hex`)
  const bytes = Buffer.from(it.code_hex, 'hex')
  const b2 = blake2b256(bytes)
  if (b2 !== String(it.code_hash_hex || '').toLowerCase()) {
    throw new Error(`Gateway self-inconsistency for ${address}: code_hash_hex ${it.code_hash_hex} != blake2b-256(code_hex) ${b2}`)
  }
  return {
    state_version: body.ledger_state?.state_version ?? null,
    vm_type: it.vm_type ?? null,
    bytes: bytes.length,
    code_hash_blake2b256: b2,
    wasm_sha256: sha256(bytes),
  }
}

/**
 * Compare the chain's code with the expectation (and a local build, if given).
 * MATCH only when every hash present agrees; anything else is MISMATCH with the reasons listed.
 */
export function compare(chain, expected, built = null) {
  if (!expected) return { verdict: 'NO_EXPECTATION', reasons: ['no entry in the expected-hash file'] }
  const reasons = []
  if (chain.wasm_sha256 !== expected.wasm_sha256) reasons.push(`chain sha256 ${chain.wasm_sha256} != expected ${expected.wasm_sha256}`)
  if (expected.code_hash_blake2b256 && chain.code_hash_blake2b256 !== expected.code_hash_blake2b256) {
    reasons.push(`chain blake2b-256 ${chain.code_hash_blake2b256} != expected ${expected.code_hash_blake2b256}`)
  }
  if (built && built.wasm_sha256 !== chain.wasm_sha256) {
    reasons.push(`built sha256 ${built.wasm_sha256} (${built.bytes} bytes) != chain ${chain.wasm_sha256} (${chain.bytes} bytes)`)
  }
  return { verdict: reasons.length ? 'MISMATCH' : 'MATCH', reasons }
}

export function exitCode(results) {
  if (results.some((r) => r.verdict === 'MISMATCH')) return EXIT.MISMATCH
  if (results.some((r) => r.verdict === 'NO_EXPECTATION')) return EXIT.NO_EXPECTATION
  return EXIT.MATCH
}

async function fetchCodes(gateway, address) {
  const res = await fetch(`${gateway.replace(/\/+$/, '')}/state/package/page/codes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ package_address: address }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`/state/package/page/codes -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

export function render(results, source) {
  const lines = [`\n-- package parity   [${source}]`]
  for (const r of results) {
    const tag = r.verdict === 'MATCH' ? 'MATCH' : r.verdict === 'MISMATCH' ? 'MISMATCH' : 'NO EXPECTATION'
    lines.push(`\n  ${tag}  ${r.package}${r.id ? `  (${r.id})` : ''}`)
    lines.push(`    chain    ${r.chain.vm_type ?? '?'} · ${r.chain.bytes} bytes · state_version ${r.chain.state_version ?? '?'}`)
    lines.push(`    sha256   ${r.chain.wasm_sha256}   (deployed bytes)`)
    lines.push(`    blake2b  ${r.chain.code_hash_blake2b256}   (= Gateway code_hash_hex, recomputed)`)
    if (r.expected_sha256) lines.push(`    expect   ${r.expected_sha256}   (expected-hash file)`)
    if (r.built) lines.push(`    built    ${r.built.wasm_sha256}   (${r.built.file}, ${r.built.bytes} bytes)`)
    for (const why of r.reasons) if (r.verdict !== 'MATCH') lines.push(`    why      ${why}`)
  }
  return lines.join('\n') + '\n'
}

export async function run(argv, env = process.env) {
  const args = parseArgs(argv, env)
  const expected = parseExpected(JSON.parse(readFileSync(args.expected, 'utf8')))
  const targets = args.package
    ? [{ address: args.package, entry: expected.find((e) => e.address === args.package) || null }]
    : expected.map((e) => ({ address: e.address, entry: e }))
  if (targets.length === 0) throw new UsageError(`${args.expected} lists no packages`)

  const results = []
  for (const t of targets) {
    const body = args.gatewayResponse ? JSON.parse(readFileSync(args.gatewayResponse, 'utf8')) : await fetchCodes(args.gateway, t.address)
    const chain = codeFromGatewayResponse(body, t.address)
    let built = null
    if (args.wasm) {
      const bytes = readFileSync(args.wasm)
      built = { file: args.wasm, bytes: bytes.length, wasm_sha256: sha256(bytes) }
    }
    const { verdict, reasons } = compare(chain, t.entry, built)
    results.push({ package: t.address, id: t.entry?.id ?? null, expected_sha256: t.entry?.wasm_sha256 ?? null, chain, built, verdict, reasons })
  }
  const source = args.gatewayResponse ? `saved response ${args.gatewayResponse}` : args.gateway
  return { results, output: args.json ? JSON.stringify({ source, results }, null, 2) + '\n' : render(results, source), code: exitCode(results) }
}

const USAGE = 'usage: node scripts/verify-package-parity.mjs [--package <package_rdx1…>] [--wasm <file>] [--gateway-response <file>] [--expected <file>] [--gateway <url>] [--json]'

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).then(
    ({ output, code }) => { process.stdout.write(output); process.exit(code) },
    (err) => {
      if (err instanceof UsageError) console.error(err.message === 'help' ? USAGE : `\n  ${err.message}\n\n  ${USAGE}\n`)
      else console.error(`\n  ${err.message}\n`)
      process.exit(err instanceof UsageError && err.message === 'help' ? 0 : EXIT.ERROR)
    },
  )
}
