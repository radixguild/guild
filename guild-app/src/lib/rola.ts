// Server-side ROLA (Radix Off-Ledger Auth) helpers.
//
// - issueChallenge() → returns a fresh nonce, stores it with 60s TTL.
// - verifyAndConsume(signedChallenge) → verifies the signature against the
//   on-chain owner key for `signedChallenge.address` and consumes the nonce
//   (one-time use). The ROLA check is what binds the address; see the note on
//   the function about the `expectedAddress` parameter that used to sit here.
//
// In-memory store. Single Next.js instance is fine for current scale
// (~15 users). Multi-replica deploy needs Redis or a DB — flagged for Phase 4.

import "server-only";
import { randomBytes } from "node:crypto";
import { Rola, type SignedChallenge } from "@radixdlt/rola";
import { DAPP_DEF } from "@/lib/config";

const CHALLENGE_TTL_MS = 60_000;
const NETWORK_ID = 1; // mainnet

const store = new Map<string, number>(); // challenge -> expires_at (ms epoch)

// Lazy janitor — drops expired nonces, .unref()'d so it doesn't block process exit.
let janitor: ReturnType<typeof setInterval> | null = null;
function ensureJanitor() {
  if (janitor) return;
  janitor = setInterval(() => {
    const now = Date.now();
    for (const [k, exp] of store) if (exp <= now) store.delete(k);
  }, 30_000);
  janitor.unref();
}

function getExpectedOrigin(): string {
  // In production this should come from the request (req.headers.origin)
  // but the rola lib lets us set it once at Rola() init. We use the
  // canonical app origin from env, defaulting to the Sats deploy.
  return process.env.ROLA_EXPECTED_ORIGIN || "https://radixguild.com";
}

const rola = Rola({
  applicationName: "Radix Guild",
  dAppDefinitionAddress: DAPP_DEF,
  networkId: NETWORK_ID,
  expectedOrigin: getExpectedOrigin(),
});

export function issueChallenge(): { challenge: string; expires_at: number } {
  ensureJanitor();
  const challenge = randomBytes(32).toString("hex");
  const expires_at = Date.now() + CHALLENGE_TTL_MS;
  store.set(challenge, expires_at);
  return { challenge, expires_at };
}

export type VerifyResult =
  | { ok: true; address: string }
  | { ok: false; error: string };

/**
 * Verify a signed challenge AND consume the nonce.
 *
 * Checks (fail-closed):
 *   1. The proof is an object of the right shape.
 *   2. Nonce exists and is not expired.
 *   3. ROLA signature is valid (rola lib does canonical-message build,
 *      Gateway lookup of owner key, and signature verify). THIS is what binds
 *      the session to `signedChallenge.address` — nothing else does or can.
 *
 * Returns { ok: true, address } on success. The nonce is always consumed
 * (success or signature-fail) to prevent replay. Expired/missing nonces
 * are not consumed (they were never valid to begin with).
 *
 * ⚠️ REMOVED 2026-09-02 — an `expectedAddress` parameter, and with it a check
 * that could not fail. It was documented as defence in depth ("asserts the
 * address matches the caller-claimed identity") and the unit test passed a
 * genuinely different address and watched it be rejected, so the suite looked
 * like it proved the guard. But the ONLY production caller was:
 *
 *     verifyAndConsume(signed_challenge, signed_challenge.address)
 *
 * — both sides read from one object, so `address !== expectedAddress` was a
 * string compared to itself and the mismatch branch was unreachable in the
 * shipped app. The test proved a property of a call that never happened.
 *
 * It was not fixable by rewiring, and that is the part worth keeping: BOTH
 * sides of that comparison come out of the same untrusted request body. There
 * is no second, independent source for the address on this route — an attacker
 * controls every field they could be compared against. A caller-supplied value
 * checked against another caller-supplied value can never be a security
 * boundary, no matter which field it is read from. So the honest change is
 * deletion, not a better wiring: keeping it would have left a comment claiming
 * a protection that cannot exist.
 *
 * Address binding lives entirely in the ROLA signature verification below.
 */
