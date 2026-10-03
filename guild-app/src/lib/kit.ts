// The served agent kit, as THIS build knows it (docs/design/bring-your-agent.md
// §2.4 "Integrity — owed before S1").
//
// NEXT_PUBLIC_KIT_SHA256 / NEXT_PUBLIC_KIT_VERSION are baked at build time by
// scripts/deploy.sh from the tarball it packed one step earlier
// (/opt/guild-saas/kit-candidate/agent.tgz.sha256), and that tarball swaps into
// /opt/guild-saas/kit in the same remote command that starts this build. So the
// hash /agents prints IS the hash of /kit/agent.tgz — the two never come from
// different deploys. launch-check CHECK 11 fails a build whose prerendered
// /agents does not carry the candidate's hash, and refuses the value from a
// dotenv file (a hash written there would outlive the tarball it described).
//
// A development or CI build has no kit: KIT_SHA256 is null and the copy says so
// rather than printing a placeholder someone could mistake for a real hash.

import { KIT_TARBALL_URL } from "@/lib/config"

const raw = process.env.NEXT_PUBLIC_KIT_SHA256 ?? ""
/** sha256 (lowercase hex) of the served /kit/agent.tgz, or null when this build serves no kit. */
export const KIT_SHA256: string | null = /^[0-9a-f]{64}$/.test(raw) ? raw : null
/** The kit package version the deploy packed, or null outside a deploy build. */
export const KIT_VERSION: string | null = process.env.NEXT_PUBLIC_KIT_VERSION || null

export const KIT_SHA256_URL = `${KIT_TARBALL_URL}.sha256`

/**
 * Mirrors packages/agent-client/src/kit-release.ts RUN_SHIPPED — the #790
 * gate. The kit prints one message after `join` and the app prints the matching
 * sentence on /agents; tests/unit/agents-kit-copy.test.tsx pins this constant to
 * the kit's source so the two cannot disagree. Flip both, in one PR, when #790
 * merges.
 */
export const KIT_RUN_SHIPPED = false

/** The two-command check the page prints: fetch, hash, compare by eye. */
export const KIT_CHECK_BY_EYE = `curl -sO ${KIT_TARBALL_URL} && shasum -a 256 agent.tgz`
/** The same check with the comparison done by the tool (Linux: sha256sum -c). */
export const KIT_CHECK_AUTO = `curl -sO ${KIT_TARBALL_URL} && curl -sO ${KIT_SHA256_URL} && shasum -a 256 -c agent.tgz.sha256`

/**
 * The one line the page prints: the kit's readiness check, the same line public/llms.txt gives. It
 * carries no code — agents are badge-first (bring your own key, the kit never makes one), and the
 * pairing that issued a code is off for the beta.
 */
export const KIT_ONE_LINER_SHAPE = `npx -y -p ${KIT_TARBALL_URL} guild-worker doctor`
