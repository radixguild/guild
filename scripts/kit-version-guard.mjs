#!/usr/bin/env node
// kit-version-guard.mjs — refuse to serve a CHANGED kit tarball under an UNCHANGED
// package version.
//
//   node scripts/kit-version-guard.mjs --candidate /opt/guild-saas/kit-candidate --live /opt/guild-saas/kit --kit agent --kit mcp
//
// WHY (agent-pr-review on PR #803, rounds 1–2, 2026-09-28, both reproduced):
// `npx -y -p <url> <bin>` caches an install under ~/.npm/_npx keyed by the URL it was
// given — its cache directory is a hash of the spec string and its "already installed"
// check compares the resolved URL. NOT the package version, NOT the bytes. So a machine
// that has run the stable URL once keeps that build for every later deploy at that URL,
// version bump or not, until its ~/.npm/_npx is cleared (round 1 found the same-version
// case; round 2 showed a bumped version does not help either).
//
// The deploy therefore serves each kit TWICE: the stable <name>.tgz for one-shot use,
// and a versioned twin <name>-<version>.tgz for anything long-lived (an MCP client
// config), where an update is a visible URL change. That twin is only honest if a
// changed tarball always carries a new version — otherwise <name>-0.2.0.tgz would mean
// two different things to two machines. THAT is what this guard enforces: it compares
// each kit's candidate against what is live, and same version AND different sha256 =
// STOP, bump the version. Anything else passes — no live kit yet (first deploy), a
// bumped version, or an identical tarball (a no-op redeploy). Reads the <name>.json
// files scripts/pack-kit.sh writes beside each tarball; a candidate without one is a
// broken pack and also stops.
//
// Two records are compared, because the live dir holds two kinds: <name>.json (the CURRENT
// version, written by pack-kit.sh) and every carried twin's <name>-<version>.tgz.sha256
// (scripts/kit-carry-forward.sh keeps those across deploys — including the record of a
// twin it refused, without its bytes). So "the version the live kit has" and "a version
// this box has EVER served" are both checked: a candidate whose version matches ANY live
// twin record with a different hash is blocked. That closes the downgrade case (re-serving
// an older version number with new bytes), which the first cut of this guard let through.
//
// THE GUARD'S MEMORY IS THE KIT DIR. A version it has served is known only by that version's
// twin record (and its tarball); delete both and this script cannot tell a re-serve from a
// first serve — it prints an ordinary "prev → cand" OK. So nothing in this repo advises
// deleting a record: a twin nobody will serve again is RETIRED with a <file>.retired note
// (the watcher stops paging it; the record stays), and kit-carry-forward.sh carries records
// and notes forever. Round 9 of the review: the round-8 BLOCK's own remedy said "remove the
// record by hand" — the one sanctioned action that made this guard forget.
//
// What it does NOT do: make a stale stable-URL install refresh (nothing but clearing
// ~/.npm/_npx does). It DOES re-hash the live tarball for the candidate's version when one
// is present, and says when it has drifted from its record. What happens to the drifted file
// depends on the verdict: when the run passes, the swap replaces it with the candidate's fresh
// copy of that version; when the run BLOCKs, nothing swaps and the drifted file stays on the
// box. Either way the drift itself is an INCIDENTS 4.8 matter — nothing else in the run looks
// at that file.
//
// Exit: 0 = ok · 1 = BLOCKED (same version, different content) · 2 = bad input.
// Pure over two directories; guild-app/tests/unit/kit-version-guard.test.ts drives it.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * What the box can PROVE about the bytes it served for <name>@<version>: the twin's record
 * (<name>-<version>.tgz.sha256) when it is a "<hex>  file" line, else the live tarball's own
 * bytes hashed here (the record is derived from them, so the bytes are the better witness),
 * else nothing. Only the CANDIDATE's own version is ever read, so a bad file for any other
 * version never touches a deploy. Returns null (this version was never served, or nothing of
 * it remains), { sha, source: 'record' | 'tarball', rec }, or { unprovable: recordPath } when
 * a record exists but is unreadable AND the tarball is gone — that fails CLOSED. Rounds 6–8
 * of the review: a silent null, then a WARN, both let a re-serve pass; then a BLOCK whose
 * remedy said "remove the record by hand", which is exactly how to make the guard forget.
 */
