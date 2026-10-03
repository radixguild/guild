/**
 * Unit tests for server-side ROLA helpers (Phase 2).
 *
 * Mocks @radixdlt/rola so we don't hit the Gateway. The mock returns
 * ok(undefined) for "valid" signatures and an err for invalid ones —
 * the real lib's job (canonical message, Gateway lookup) is its own
 * test surface, not ours. What we own:
 *   - nonce issuance + TTL
 *   - replay protection (one-time consume)
 *   - shape validation
 *   - that the ROLA signature check is the ONLY thing binding the session to
 *     an address (see the address-binding test, and the note it carries about
 *     the test that used to live here)
 *   - that the e2e sign-in bypass needs BOTH of its interlocks open, and that
 *     the build-time one is written so `next build` can inline it (the two
 *     blocks at the bottom)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ok, err } from "neverthrow";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// Mock @radixdlt/rola BEFORE importing the SUT — the SUT calls Rola()
// at module-load time. vi.mock is hoisted above local consts, so the
// mock fn must live in vi.hoisted() to be accessible from the factory.
const { verifySignedChallenge } = vi.hoisted(() => ({ verifySignedChallenge: vi.fn() }));
vi.mock("@radixdlt/rola", () => ({
  Rola: () => ({ verifySignedChallenge }),
}));

// Now import. (Top-level await isn't needed; vi.mock is hoisted.)
import { issueChallenge, verifyAndConsume, _testHooks } from "@/lib/rola";

const ADDR = "account_rdx128uxu4mkjgen9wxcl5a7lpyu4kcec6vkhsnj4u0kfrv4v6jvk9u5mw";

function makeProof(challenge: string, address = ADDR) {
  return {
    address,
    type: "account" as const,
    challenge,
    proof: {
      publicKey: "00".repeat(33),
      signature: "ab".repeat(64),
      curve: "curve25519" as const,
    },
  };
}

describe("rola: issueChallenge", () => {
  beforeEach(() => {
    _testHooks.store.clear();
    verifySignedChallenge.mockReset();
  });

  it("returns 32-byte (64-hex-char) nonce + expires_at in the future", () => {
    const { challenge, expires_at } = issueChallenge();
    expect(challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(expires_at).toBeGreaterThan(Date.now());
    expect(expires_at).toBeLessThanOrEqual(Date.now() + _testHooks.CHALLENGE_TTL_MS + 10);
  });

  it("issues distinct nonces", () => {
    const a = issueChallenge().challenge;
    const b = issueChallenge().challenge;
    expect(a).not.toEqual(b);
  });
});

describe("rola: verifyAndConsume", () => {
  beforeEach(() => {
    _testHooks.store.clear();
    verifySignedChallenge.mockReset();
    verifySignedChallenge.mockReturnValue(ok(undefined));
  });

  it("rejects null/undefined proof", async () => {
    // @ts-expect-error — testing runtime guard
    expect((await verifyAndConsume(null)).ok).toBe(false);
    // @ts-expect-error
    expect((await verifyAndConsume(undefined)).ok).toBe(false);
  });

  it("rejects proof with wrong shape", async () => {
    // @ts-expect-error — testing runtime guard
    const r = await verifyAndConsume({ foo: "bar" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_proof_shape");
  });

  it("rejects unknown challenge nonce", async () => {
    const r = await verifyAndConsume(makeProof("deadbeef".repeat(8)), ADDR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("unknown_challenge");
  });

  it("rejects expired challenge and removes it from store", async () => {
    const { challenge } = issueChallenge();
    // Backdate the entry to simulate expiry.
    _testHooks.store.set(challenge, Date.now() - 1000);
    const r = await verifyAndConsume(makeProof(challenge));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("challenge_expired");
    expect(_testHooks.store.has(challenge)).toBe(false);
  });

  it("happy path: valid proof → ok, nonce consumed", async () => {
    const { challenge } = issueChallenge();
    expect(_testHooks.store.has(challenge)).toBe(true);

    const r = await verifyAndConsume(makeProof(challenge));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.address).toBe(ADDR);
    expect(verifySignedChallenge).toHaveBeenCalledOnce();
    expect(_testHooks.store.has(challenge)).toBe(false);
  });

  it("rejects replay: second use of same nonce → unknown_challenge", async () => {
    const { challenge } = issueChallenge();
    const first = await verifyAndConsume(makeProof(challenge));
    expect(first.ok).toBe(true);

    const second = await verifyAndConsume(makeProof(challenge));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("unknown_challenge");
  });

  it("signature failure consumes nonce too (no replay window)", async () => {
    const { challenge } = issueChallenge();
    verifySignedChallenge.mockReturnValueOnce(err({ reason: "invalidSignature" }));

    const r = await verifyAndConsume(makeProof(challenge));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("rola: invalidSignature");

    expect(_testHooks.store.has(challenge)).toBe(false);
  });
});

/**
 * ⚠️ WHAT THIS BLOCK REPLACES, and why it is not the same test renamed.
 *
 * Until 2026-09-02 the suite above held "rejects when claimed address doesn't
 * match expected address": it passed WRONG_ADDR as a second `expectedAddress`
 * argument, watched `address_mismatch` come back, and looked like proof of a
 * defence-in-depth check. The shipped route called
 * `verifyAndConsume(signed_challenge, signed_challenge.address)` — one object,
 * both sides — so the branch that test exercised was unreachable in production.
 * A green test over a call that never happens is worse than no test: it reads
 * as assurance.
 *
 * The parameter is gone (it could never have been a boundary — every field it
 * could compare against comes from the same untrusted request body). These
 * tests pin what is ACTUALLY true instead, so that nobody reintroduces a
 * caller-supplied address check believing it protects the route: the address a
 * session is issued for comes straight off the proof, and the ONLY thing
 * standing between an arbitrary claimed address and a valid session is the
 * ROLA signature verification.
 *
 * The falsifying input for each, stated so these are checkable rather than
 * decorative: if a future edit reintroduced any address gate ahead of the ROLA
 * call, the first test would fail (verifySignedChallenge would not be reached
 * for VICTIM_ADDR); if a future edit stopped consulting ROLA's verdict, the
 * second would fail (an invalid signature would be accepted).
 */
