/**
 * src/lib/alert-core is a byte-for-byte VENDORED copy of
 * packages/alert-policy/src — the one alert policy every bigdev bot pages
 * through. guild-app cannot consume the package as a dependency without a
 * workspace/lockfile change on a deploy-sensitive app, so it carries a copy,
 * and this test is what stops the copy from becoming a fork: any edit made
 * here and not in the package (or vice versa) fails CI in the same run.
 *
 * To change the policy: edit packages/alert-policy/src, run its tests, then
 * `cp packages/alert-policy/src/*.ts guild-app/src/lib/alert-core/` (tests
 * excluded), and re-vendor the CJS bundle into the bots.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PKG = join(process.cwd(), "..", "packages", "alert-policy", "src");
const APP = join(process.cwd(), "src", "lib", "alert-core");

const FILES = ["policy.ts", "store.ts", "format.ts", "evaluate.ts", "index.ts", "rolling-window.ts"];

describe("alert-core parity with packages/alert-policy", () => {
  it.each(FILES)("%s is byte-identical to the package source", (file) => {
    expect(readFileSync(join(APP, file), "utf8")).toBe(readFileSync(join(PKG, file), "utf8"));
  });

  it("the app copy carries exactly the package's non-test files — nothing extra, nothing missing", () => {
    const pkgFiles = readdirSync(PKG).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort();
    const appFiles = readdirSync(APP).filter((f) => f.endsWith(".ts")).sort();
    expect(appFiles).toEqual(pkgFiles);
    expect(pkgFiles).toEqual([...FILES].sort());
  });

  it("the policy is the one the named defect was fixed with (guards a silent revert to level triggering)", () => {
    const policy = readFileSync(join(APP, "policy.ts"), "utf8");
    // The three edges the storm fix depends on. A policy that lost any of
    // them would still compile and still "send alerts".
    expect(policy).toContain('action: "remind"');
    expect(policy).toContain('action: "suppress"');
    expect(policy).toContain("lastClearedAt: now");
    expect(policy).toContain("REMINDER_SCHEDULE_MS");
  });
});
