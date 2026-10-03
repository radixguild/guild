"use strict";
/**
 * lib/alert-policy.cjs is a VENDORED build of @radix-guild/alert-policy
 * (guild-saas/packages/alert-policy). Its first line carries the package
 * version and the sha256 of everything after it. This recomputes the hash, so
 * a copy edited in place — turning the shared policy into a private fork —
 * fails the bot's own test run. To change the policy: change the package,
 * re-run `bun run vendor` there, commit the new file here.
 *
 * ⚠️ The name check below accepts BOTH `@radixguild/` and `@radix-guild/`.
 * The package was published as the former and renamed to the latter in its
 * package.json, and the header is generated from that field — so the two
 * spellings mark nothing more than which side of the rename a vendored copy
 * was cut on. Pinning one spelling turned a cosmetic rename into a red test
 * on 2026-09-18, which is a false signal: the sha256 below is the actual
 * contract, and it is what catches a hand-edited fork.
 */
const test = require("node:test");
const assert = require("node:assert");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");

test("vendored alert-policy bundle matches its own sha256 header", () => {
  const src = readFileSync(path.join(__dirname, "..", "lib", "alert-policy.cjs"), "utf8");
  const nl = src.indexOf("\n");
  const header = src.slice(0, nl);
  const body = src.slice(nl + 1);
  const claimed = /sha256:([0-9a-f]{64})/.exec(header)?.[1];
  assert.ok(claimed, "header carries no sha256 — not a vendored build");
  assert.match(header, /@radix-?guild\/alert-policy v\d+\.\d+\.\d+/);
  assert.strictEqual(createHash("sha256").update(body).digest("hex"), claimed);
});

test("the bundle exports the policy surface the bot relies on", () => {
  const m = require("../lib/alert-policy.cjs");
  for (const name of ["createAlertEvaluator", "SqliteAlertStore", "MemoryAlertStore", "decide"]) {
    assert.strictEqual(typeof m[name], "function", name);
  }
});