function liveTwinProof(dir, name, version) {
  const rec = join(dir, `${name}-${version}.tgz.sha256`);
  const tgz = join(dir, `${name}-${version}.tgz`);
  const hasRec = existsSync(rec);
  const hasTgz = existsSync(tgz);
  if (!hasRec && !hasTgz) return null;
  const m = hasRec ? /^([0-9a-f]{64})\s/i.exec(readFileSync(rec, 'utf8')) : null;
  const tgzSha = hasTgz ? createHash('sha256').update(readFileSync(tgz)).digest('hex') : null;
  if (m) {
    // The record is the memory; the live bytes are re-hashed too (as kit-carry-forward.sh
    // does) so a tampered live tarball beside an intact record is SAID, not silently ignored.
    return { sha: m[1].toLowerCase(), source: 'record', rec, liveTarballDiffers: tgzSha !== null && tgzSha !== m[1].toLowerCase() };
  }
  if (tgzSha) return { sha: tgzSha, source: 'tarball', rec: hasRec ? rec : null };
  return { unprovable: rec };
}

/**
 * Anything of kit `name` on the box at all — a missing <name>.json is then not a first deploy.
 * Twins are matched by the same version-shaped suffix as versionedKits()/kit-carry-forward.sh,
 * so a dashed sibling kit's stable record (agent-lite.tgz.sha256) never counts for `agent`.
 */
const TWIN_SUFFIX = /-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\.tgz\.sha256$/;
function servedBefore(dir, name) {
  if (!existsSync(dir)) return false;
  if (existsSync(join(dir, `${name}.tgz`))) return true;
  return readdirSync(dir).some((f) => f.startsWith(`${name}-`) && TWIN_SUFFIX.test(f.slice(name.length)));
}

const argv = process.argv.slice(2);
let candidate = '';
let live = '';
const kits = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--candidate') candidate = argv[++i] ?? '';
  else if (a === '--live') live = argv[++i] ?? '';
  else if (a === '--kit') kits.push(argv[++i] ?? '');
  else {
    console.error(`kit-version-guard: unknown argument ${a}`);
    process.exit(2);
  }
}
if (!candidate || !live || kits.length === 0 || kits.some((k) => !/^[a-z0-9-]+$/.test(k))) {
  console.error('usage: kit-version-guard.mjs --candidate <dir> --live <dir> --kit <name> [--kit <name>...]');
  process.exit(2);
}

function readMeta(dir, name) {
  const p = join(dir, `${name}.json`);
  if (!existsSync(p)) return null;
  const j = JSON.parse(readFileSync(p, 'utf8'));
  if (typeof j.version !== 'string' || !/^[0-9a-f]{64}$/.test(String(j.sha256))) {
    throw new Error(`${p} is not a pack-kit record (needs version + 64-hex sha256)`);
  }
  return { version: j.version, sha256: j.sha256, pkg: j.package ?? name };
}