export async function verifyAndConsume(
  signedChallenge: SignedChallenge,
): Promise<VerifyResult> {
  if (!signedChallenge || typeof signedChallenge !== "object") {
    return { ok: false, error: "missing_proof" };
  }
  const { challenge, address } = signedChallenge;
  if (typeof challenge !== "string" || typeof address !== "string") {
    return { ok: false, error: "invalid_proof_shape" };
  }
  const exp = store.get(challenge);
  if (exp === undefined) {
    return { ok: false, error: "unknown_challenge" };
  }
  if (exp <= Date.now()) {
    store.delete(challenge);
    return { ok: false, error: "challenge_expired" };
  }

  // Consume the nonce up front — even on signature failure we don't want it reused.
  store.delete(challenge);

  // ── The e2e sign-in bypass, and the two interlocks that fence it ──────────
  // The Playwright harness injects a mock wallet that cannot produce a real
  // owner-key signature (no seed; the Gateway is stubbed), so for e2e runs the
  // cryptographic step below is skipped. The nonce checks above (issued,
  // unexpired, consumed once) still run.
  //
  // ⚠️ THIS IS AN AUTHENTICATION BYPASS ON THE PRODUCTION SIGN-IN ROUTE.
  // verifyAndConsume backs POST /api/v1/auth/verify, which issues the session
  // cookie — so wherever this branch is live, any caller authenticates as any
  // address they name. It is fenced twice, by two independent mechanisms, and
  // BOTH must be open for it to run:
  //
  //   1. BUILD time — GUILD_E2E_BUILD. next.config.ts lists it under `env`, so
  //      `next build` replaces the literal `process.env.GUILD_E2E_BUILD` below
  //      with the value it had while the build ran. The box builds through
  //      scripts/deploy.sh, which strips both variables from the build's
  //      environment (`env -u GUILD_E2E_BUILD -u GUILD_E2E_AUTH_BYPASS`), so the
  //      production artifact carries `"" === "1"`: the branch is compiled dead,
  //      and no runtime env (shell, dotenv, or pm2's saved env) can revive it
  //      without a rebuild. Only the e2e harness builds with "1"
  //      (tests/e2e/playwright.config.ts webServer env).
  //      Keep the read LITERAL. Destructuring or a computed key is not replaced
  //      at build time and would silently turn this back into a runtime switch;
  //      tests/unit/rola.test.ts pins the literal form.
  //
  //   2. DEPLOY time — scripts/launch-check.sh CHECK 6 fails the deploy if
  //      GUILD_E2E_AUTH_BYPASS or GUILD_E2E_BUILD appears in any dotenv file,
  //      in the deploying shell, or in the pm2 env of the serving process. The
  //      dotenv scan matters for interlock 1 too: `next build` loads .env*
  //      itself, so a dotenv value would reach the build despite `env -u`.
  //      CHECK 6 reads pm2's own view because `pm2 restart` REUSES the env
  //      captured at first start (until 2026-09-02 it read only the dotenv
  //      files and its own shell, while this comment claimed pm2).
  //
  // Until 2026-10-01 the runtime variable was the ONLY switch and CHECK 6 the
  // only fence: CI's e2e webServer runs `bun run build && bun run start`, the
  // same production build the box makes, so every production build compiled
  // this branch live and gated it solely on GUILD_E2E_AUTH_BYPASS. Interlock 1
  // is what changed.
  //
  // GUILD_E2E_AUTH_BYPASS keeps its own name for the reason it got one: the
  // first cut reused PLAYWRIGHT_E2E, a purely cosmetic flag (it hides the Next
  // dev-tools indicator, see next.config.ts), so anyone reaching for the
  // cosmetic flag would have disabled authentication. A variable that turns
  // off auth must say so in its name.
  //
  // Note what does NOT protect this branch, so nobody adds it back believing
  // it does: comparing the claimed address against another field of the same
  // request. See the note on verifyAndConsume above.
  if (process.env.GUILD_E2E_BUILD === "1" && process.env.GUILD_E2E_AUTH_BYPASS === "1") {
    return { ok: true, address };
  }

  const result = await rola.verifySignedChallenge(signedChallenge);
  if (result.isErr()) {
    return { ok: false, error: `rola: ${result.error.reason}` };
  }
  return { ok: true, address };
}

// Test-only — lets tests inject a known-valid challenge without going through
// issueChallenge. Used by integration tests that stub verifySignedChallenge.
// Not exported in production code paths.
export const _testHooks = {
  store,
  CHALLENGE_TTL_MS,
};