describe("rola: address binding comes from ROLA and nowhere else", () => {
  const VICTIM_ADDR =
    "account_rdx12someoneelsesaccountnotthecallers000000000000000000000";

  beforeEach(() => {
    _testHooks.store.clear();
    verifySignedChallenge.mockReset();
  });

  it("an arbitrary claimed address still reaches the signature check", async () => {
    verifySignedChallenge.mockReturnValue(ok(undefined));
    const { challenge } = issueChallenge();

    const r = await verifyAndConsume(makeProof(challenge, VICTIM_ADDR));

    // Accepted — but ONLY because the mocked ROLA lib vouched for it. Nothing
    // else in verifyAndConsume looked at the address at all.
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.address).toBe(VICTIM_ADDR);
    expect(verifySignedChallenge).toHaveBeenCalledOnce();
  });

  it("and is refused the moment that check says no", async () => {
    verifySignedChallenge.mockReturnValue(err({ reason: "invalidSignature" }));
    const { challenge } = issueChallenge();

    const r = await verifyAndConsume(makeProof(challenge, VICTIM_ADDR));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("rola: invalidSignature");
  });
});

/**
 * The e2e sign-in bypass (src/lib/rola.ts) skips the ROLA signature check —
 * on the route that issues session cookies — so it is fenced by two
 * independent interlocks and needs BOTH:
 *
 *   GUILD_E2E_BUILD === "1"        build time: next.config.ts `env` inlines it at
 *                                  `next build`; the box's build bakes in "".
 *   GUILD_E2E_AUTH_BYPASS === "1"  runtime: the harness's webServer env; launch-check
 *                                  CHECK 6 fails a deploy that carries it.
 *
 * Here the flags are plain runtime reads (vitest does not run Next's define
 * pass), so vi.stubEnv stands in for "what the build baked" as well as "what
 * the process holds". In every case ROLA is mocked to REFUSE, so an ok:true
 * can only have come from the bypass.
 *
 * Falsifiable, and checked when this landed: turning the `&&` in rola.ts into
 * `||` makes the first two tests fail (and the source pin below).
 */
