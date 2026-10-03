/**
 * Vendor the built CJS bundle into a consumer repo — the bridge until the
 * package is on npm (needs the operator's `npm login`; nothing here can do
 * that).
 *
 *   bun run vendor -- ../../../guild-public/bot/lib/alert-policy.cjs
 *
 * Writes dist/index.cjs to the target path with a header line carrying the
 * package version and the sha256 of the BODY (everything after the header).
 * A consumer's parity test recomputes that hash, so a hand-edited vendored
 * copy fails its own repo's CI: the header is the contract that this file is
 * a copy, not a fork. Run `bun run build` first — this refuses a stale dist.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const here = dirname(new URL(import.meta.url).pathname);
const pkg = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8")) as { version: string };
const distPath = resolve(here, "../dist/index.cjs");
const target = process.argv[2];

if (!target) {
  console.error("usage: bun run vendor -- <target-file.cjs>");
  process.exit(2);
}
if (!existsSync(distPath)) {
  console.error("dist/index.cjs missing — run `bun run build` first");
  process.exit(1);
}
// Stale-dist guard: any src file newer than the bundle means the bundle is not what src says.
//
// 🔴 This list must name EVERY non-test file in src/. It used to omit
// rolling-window.ts, and the omission was not theoretical: rolling-window was
// added to index.ts on 2026-09-15 while dist/index.cjs still dated from
// 09-07, so both vendored copies shipped without it for three days. The
// omission only failed to bite because index.ts itself was touched by the
// same change; a later edit to rolling-window.ts's BODY alone would have
// vendored a stale bundle in silence. Enumerating the directory would be
// better still — until then, adding a file to src/ means adding it here.
const distMtime = statSync(distPath).mtimeMs;
for (const f of ["policy.ts", "store.ts", "format.ts", "evaluate.ts", "rolling-window.ts", "index.ts"]) {
  if (statSync(resolve(here, "../src", f)).mtimeMs > distMtime) {
    console.error(`src/${f} is newer than dist/index.cjs — run \`bun run build\` first`);
    process.exit(1);
  }
}

const body = readFileSync(distPath, "utf8");
const sha = createHash("sha256").update(body).digest("hex");
const header =
  `// @radix-guild/alert-policy v${pkg.version} — VENDORED BUILD, do not edit. ` +
  `Source: guild-saas/packages/alert-policy. sha256:${sha}\n`;
mkdirSync(dirname(resolve(target)), { recursive: true });
writeFileSync(resolve(target), header + body);
console.log(`vendored @radix-guild/alert-policy v${pkg.version} → ${target} (${body.length} bytes, sha256 ${sha.slice(0, 12)}…)`);

/**
 * Consumers verify with this (copy into a test):
 *   const src = readFileSync(path, "utf8");
 *   const nl = src.indexOf("\n");
 *   const header = src.slice(0, nl); const body = src.slice(nl + 1);
 *   const claimed = /sha256:([0-9a-f]{64})/.exec(header)?.[1];
 *   assert.equal(createHash("sha256").update(body).digest("hex"), claimed);
 */