let blocked = 0;
for (const name of kits) {
  let cand;
  try {
    cand = readMeta(candidate, name);
  } catch (e) {
    console.error(`kit-version-guard: ${e.message}`);
    process.exit(2);
  }
  if (!cand) {
    console.error(`kit-version-guard: no ${name}.json in ${candidate} — pack-kit.sh did not run for '${name}'`);
    process.exit(2);
  }
  let prev = null;
  try {
    prev = readMeta(live, name);
  } catch (e) {
    // A malformed LIVE record must not wedge every future deploy; say so and treat as no record.
    console.log(`  WARN  ${name}: live record unreadable (${e.message}) — comparing as if no kit were live`);
  }
  const block = (was) => {
    blocked += 1;
    console.log(`  BLOCK ${name}: content changed (${was.slice(0, 16)}… → ${cand.sha256.slice(0, 16)}…) but the version is still ${cand.version}`);
    console.log(`        ${name}-${cand.version}.tgz would then mean different bytes to different machines (npx caches by URL).`);
    console.log(`        Bump "version" in the package's package.json, merge, and deploy again.`);
  };
  // Any version this box has served keeps a twin record (carried forward, bytes or not).
  const proof = liveTwinProof(live, name, cand.version);
  if (proof && proof.unprovable) {
    blocked += 1;
    console.log(`  BLOCK ${name}: this box has served ${cand.version} before — its record ${proof.unprovable} is not a "<hex>  file" line and its tarball is gone,`);
    console.log(`        so nothing can prove the candidate's bytes are the ones that were served under that version. Fails closed.`);
    console.log(`        Bump "version" in the package's package.json, merge, and deploy again. Do NOT delete that record to get past this:`);
    console.log(`        with it gone the guard has no memory of ${cand.version} and would wave ANY bytes through under it.`);
  } else if (proof && proof.sha !== cand.sha256) {
    block(proof.sha);
    console.log(
      proof.source === 'record'
        ? `        (${name}-${cand.version}.tgz.sha256 on the box records the earlier bytes — a re-served version number must carry the same bytes.)`
        : `        (the live ${name}-${cand.version}.tgz on the box hashes to the earlier bytes${proof.rec ? '; its record is malformed and was not trusted' : '; it has no record'} — a re-served version number must carry the same bytes.)`,
    );
    if (proof.liveTarballDiffers) console.log(`        WARN  the live ${name}-${cand.version}.tgz on the box no longer matches that record either — the box's copy drifted; treat as docs/INCIDENTS.md 4.8.`);
  } else if (proof && proof.source === 'tarball') {
    console.log(`  OK    ${name}@${cand.version} — identical to the live ${name}-${cand.version}.tgz (${proof.rec ? 'its record is malformed' : 'it has no record'}; the bytes were hashed instead; the candidate's own record for this version replaces it on the swap)`);
  } else if (proof && proof.liveTarballDiffers) {
    // Same bytes as the record, but the LIVE tarball has drifted from both: the candidate is
    // right, the box's copy is not. This is the CANDIDATE's own version, so pack-kit already
    // wrote a fresh copy into the candidate and the carry-forward keeps the candidate's — the
    // swap replaces the drifted file. Said here because nothing else in this run looks at it.
    console.log(`  OK    ${name}@${cand.version} — identical to the bytes ${name}-${cand.version}.tgz.sha256 records`);
    console.log(`        WARN  the live ${name}-${cand.version}.tgz on the box does NOT match that record — the box's copy drifted; the candidate's own copy of this version replaces it on the swap. Treat the drift as docs/INCIDENTS.md 4.8.`);
  } else if (!prev) {
    if (servedBefore(live, name)) {
      console.log(`  WARN  ${name}: no readable live ${name}.json, but the box holds served files for ${name} — not a first deploy; only ${cand.version}'s own twin proof was checked (none found)`);
    }
    console.log(`  OK    ${name}@${cand.version} ${cand.sha256.slice(0, 16)}… — ${servedBefore(live, name) ? `no live ${name}.json to compare against` : 'no kit live yet'}`);
  } else if (prev.sha256 === cand.sha256) {
    console.log(`  OK    ${name}@${cand.version} — identical to the live tarball (no-op)`);
  } else if (prev.version !== cand.version) {
    console.log(`  OK    ${name} ${prev.version} → ${cand.version} (${prev.sha256.slice(0, 16)}… → ${cand.sha256.slice(0, 16)}…)`);
  } else {
    block(prev.sha256);
  }
}

if (blocked > 0) {
  console.log(`\nKIT VERSION GUARD: BLOCKED — ${blocked} kit(s) changed without a version bump. Nothing swapped.`);
  process.exit(1);
}
console.log('\nKIT VERSION GUARD: OK');
