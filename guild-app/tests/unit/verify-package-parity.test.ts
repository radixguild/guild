/**
 * scripts/verify-package-parity.mjs — the public reproducible-build check (docs/AUDITOR-GUIDE.md §5).
 *
 * No network: the compare logic is driven in-process, and the CLI end to end through
 * `--gateway-response` (a saved Gateway reply) as a `node` child process. The named defect is a
 * MISMATCH that exits 0, which would let CI or an auditor read a wrong build as proof.
 */
import { describe, it, expect, afterEach, vi } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as parity from "../../../scripts/verify-package-parity.mjs"

vi.setConfig({ testTimeout: 15_000 })

const ROOT = join(process.cwd(), "..")
const SCRIPT = join(ROOT, "scripts", "verify-package-parity.mjs")
const MANIFEST = join(ROOT, "verify", "deployed-packages.json")

const PKG = "package_rdx1pk5z8ktfwd9d3l9vqmngft626cv5tp0hxjyenkh78pzq5u7c38p8yv"
const CODE = Buffer.from("\0asm fake package bytes for the test")
const SHA = createHash("sha256").update(CODE).digest("hex")

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})
function dir() {
  const d = mkdtempSync(join(tmpdir(), "pkg-parity-"))
  tmp.push(d)
  return d
}
function gatewayBody(code: Buffer, hash = parity.blake2b256(code)) {
  return { ledger_state: { state_version: 1 }, items: [{ vm_type: "ScryptoV1", code_hex: code.toString("hex"), code_hash_hex: hash }] }
}
function manifest(entries: Array<Record<string, unknown>>) {
  return { packages: entries }
}
function entry(over: Record<string, unknown> = {}) {
  return { id: "t", address: PKG, wasm_sha256: SHA, code_hash_blake2b256: parity.blake2b256(CODE), ...over }
}
function runCli(args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } })
  return { code: r.status, out: r.stdout + r.stderr }
}

describe("blake2b256 (RFC 7693, 32-byte digest)", () => {
  // Reference values from Python's hashlib.blake2b(digest_size=32).
  it.each([
    ["", "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8"],
    ["abc", "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319"],
  ])("hash of %j", (input, want) => {
    expect(parity.blake2b256(Buffer.from(input))).toBe(want)
  })
  it("multi-block input (768 bytes, crosses the 128-byte block boundary)", () => {
    const buf = Buffer.alloc(768)
    for (let i = 0; i < 768; i++) buf[i] = i % 256
    expect(parity.blake2b256(buf)).toBe("b8007121274217790e2923e0ad7027986e5a99d5531ef6ae7d294140fc81615d")
  })
})

describe("compare", () => {
  const chain = { wasm_sha256: SHA, code_hash_blake2b256: parity.blake2b256(CODE), bytes: CODE.length }
  const exp = parity.parseExpected(manifest([entry()]))[0]

  it("MATCH when chain, expectation and build agree", () => {
    expect(parity.compare(chain, exp, { wasm_sha256: SHA, bytes: CODE.length }).verdict).toBe("MATCH")
  })
  it("MISMATCH when the chain differs from the recorded hash, naming both hashes", () => {
    const r = parity.compare({ ...chain, wasm_sha256: "f".repeat(64) }, exp)
    expect(r.verdict).toBe("MISMATCH")
    expect(r.reasons.join(" ")).toContain("f".repeat(64))
    expect(r.reasons.join(" ")).toContain(SHA)
  })
  it("MISMATCH when the local build differs from the chain, even if the chain matches the record", () => {
    const r = parity.compare(chain, exp, { wasm_sha256: "e".repeat(64), bytes: 1 })
    expect(r.verdict).toBe("MISMATCH")
    expect(r.reasons[0]).toMatch(/^built sha256/)
  })
  it("MISMATCH when the recorded blake2b disagrees", () => {
    const r = parity.compare(chain, { ...exp, code_hash_blake2b256: "0".repeat(64) })
    expect(r.verdict).toBe("MISMATCH")
  })
  it("NO_EXPECTATION without an entry", () => {
    expect(parity.compare(chain, null).verdict).toBe("NO_EXPECTATION")
  })
  it("exit codes: any mismatch -> 1, else any missing -> 3, else 0", () => {
    expect(parity.exitCode([{ verdict: "MATCH" }, { verdict: "MISMATCH" }, { verdict: "NO_EXPECTATION" }])).toBe(1)
    expect(parity.exitCode([{ verdict: "MATCH" }, { verdict: "NO_EXPECTATION" }])).toBe(3)
    expect(parity.exitCode([{ verdict: "MATCH" }])).toBe(0)
  })
})