describe("rola: the e2e bypass is honoured only with BOTH interlocks open", () => {
  beforeEach(() => {
    _testHooks.store.clear();
    verifySignedChallenge.mockReset();
    verifySignedChallenge.mockReturnValue(err({ reason: "invalidSignature" }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("runtime flag alone — what a production build sees, GUILD_E2E_BUILD baked to \"\" — is refused; ROLA decides", async () => {
    vi.stubEnv("GUILD_E2E_BUILD", "");
    vi.stubEnv("GUILD_E2E_AUTH_BYPASS", "1");
    const { challenge } = issueChallenge();

    const r = await verifyAndConsume(makeProof(challenge));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("rola: invalidSignature");
    expect(verifySignedChallenge).toHaveBeenCalledOnce();
    expect(_testHooks.store.has(challenge)).toBe(false);
  });

  it("build flag alone is refused; ROLA decides", async () => {
    vi.stubEnv("GUILD_E2E_BUILD", "1");
    vi.stubEnv("GUILD_E2E_AUTH_BYPASS", undefined);
    const { challenge } = issueChallenge();

    const r = await verifyAndConsume(makeProof(challenge));

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("rola: invalidSignature");
    expect(verifySignedChallenge).toHaveBeenCalledOnce();
  });

  it("neither flag: refused; ROLA decides", async () => {
    vi.stubEnv("GUILD_E2E_BUILD", undefined);
    vi.stubEnv("GUILD_E2E_AUTH_BYPASS", undefined);
    const { challenge } = issueChallenge();

    const r = await verifyAndConsume(makeProof(challenge));

    expect(r.ok).toBe(false);
    expect(verifySignedChallenge).toHaveBeenCalledOnce();
  });

  it("near-miss values are not \"1\": refused", async () => {
    for (const [build, bypass] of [
      ["true", "1"],
      ["1", "true"],
      [" 1", "1"],
      ["1", "01"],
    ]) {
      vi.stubEnv("GUILD_E2E_BUILD", build);
      vi.stubEnv("GUILD_E2E_AUTH_BYPASS", bypass);
      verifySignedChallenge.mockClear();
      const { challenge } = issueChallenge();

      const r = await verifyAndConsume(makeProof(challenge));

      expect(r.ok, `GUILD_E2E_BUILD=${JSON.stringify(build)} GUILD_E2E_AUTH_BYPASS=${JSON.stringify(bypass)}`).toBe(false);
      expect(verifySignedChallenge).toHaveBeenCalledOnce();
    }
  });

  it("both \"1\" (an e2e build, harness env): honoured without consulting ROLA; the nonce is still required and consumed", async () => {
    vi.stubEnv("GUILD_E2E_BUILD", "1");
    vi.stubEnv("GUILD_E2E_AUTH_BYPASS", "1");
    const { challenge } = issueChallenge();

    const r = await verifyAndConsume(makeProof(challenge));

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.address).toBe(ADDR);
    expect(verifySignedChallenge).not.toHaveBeenCalled();
    expect(_testHooks.store.has(challenge)).toBe(false);

    // The bypass skips the signature, never the nonce: an unissued challenge
    // is still refused before the bypass is reached.
    const unknown = await verifyAndConsume(makeProof("deadbeef".repeat(8)));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toBe("unknown_challenge");
  });
});

/**
 * The runtime tests above cannot see the property that makes interlock 1 an
 * interlock: that `next build` REPLACES the read. Next's define pass only
 * rewrites the literal member expression `process.env.GUILD_E2E_BUILD`. A
 * refactor to `const { GUILD_E2E_BUILD } = process.env` or
 * `process.env["GUILD_E2E_BUILD"]` would keep every test above green while
 * turning the flag back into a runtime switch that a pm2 env could flip. So
 * the source form is pinned here, and so is the next.config.ts entry that
 * does the inlining.
 */
describe("rola: the build-time interlock stays inlinable", () => {
  const APP = path.resolve(__dirname, "../..");
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
      else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
    }
    return out;
  }

  // Comments name the variable in prose; only code is held to the rule.
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it("rola.ts gates on both flags as literal process.env reads joined by &&", () => {
    const src = readFileSync(path.join(APP, "src/lib/rola.ts"), "utf8");
    expect(src).toContain(
      'if (process.env.GUILD_E2E_BUILD === "1" && process.env.GUILD_E2E_AUTH_BYPASS === "1") {',
    );
  });

  it("no code under src/ reads GUILD_E2E_BUILD in a form the build cannot replace", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(APP, "src"))) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const m of code.matchAll(/GUILD_E2E_BUILD/g)) {
        const before = code.slice(Math.max(0, (m.index ?? 0) - "process.env.".length), m.index);
        if (before !== "process.env.") offenders.push(`${path.relative(APP, file)} @${m.index}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("next.config.ts inlines GUILD_E2E_BUILD, defaulting to \"\" — never to an armed value", async () => {
    vi.stubEnv("GUILD_E2E_BUILD", undefined);
    vi.resetModules();
    const unset = (await import("../../next.config")).default;
    expect(unset.env?.GUILD_E2E_BUILD).toBe("");

    vi.stubEnv("GUILD_E2E_BUILD", "1");
    vi.resetModules();
    const armed = (await import("../../next.config")).default;
    expect(armed.env?.GUILD_E2E_BUILD).toBe("1");
  });
});