describe("codeFromGatewayResponse", () => {
  it("hashes the returned bytes", () => {
    const c = parity.codeFromGatewayResponse(gatewayBody(CODE), PKG)
    expect(c.wasm_sha256).toBe(SHA)
    expect(c.bytes).toBe(CODE.length)
  })
  it("refuses when the Gateway's code_hash_hex does not match its own bytes", () => {
    expect(() => parity.codeFromGatewayResponse(gatewayBody(CODE, "a".repeat(64)), PKG)).toThrow(/self-inconsistency/)
  })
  it("refuses zero or several code entries", () => {
    expect(() => parity.codeFromGatewayResponse({ items: [] }, PKG)).toThrow(/no code entries/)
    const two = gatewayBody(CODE)
    two.items.push(two.items[0])
    expect(() => parity.codeFromGatewayResponse(two, PKG)).toThrow(/2 code entries/)
  })
})

describe("parseExpected and parseArgs", () => {
  it("rejects malformed entries", () => {
    expect(() => parity.parseExpected({})).toThrow(/packages/)
    expect(() => parity.parseExpected(manifest([entry({ wasm_sha256: "xyz" })]))).toThrow(/64 hex/)
    expect(() => parity.parseExpected(manifest([entry({ address: "account_rdx1abcdefg" })]))).toThrow(/package address/)
    expect(() => parity.parseExpected(manifest([entry(), entry({ id: "u" })]))).toThrow(/listed twice/)
  })
  it("rejects bad arguments", () => {
    expect(() => parity.parseArgs(["--package", "nope"])).toThrow(/package address/)
    expect(() => parity.parseArgs(["--wasm", "x.wasm"])).toThrow(/need --package/)
    expect(() => parity.parseArgs(["--package"])).toThrow(/needs a value/)
    expect(() => parity.parseArgs(["--bogus"])).toThrow(/unknown argument/)
  })
  it("the committed expected-hash file parses, and every live package has a status and source blobs", () => {
    const m = JSON.parse(readFileSync(MANIFEST, "utf8"))
    const pkgs = parity.parseExpected(m)
    expect(pkgs.length).toBeGreaterThan(0)
    for (const p of pkgs) {
      expect(["verified", "not yet verified"]).toContain(p.status)
      // enforce (fail CI on mismatch) only for a package proven in a linked run
      if (p.enforce) {
        expect(p.status).toBe("verified")
        expect(p.verified_in).toMatch(/^https:\/\/github\.com\/radixguild\/guild\/actions\/runs\/\d+/)
      }
      expect(Object.keys(p.source_blobs)).toContain("src/lib.rs")
    }
  })
})

describe("CLI (offline, saved Gateway response)", () => {
  function setup(code: Buffer, man = manifest([entry()])) {
    const d = dir()
    writeFileSync(join(d, "resp.json"), JSON.stringify(gatewayBody(code)))
    writeFileSync(join(d, "expected.json"), JSON.stringify(man))
    return d
  }
  it("exit 0 and MATCH with both hashes printed", () => {
    const d = setup(CODE)
    writeFileSync(join(d, "built.wasm"), CODE)
    const r = runCli(["--package", PKG, "--expected", join(d, "expected.json"), "--gateway-response", join(d, "resp.json"), "--wasm", join(d, "built.wasm")])
    expect(r.code).toBe(0)
    expect(r.out).toContain("MATCH")
    expect(r.out).toContain(SHA)
  })
  it("exit 1 on a mismatch (the named defect: never exit 0 here)", () => {
    const d = setup(Buffer.from("different deployed bytes"))
    const r = runCli(["--package", PKG, "--expected", join(d, "expected.json"), "--gateway-response", join(d, "resp.json")])
    expect(r.code).toBe(1)
    expect(r.out).toContain("MISMATCH")
    expect(r.out).toContain(SHA)
  })
  it("exit 1 when only the local build differs", () => {
    const d = setup(CODE)
    writeFileSync(join(d, "built.wasm"), Buffer.from("a different build"))
    const r = runCli(["--package", PKG, "--expected", join(d, "expected.json"), "--gateway-response", join(d, "resp.json"), "--wasm", join(d, "built.wasm")])
    expect(r.code).toBe(1)
  })
  it("exit 3 for a package with no entry", () => {
    const d = setup(CODE, manifest([entry({ address: "package_rdx1p53j5yst59jhgc8ljap7266sd0nxgm2lndp2z6a4ddsprkn7e9ssmv" })]))
    const r = runCli(["--package", PKG, "--expected", join(d, "expected.json"), "--gateway-response", join(d, "resp.json")])
    expect(r.code).toBe(3)
  })
  it("exit 2 on a usage error", () => {
    expect(runCli(["--package", "nope"]).code).toBe(2)
  })
})
