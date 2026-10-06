import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { privateInputs, PRIVATE_TREE } from "../support/private-input";

/**
 * Two CI invariants that are cheap to check here and expensive to learn from a
 * red PR — or, worse, from a PR that can never go green.
 *
 * 1. `ubuntu-slim` jobs must stay slim-COMPATIBLE. Private-repo Actions minutes
 *    bill per job rounded UP to a whole minute, so a 7-second job costs the same
 *    as a 59-second one and the only lever left is the runner RATE: slim is
 *    $0.002/min against ubuntu-latest's $0.006. Six sub-21-second jobs moved
 *    there. But slim runs UNPRIVILEGED on 1 core, so a `services:` block (docker
 *    service container) or a `sudo` step silently makes that job unrunnable.
 *    That failure reads as "the runner is broken", not "this job cannot be
 *    slim" — which is exactly the kind of confusion worth a gate.
 *
 * 2. Job NAMES are load-bearing. Main's branch rules require several of them as
 *    status checks (REQUIRED below mirrors this repository's list). A renamed
 *    job does not fail a PR — it leaves it stuck forever on
 *    "Expected — waiting for status", because the check it waits for no longer
 *    reports at all. That is unfalsifiable from inside the PR, so it is pinned
 *    here where a rename fails loudly and locally instead.
 *
 * Parsed by regex rather than a YAML library on purpose: js-yaml is only a
 * TRANSITIVE dep here (via eslintrc/cosmiconfig), so importing it would couple
 * this gate to a dependency nothing declares — one bump and the gate vanishes.
 * The scrape is pinned by the self-checks below, the same shape the honest-copy
 * guides test uses for the GUIDES array.
 */

const WORKFLOWS = join(__dirname, "../../../.github/workflows");

type Job = { id: string; name: string; runsOn: string; body: string; file: string };

/**
 * Drop whole-line YAML comments before scanning a job for `sudo` / `services:`.
 *
 * Necessary, and found the honest way: the first version of this test flagged
 * pii-scan, whose job carries a comment reading "no sudo and no service
 * container, so unprivileged slim is safe here" — prose ABOUT the rule tripping
 * the rule. Note what is NOT done here: the regexes below were left strict and
 * the INPUT was narrowed. Loosening `/\bsudo\s/` until the comment stopped
 * matching would have quietly excused real `sudo` calls too, which is this
 * repo's documented way of ending up with a check that cannot go red.
 *
 * Whole-line comments only, deliberately. Stripping trailing `# ...` would need
 * to know whether the `#` sits inside a quoted string or a `run:` heredoc, and
 * guessing that wrong deletes real script text. Whole-line stripping cannot.
 */
const stripComments = (s: string) => s.replace(/^[ \t]*#.*$/gm, "");

/** Split a workflow file into its jobs. Jobs are the 2-space keys under `jobs:`. */
function parseJobs(file: string, absPath?: string): Job[] {
  const src = readFileSync(absPath ?? join(WORKFLOWS, file), "utf8");
  const jobsBlock = src.split(/^jobs:\s*$/m)[1];
  if (!jobsBlock) return [];
  // Each job starts at a 2-space-indented key and runs until the next one.
  const starts = [...jobsBlock.matchAll(/^ {2}([a-zA-Z0-9_-]+):\s*$/gm)];
  return starts.map((m, i) => {
    const from = m.index!;
    const to = i + 1 < starts.length ? starts[i + 1].index! : jobsBlock.length;
    const body = jobsBlock.slice(from, to);
    return {
      id: m[1],
      name: body.match(/^\s{4}name:\s*(.+)$/m)?.[1].trim() ?? m[1],
      runsOn: body.match(/^\s{4}runs-on:\s*([^\s#]+)/m)?.[1].trim() ?? "",
      body,
      file,
    };
  });
}

const workflowFiles = readdirSync(WORKFLOWS).filter(
  (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
);

// NOT `flatMap(parseJobs)`: flatMap passes (element, INDEX, array), so the index
// would arrive as the optional `absPath` added above and `readFileSync(0)` would
// read fd 0 — stdin — failing with EAGAIN rather than anything that names a file.
const allJobs = workflowFiles.flatMap((f) => parseJobs(f));

describe("CI workflow runners", () => {
  it("self-check: the scrape finds jobs, names and runners", () => {
    // Without this, a formatting change would make every assertion below pass
    // vacuously over an empty array — the failure mode the gate exists to stop.
    expect(allJobs.length).toBeGreaterThan(5);
    expect(allJobs.every((j) => j.runsOn !== "")).toBe(true);
    expect(allJobs.some((j) => j.runsOn === "ubuntu-slim")).toBe(true);
    expect(allJobs.some((j) => j.runsOn === "ubuntu-latest")).toBe(true);
  });

  it("no ubuntu-slim job uses a service container (slim is unprivileged)", () => {
    const offenders = allJobs
      .filter((j) => j.runsOn === "ubuntu-slim" && /^\s{4}services:/m.test(stripComments(j.body)))
      .map((j) => `${j.file}:${j.id}`);
    expect(offenders).toEqual([]);
  });

  it("no ubuntu-slim job shells out to sudo (slim is unprivileged)", () => {
    const offenders = allJobs
      .filter((j) => j.runsOn === "ubuntu-slim" && /\bsudo\s/.test(stripComments(j.body)))
      .map((j) => `${j.file}:${j.id}`);
    expect(offenders).toEqual([]);
  });

  it("self-check: both slim rules still fire on a job that violates them", () => {
    // Guards the comment-stripping above. If stripComments ever over-reached
    // (or the regexes rotted), the two assertions above would pass over
    // everything and this file would be decoration. So prove they still bite,
    // using the two REAL jobs that cannot be slim: gitleaks does `sudo mv`, and
    // playwright e2e declares a postgres service container.
    const gitleaks = allJobs.find((j) => j.name === "gitleaks (secret scan)")!;
    const e2e = allJobs.find((j) => j.name === "playwright e2e (guild-app)")!;
    expect(/\bsudo\s/.test(stripComments(gitleaks.body))).toBe(true);
    expect(/^\s{4}services:/m.test(stripComments(e2e.body))).toBe(true);
    // ...and that both are correctly NOT on slim.
    expect([gitleaks.runsOn, e2e.runsOn]).toEqual(["ubuntu-latest", "ubuntu-latest"]);
  });
});

/**
 * Two budget guards. Both were absent from exactly one workflow (scrypto.yml)
 * while the other three had carried them since they were written — the shape
 * that a per-file convention takes when nothing enforces it.
 */
describe("CI cost containment", () => {
  it("every job sets timeout-minutes (GitHub's default is SIX HOURS)", () => {
    // A job with no timeout that hangs bills up to 360 minutes. scrypto.yml's
    // job — the most expensive in the repo at ~19 min — had none until
    // 2026-08-16. Minutes are billed per job rounded up, so one hang can cost
    // more than a fortnight of ordinary CI.
    const missing = allJobs
      .filter((j) => !/^\s{4}timeout-minutes:\s*\d+/m.test(stripComments(j.body)))
      .map((j) => `${j.file}:${j.id}`);
    expect(missing).toEqual([]);
  });

  it("every workflow sets a concurrency group with cancel-in-progress", () => {
    // Without it, a second push leaves the superseded run going to completion
    // and bills it in full. Observed live on 2026-08-16: two ~19-minute scrypto
    // runs in flight at once on chore/licence-apache2, 20 minutes apart.
    const missing = workflowFiles.filter((f) => {
      const src = stripComments(readFileSync(join(WORKFLOWS, f), "utf8"));
      return !/^concurrency:/m.test(src) || !/cancel-in-progress:\s*true/.test(src);
    });
    expect(missing).toEqual([]);
  });
});

// Was verbatim from `gh api repos/bigdevxrd/guild-saas/branches/main/protection
// --jq .required_status_checks.contexts` on 2026-08-16 — 9 entries, including
// "syntax check (bot)". The bot/ decommission (chore/decommission-vestigial-bot,
// 2026-09-03) deleted that job and this list dropped it to match, ANTICIPATING
// the branch-protection edit bigdev had to make before that PR could merge (an
// agent must not touch branch protection — see that PR's description).
//
// ✅ bigdev has since made that edit. RE-VERIFIED LIVE 2026-09-18: the same
// `gh api` call returned exactly the first 8 contexts below, in this order. (The
// paragraph here used to warn that "live branch protection still requires 9
// contexts and every PR sits on Expected — waiting for status"; that was true
// when written and false for the ten days it then stood. Left visible rather
// than deleted, because the same staleness is what the template gate at the
// bottom of this file exists to stop.)
//
// RE-VERIFIED LIVE 2026-10-02 and again 2026-10-03: the same call returns these 15
// contexts, in this order (strict, admins enforced). Seven were added on 2026-10-01, from
// `identity/PII scan` on; this list kept the old 8 until today, and the prose
// count in test.yml went on saying "eight" beside it.
//
// What this test still does NOT do: read GitHub's live config. It guards
// workflow-file/required-list agreement only. Renaming or dropping a job
// without updating branch protection in the SAME sitting wedges every open PR.
const REQUIRED = [
  "lint (guild-app)",
  "unit + integration (guild-app)",
  "build (guild-app)",
  "playwright e2e (guild-app)",
  "gitleaks (secret scan)",
  "agent-client (unit + parity + types)",
  "agent-mcp (unit + types)",
  "docs (structure)",
  "identity/PII scan (fail-closed)",
  "publish gate (package leak scan)",
  "bot (unit tests)",
  "alert-policy (unit + node smoke + pack)",
  "scrypto gate",
  "formal gate",
  "npm-lockfile gate",
];

// REQUIRED is THIS (private) repo's own live branch-protection required-check
// list. In the public export, .github/workflows/test.yml's CONTENT is swapped
// for the trimmed publish/ci-public-test.yml (publish/MANIFEST.md,
// WORKFLOW_CONTENT_SWAP) — cutting the `docs`/`publish-gate` jobs by design
// (ruling N3 #4) — so this list no longer describes the file it is checked
// against there. The file itself ships; the question is private-repo-only.
describe.skipIf(!PRIVATE_TREE)("required status check names", () => {
  it("every required check still has a job that produces it", () => {
    const names = new Set(allJobs.map((j) => j.name));
    expect(REQUIRED.filter((r) => !names.has(r))).toEqual([]);
  });
});

/**
 * The conditional-skip on `playwright e2e (guild-app)` — the repo's most
 * expensive job (265 billed minutes across 75 runs on 2026-08-16, 22% of that
 * day's billed minutes).
 *
 * The saving comes from skipping its STEPS, never the job, because the job's
 * name is a REQUIRED status check. A required check that does not report leaves
 * the PR waiting on "Expected — waiting for status" forever, which is
 * indistinguishable from slow CI and cannot be diagnosed from inside the PR.
 * `paths:`/`paths-ignore:` on this job is therefore permanently forbidden, and
 * that is what the first test here pins.
 *
 * The second pins the property that makes the skip SAFE rather than merely
 * cheap: the detection must fail OPEN. `run=true` is the initialiser, and only
 * a positive docs-only determination flips it. An API outage, a force-push, an
 * unknown event — all run the full suite. The predicate itself is exercised as
 * shell (bash, matching the runner) rather than re-implemented here; note the
 * trap found while writing it: the same predicate returns the WRONG answer for
 * mixed docs+code under zsh, so a local harness must run bash or it reports a
 * failure the runner would never have.
 */
describe("e2e conditional skip", () => {
  const e2e = allJobs.find((j) => j.name === "playwright e2e (guild-app)");

  it("self-check: the e2e job is found and still required", () => {
    expect(e2e).toBeDefined();
    expect(e2e!.body).toContain("playwright");
  });

  it("NEVER carries a paths filter — it is a required check, and a skipped required check wedges the PR", () => {
    const body = stripComments(e2e!.body);
    expect(body).not.toMatch(/^\s*paths(-ignore)?:/m);
  });

  it("the whole workflow carries no paths filter either (same wedge, wider blast radius)", () => {
    const src = stripComments(
      readFileSync(join(WORKFLOWS, "test.yml"), "utf8").split(/^jobs:\s*$/m)[0],
    );
    expect(src).not.toMatch(/^\s*paths(-ignore)?:/m);
  });

  it("defaults to RUNNING — the skip is opt-in, so a detection failure costs a minute, not a regression", () => {
    const body = stripComments(e2e!.body);
    // The initialiser must be `run=true`, and it must appear before the flip.
    const init = body.indexOf("run=true");
    const flip = body.indexOf("run=false");
    expect(init).toBeGreaterThan(-1);
    expect(flip).toBeGreaterThan(-1);
    expect(init).toBeLessThan(flip);
  });

  it("guards every expensive step, so a skipped run cannot half-execute", () => {
    const body = e2e!.body;
    for (const step of [
      "install",
      "apply schema",
      "install playwright browsers",
      "e2e tests",
    ]) {
      const at = body.indexOf(`- name: ${step}`);
      expect(at, `step "${step}" not found`).toBeGreaterThan(-1);
      // the guard sits within the step's own block, before the next `- name:`
      const next = body.indexOf("\n      - ", at + 1);
      const block = body.slice(at, next === -1 ? undefined : next);
      expect(block, `step "${step}" is not guarded`).toContain(
        "steps.scope.outputs.run == 'true'",
      );
    }
  });

  it("only docs/**.md is skippable — the pattern must not widen to docs/*.json or root markdown", () => {
    // ASSET-REGISTRY.json lives under docs/ and is load-bearing for CHECK 8.
    expect(e2e!.body).toContain("'^docs/.+\\.md$'");
  });

  // Added after an adversarial screen (2026-08-17) showed the tests above pin
  // STRING PRESENCE, not behaviour: three single-token edits to the workflow all
  // passed 14/14. The nastiest was renaming `id: scope` — the guards then
  // reference a step that does not exist, `steps.scope.outputs.run` is empty,
  // EVERY guarded step skips, and the job reports SUCCESS having run zero
  // browser tests. A required check, green and empty. This ties the two halves
  // together so that rename fails here instead.
  it("the guards reference the step id that actually exists (a rename silently empties the job)", () => {
    const body = e2e!.body;
    const referenced = [...body.matchAll(/steps\.([A-Za-z0-9_-]+)\.outputs\.run/g)].map((m) => m[1]);
    expect(referenced.length, "no guard references a step output").toBeGreaterThan(0);
    const declared = [...body.matchAll(/^\s*id:\s*([A-Za-z0-9_-]+)\s*$/gm)].map((m) => m[1]);
    for (const id of new Set(referenced)) {
      expect(declared, `guards reference steps.${id} but no step declares that id`).toContain(id);
    }
  });

  it("the scope step declares an output the guards can read", () => {
    // `echo "run=$run" >> "$GITHUB_OUTPUT"` is the only thing that makes
    // steps.<id>.outputs.run exist. Drop it and every guard evaluates empty.
    expect(e2e!.body).toMatch(/run=\$run"?\s*>>\s*"?\$GITHUB_OUTPUT/);
  });

  it("declares pull-requests: read — without it the PR-side detector 403s and the saving is zero", () => {
    const src = readFileSync(join(WORKFLOWS, "test.yml"), "utf8");
    const head = src.split(/^jobs:\s*$/m)[0];
    expect(head).toMatch(/^permissions:/m);
    expect(head).toMatch(/pull-requests:\s*read/);
  });

  // ── The predicate, EXECUTED ────────────────────────────────────────────────
  // The tests above pin strings. An adversarial screen showed that is not
  // enough: deleting one character (`grep -qvE` -> `grep -qE`) inverts the
  // predicate so the browser suite skips on every pure-CODE change, and every
  // string-shaped test still passed. Nothing short of running it catches that.
  //
  // So: lift the scope step's shell out of the YAML, substitute the `${{ }}`
  // expressions, stub `gh` with a script that prints a controlled file list, and
  // run the real thing under BASH (the runner's shell — the same predicate gives
  // the WRONG answer for mixed docs+code under zsh, so the shell is part of the
  // contract).
  //
  // The `gh` stub is minted ONCE, at module scope, and reads its file list from
  // the environment instead of having it baked in. That is not tidiness — it is
  // the fix for a real flake, and the measurement is worth keeping because the
  // obvious diagnosis is wrong. Measured 2026-08-20 on this Mac: a bash script
  // written to a fresh temp dir and run as `bash s.sh` costs ~10ms, but a
  // freshly-written EXECUTABLE costs ~330ms the first time it is exec'd, while
  // re-running the SAME file is ~13ms. (That 25x gap on first exec only is the
  // signature of macOS's on-first-execution scan, but only the timings above
  // were measured, not the mechanism — and only on macOS.)
  // The old version minted a new `gh` per call, so every call paid that scan:
  // ~370ms each, ~1.85s for the five calls in the "runs the suite" test below.
  // Isolated that passed; under the full 87-file suite's parallel pool it
  // crossed vitest's 5000ms default `testTimeout` and failed 3 of 3 runs with
  // "Test timed out in 5000ms" — a timeout, never an assertion, on a tree with
  // no source changes. One stub takes the same five calls to ~0.4s.
  //
  // Note what was NOT the cost, since it is the tempting answer: extracting and
  // substituting the script out of the YAML is ~2ms of that ~370ms, so caching
  // it would have fixed nothing. No timeout is raised here on purpose — a
  // generous `it()` timeout would also hide this cost coming back.
  const stubDir = mkdtempSync(join(tmpdir(), "scope-"));
  const ghPath = join(stubDir, "gh");
  // Quoted expansion, so a multi-line list arrives as multiple lines and an
  // unset/empty one prints a single blank line — byte-identical to what the
  // per-call `printf '%s\n' 'a' 'b'` produced, including the empty case that
  // the fail-OPEN test depends on. Passing the list through the environment
  // rather than interpolating it also stops a filename containing a quote from
  // rewriting the stub.
  writeFileSync(ghPath, `#!/usr/bin/env bash\nprintf '%s\\n' "\${SCOPE_FILES-}"\n`);
  chmodSync(ghPath, 0o755);
  // The ONE scan the shared stub still owes is paid here, under the 60s
  // hookTimeout, not inside whichever EXECUTED test runs first. That scan is
  // serialised machine-wide (measured 2026-09-30, see
  // reconcile-cron-halt-guard.test.ts's stub comment): 0.3s alone, but it
  // queues behind every fresh stub any other file or session is exec'ing.
  // Three full-suite runs put the first EXECUTED test at up to 4.94s, and a
  // fourth, under peer sessions' concurrent suites, timed it out at 5000ms.
  // This still raises no timeout: a per-call stub coming back would pay its
  // scans inside the tests, as before, and fail the same way.
  beforeAll(() => {
    execFileSync(ghPath, [], { env: { ...process.env, SCOPE_FILES: "" } });
  });
  let callN = 0;

  function runPredicate(files: string[], event = "pull_request"): string {
    const src = readFileSync(join(WORKFLOWS, "test.yml"), "utf8");
    const jobsBlock = src.split(/^jobs:\s*$/m)[1];
    const at = jobsBlock.indexOf("id: scope");
    expect(at, "scope step not found").toBeGreaterThan(-1);
    const runAt = jobsBlock.indexOf("run: |", at);
    const after = jobsBlock.slice(runAt + "run: |".length);
    // the block runs until a line that is less indented than its body
    const lines = after.split("\n").slice(1);
    const body: string[] = [];
    for (const l of lines) {
      if (l.trim() !== "" && !l.startsWith("          ")) break;
      body.push(l.replace(/^ {10}/, ""));
    }
    const script = body
      .join("\n")
      .replace(/\$\{\{\s*github\.event_name\s*\}\}/g, event)
      .replace(/\$\{\{\s*github\.repository\s*\}\}/g, "o/r")
      .replace(/\$\{\{\s*github\.event\.pull_request\.number\s*\}\}/g, "1")
      .replace(/\$\{\{\s*github\.event\.before\s*\}\}/g, "aaaa")
      .replace(/\$\{\{\s*github\.sha\s*\}\}/g, "bbbb")
      .replace(/\$\{\{[^}]*\}\}/g, "x");

    // Per-call names, not one shared pair: the stub dir is now shared across
    // calls, and `it.concurrent` on any test here would otherwise let two runs
    // read each other's $GITHUB_OUTPUT. These are plain files, so they cost
    // nothing — only the exec'd stub above pays the scan.
    const n = ++callN;
    const outFile = join(stubDir, `out-${n}`);
    writeFileSync(outFile, "");
    const scriptPath = join(stubDir, `s-${n}.sh`);
    writeFileSync(scriptPath, script);
    execFileSync("bash", [scriptPath], {
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH}`,
        GITHUB_OUTPUT: outFile,
        SCOPE_FILES: files.join("\n"),
      },
      encoding: "utf8",
    });
    const out = readFileSync(outFile, "utf8");
    return out.match(/run=(\w+)/)?.[1] ?? "MISSING";
  }

  it("EXECUTED: skips only when every changed path is docs/**.md", () => {
    expect(runPredicate(["docs/PROJECT-STATE.md"])).toBe("false");
    expect(runPredicate(["docs/a.md", "docs/archive/b.md"])).toBe("false");
  });

  it("EXECUTED: runs the suite for anything that could break it", () => {
    // The inverted-grep mutation makes each of these return "false".
    expect(runPredicate(["guild-app/src/app/page.tsx"])).toBe("true");
    expect(runPredicate(["docs/a.md", "guild-app/src/lib/gift.ts"])).toBe("true");
    expect(runPredicate(["docs/ASSET-REGISTRY.json"])).toBe("true");
    expect(runPredicate([".github/workflows/test.yml"])).toBe("true");
    expect(runPredicate(["README.md"])).toBe("true");
  });

  it("EXECUTED: fails OPEN — an empty or failed lookup runs the suite", () => {
    expect(runPredicate([])).toBe("true");
    expect(runPredicate(["docs/a.md"], "workflow_dispatch")).toBe("true");
  });

  it("self-check: each rule fires on a job that violates it", () => {
    const withPaths = "  e2e:\n    paths-ignore:\n      - 'docs/**'\n";
    expect(stripComments(withPaths)).toMatch(/^\s*paths(-ignore)?:/m);

    const failClosed = "run=false\nif ...; then run=true; fi";
    expect(failClosed.indexOf("run=true")).toBeGreaterThan(
      failClosed.indexOf("run=false"),
    );

    const unguarded = "- name: e2e tests\n        run: bun run test:e2e";
    expect(unguarded).not.toContain("steps.scope.outputs.run == 'true'");
  });
});

/**
 * ── The public-snapshot CI template ───────────────────────────────────────────
 *
 * `publish/ci-public-test.yml` is the public-repo trim of
 * `.github/workflows/test.yml` (see `publish/CI-PUBLIC.md`, Gap C, ruling N3 #4).
 * It is a dormant TEMPLATE — no repo runs it today — which is exactly why it
 * rots: nothing goes red when the file it mirrors moves out from under it.
 *
 * It rotted twice before this gate existed, both times silently:
 *
 *   • `#496` (2026-09-03/07) deleted the `bot-syntax` job from the private file.
 *     The template kept it for five days.
 *   • `#524` (2026-09-07 08:22) added the `alert-policy` job to the private file.
 *     The trim pass the NEXT DAY (`#545`, 2026-09-08 08:31) did not notice, so
 *     the template shipped without it — and `CI-PUBLIC.md`'s job table had no row
 *     for it either — until 2026-09-18. Both of `CI-PUBLIC.md`'s "net" counts
 *     were recomputed inside that window, from the TABLE rather than from the
 *     workflow, so each restated a wrong number more confidently than the last.
 *
 * So the invariant is DERIVED, never restated: the template's job set must equal
 * the private file's job set MINUS the trims `CI-PUBLIC.md` documents as
 * whole-job removals. Adding a job to `test.yml` fails this test until the
 * template gets it or the trim list explains why it does not — which is the
 * decision `CI-PUBLIC.md` exists to record.
 *
 * Step-level trims were NOT checked here until 2026-09-30, and that is how the
 * template lost agent-mcp's build step. They are now data in
 * `publish/gen-ci-public-test.mjs` (TRIMS), and the byte-for-byte test below makes
 * the template exactly that generator's output. The generator refuses a trim whose
 * target was renamed, and a surviving step that names an EXCLUDEd file.
 */
// publish/** never ships (isIncluded()'s first rule) — this whole describe
// compares the private test.yml against a template that has no public-tree
// counterpart to compare it TO, by design, not by an EXCLUDE gap.
const PRIV_CI_TEMPLATE = privateInputs("publish/ci-public-test.yml", "publish/gen-ci-public-test.mjs");

describe.skipIf(PRIV_CI_TEMPLATE.skip)("public-snapshot CI template (publish/ci-public-test.yml)", () => {
  const TEMPLATE = join(__dirname, "../../../publish/ci-public-test.yml");

  /**
   * The jobs `publish/CI-PUBLIC.md` documents as dropped WHOLE from the public
   * snapshot, each because it invokes a root script that stays EXCLUDE.
   * `bot-syntax` is deliberately NOT here: it is not a job in either file any
   * more, so listing it would re-create the very drift this gate is for.
   */
  const TRIMMED_WHOLE = ["publish-gate", "docs"];

  const privateJobs = parseJobs("test.yml").map((j) => j.id);
  const templateJobs = PRIV_CI_TEMPLATE.skip ? [] : parseJobs("ci-public-test.yml", TEMPLATE).map((j) => j.id);

  it("self-check: both files parse to a non-trivial job list", () => {
    // Without this the set comparison below passes vacuously on [] vs [] the
    // moment either file's `jobs:` key is reformatted.
    expect(privateJobs.length).toBeGreaterThan(5);
    expect(templateJobs.length).toBeGreaterThan(5);
    expect(privateJobs).toContain("alert-policy");
    // ...and the trim list must name jobs that actually exist to be trimmed.
    expect(TRIMMED_WHOLE.filter((t) => !privateJobs.includes(t))).toEqual([]);
  });

  it("ships every private job except the documented whole-job trims", () => {
    const expected = privateJobs.filter((id) => !TRIMMED_WHOLE.includes(id));
    // Order matters too: the template is meant to be a readable diff against the
    // private file, and a reordered job set makes that diff unreadable.
    expect(templateJobs).toEqual(expected);
  });

  it("drops the trimmed jobs, and only those", () => {
    for (const id of TRIMMED_WHOLE) {
      expect(templateJobs, `${id} must not ship publicly`).not.toContain(id);
    }
  });

  it("is byte-for-byte what publish/gen-ci-public-test.mjs generates from test.yml", async () => {
    // The job-set check above cannot see a missing STEP. That is how the template went
    // without agent-mcp's P1 build step (2026-09-28 → 09-30), and a public run would have
    // failed 3 tarball tests on day one (publish/REHEARSAL-2026-09-30.md). The generator
    // owns every step-level trim, and refuses to run if a trim target was renamed or a
    // surviving step reaches an EXCLUDEd path. Calls generate() directly: a spawned CLI
    // relies on import.meta.main, which older Node lacks (it would exit 0 having done nothing).
    // A real `import()` of this path — even dynamic, even behind this describe's
    // skipIf — gets resolved by Vite's import-analysis at TRANSFORM time (it scans
    // every import() call in the file, unconditional on runtime guards), so a
    // literal specifier here fails the whole file to collect the moment publish/
    // is absent (it never ships). Run in a child `node` process instead, the same
    // way launch-check-dist-dir.test.ts calls honest-copy.mjs from a fresh
    // process: the import lives inside a JS *string*, invisible to Vite's parser.
    const genUrl = pathToFileURL(join(__dirname, "../../../publish/gen-ci-public-test.mjs")).href
    const out = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", `import { generate } from ${JSON.stringify(genUrl)}; process.stdout.write(generate());`],
      { encoding: "utf8" },
    )
    expect(
      out === readFileSync(TEMPLATE, "utf8"),
      "publish/ci-public-test.yml is stale — run `node publish/gen-ci-public-test.mjs` and commit the result",
    ).toBe(true)
  });

  it("self-check: the set comparison fails on a job added to one file only", () => {
    // Proves the assertion above bites rather than comparing something to
    // itself — the failure mode that made both prose counts wrong.
    const drifted = [...templateJobs, "some-new-job"];
    expect(drifted).not.toEqual(privateJobs.filter((id) => !TRIMMED_WHOLE.includes(id)));
  });
});

/**
 * No required-check COUNT in the workflow prose.
 *
 * `.github/workflows/test.yml` used to state the count twice (the header's cost
 * note and the e2e job's `paths-ignore` warning), and the template copies both.
 * On 2026-09-08 the header was corrected from nine to eight and the e2e copy 300
 * lines below it was not — it still read NINE on 2026-09-18. This test then pinned
 * both to `REQUIRED.length`, and by 2026-10-02 both said eight while main required
 * 15. The same comments also ship as the public repository's test.yml, whose
 * required set is its own (the twelve job checks plus `ops/private-gates`). So
 * since 2026-10-02 the prose names no count at all, and this test holds it there,
 * in both trees: test.yml always, and the template wherever it exists.
 */
// publish/** never ships (isIncluded()'s first rule), so the template is read only
// in the private tree; test.yml is read everywhere.
const PRIV_PROSE = privateInputs("publish/ci-public-test.yml");

describe("no required-check count in the workflow prose", () => {
  const WORDS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  const NUMBER_WORD = /\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi;

  /**
   * Normalise a YAML file to flat prose: strip `#` comment markers and collapse
   * whitespace, so a sentence wrapped across comment lines reads as one string.
   * Without this, "eight of them are required status\n# checks on main" never
   * matches and the whole gate passes vacuously.
   */
  const toProse = (text: string) =>
    text
      .split("\n")
      .map((l) => l.replace(/^\s*#\s?/, ""))
      .join(" ")
      .replace(/\s+/g, " ");

  /** Every "required check" / "required status check" phrase in the prose. */
  const REQUIRED_PHRASE = /required\s+(?:status\s+)?checks?/gi;

  /** Every spelled-out count that qualifies a required-check phrase. */
  function statedCounts(prose: string): number[] {
    const out: number[] = [];
    for (const m of prose.matchAll(REQUIRED_PHRASE)) {
      // The nearest preceding number word, within one sentence's reach.
      const before = prose.slice(Math.max(0, m.index - 120), m.index);
      const words = [...before.matchAll(NUMBER_WORD)];
      if (words.length === 0) continue; // e.g. "is not a required status check"
      out.push(WORDS[words[words.length - 1][1].toLowerCase()]);
    }
    return out;
  }

  const FILES: Array<[string, string]> = [
    ["test.yml", join(WORKFLOWS, "test.yml")],
    ...(PRIV_PROSE.skip
      ? []
      : [["ci-public-test.yml", join(__dirname, "../../../publish/ci-public-test.yml")] as [string, string]]),
  ];

  it("self-check: the scrape reads a wrapped comment sentence as one phrase", () => {
    // The exact shape that defeats a line-by-line regex.
    expect(statedCounts(toProse("# nine of them are required status\n# checks on main"))).toEqual([9]);
    expect(statedCounts(toProse("# It is one of the EIGHT\n# REQUIRED status checks on main"))).toEqual([8]);
    expect(statedCounts(toProse("# eight of them are required checks"))).toEqual([8]);
    // ...and does not invent a count where the phrase carries none.
    expect(statedCounts(toProse("# it is not a required status check on main"))).toEqual([]);
  });

  it("self-check: the files still talk about required checks, so the scan has material", () => {
    // Without this, rewording every mention away would pass the test below vacuously.
    for (const [label, path] of FILES) {
      const mentions = [...toProse(readFileSync(path, "utf8")).matchAll(REQUIRED_PHRASE)].length;
      expect(mentions, `${label} no longer mentions a required check at all`).toBeGreaterThanOrEqual(3);
    }
  });

  it("no prose states how many checks are required (the count differs by repository)", () => {
    for (const [label, path] of FILES) {
      expect(statedCounts(toProse(readFileSync(path, "utf8"))), `${label} states a required-check count`).toEqual([]);
    }
  });
});

/**
 * A gated workflow must watch its OWN file.
 *
 * scrypto.yml, formal.yml and npm-lockfile.yml run their heavy jobs only when a PR
 * touches the paths their `changes` job lists, and their `... gate` job passes on
 * `skipped`. Before 2026-10-06 only npm-lockfile.yml listed itself, so the weekly
 * Dependabot github-actions group (or a hand edit to a cargo step or the Apalache
 * cache key) skipped the scrypto and formal jobs, merged green, and the broken
 * workflow first ran on the next escrow PR. The detection script is EXECUTED here,
 * lifted from the YAML, in a throwaway git repo — a string match on the pathspec
 * would pass a quoting mistake the runner would not.
 */
const gatedWorkflows = workflowFiles.filter((f) => parseJobs(f).some((j) => j.id === "changes"));

/** The `run: |` script of the `changes` job's `id: diff` step, dedented. */
function changesScript(file: string): string {
  const job = parseJobs(file).find((j) => j.id === "changes")!;
  const at = job.body.indexOf("id: diff");
  if (at === -1) throw new Error(`${file}: changes job has no \`id: diff\` step`);
  const runAt = job.body.indexOf("run: |", at);
  if (runAt === -1) throw new Error(`${file}: the diff step has no \`run: |\` block`);
  const lines = job.body.slice(runAt + "run: |".length).split("\n").slice(1);
  const body: string[] = [];
  for (const l of lines) {
    if (l.trim() !== "" && !l.startsWith("          ")) break;
    body.push(l.replace(/^ {10}/, ""));
  }
  return body.join("\n");
}

/** The `push:` trigger block of a workflow's `on:` section ("" if it has none). */
function pushTrigger(file: string): string {
  const head = stripComments(readFileSync(join(WORKFLOWS, file), "utf8").split(/^jobs:\s*$/m)[0]);
  const m = head.match(/^ {2}push:\s*\n((?: {4,}.*\n|\s*\n)*)/m);
  return m ? m[1] : "";
}

describe("change detection watches its own workflow file", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
      },
    }).trim();

  let repo = "";
  let scratch = "";
  let base = "";
  let n = 0;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "changes-"));
    scratch = mkdtempSync(join(tmpdir(), "changes-run-"));
    git(repo, "init", "-q");
    writeFileSync(join(repo, "README.md"), "base\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-q", "-m", "base");
    base = git(repo, "rev-parse", "HEAD");
  });

  /** Run `file`'s detection for a PR whose only change is `path`; returns run=… */
  function detect(file: string, path: string): string {
    const k = ++n;
    git(repo, "checkout", "-q", "--detach", base);
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), `change ${k}\n`);
    git(repo, "add", path);
    git(repo, "commit", "-q", "-m", `change ${k}`);
    const out = join(scratch, `out-${k}`);
    writeFileSync(out, "");
    const script = join(scratch, `s-${k}.sh`);
    writeFileSync(script, changesScript(file));
    execFileSync("bash", [script], {
      cwd: repo,
      env: { ...process.env, EVENT: "pull_request", BASE_SHA: base, GITHUB_OUTPUT: out },
      encoding: "utf8",
    });
    return readFileSync(out, "utf8").match(/run=(\w+)/)?.[1] ?? "MISSING";
  }

  it("self-check: the three gated workflows are found", () => {
    expect([...gatedWorkflows].sort()).toEqual(["formal.yml", "npm-lockfile.yml", "scrypto.yml"]);
  });

  it("EXECUTED: a PR that changes only the workflow file runs its jobs", () => {
    for (const f of gatedWorkflows) {
      expect(detect(f, `.github/workflows/${f}`), f).toBe("true");
    }
  });

  it("EXECUTED self-check: an unrelated change still skips (the detection bites)", () => {
    for (const f of gatedWorkflows) {
      expect(detect(f, "unrelated/notes.txt"), f).toBe("false");
    }
  });

  it("a main push that changes only the workflow file runs it too (push paths list it)", () => {
    for (const f of gatedWorkflows) {
      const push = pushTrigger(f);
      expect(push, `${f} has no push trigger`).not.toBe("");
      if (/^\s+paths:/m.test(push)) {
        expect(push, `${f}'s push paths omit its own file`).toContain(`.github/workflows/${f}`);
      }
    }
  });
});

/**
 * secret-scan.yml: every branch push is scanned (the repository is public, so a
 * pushed branch is public with or without a PR), and the gitleaks binary is checked
 * against a digest pinned in the workflow, not only against a checksums.txt from
 * the same release as the binary.
 */
describe("secret-scan trigger and gitleaks pin", () => {
  const gitleaks = allJobs.find((j) => j.name === "gitleaks (secret scan)")!;
  const body = stripComments(gitleaks.body);

  it("the push trigger is not limited to main", () => {
    const push = pushTrigger("secret-scan.yml");
    expect(push).not.toBe("");
    expect(push).not.toMatch(/\bmain\b/);
    expect(push).not.toMatch(/^\s+paths(-ignore)?:/m);
    expect(push).toMatch(/branches:\s*\[\s*'\*\*'\s*\]/);
  });

  it("pins a 64-hex GITLEAKS_SHA256 beside GITLEAKS_VERSION", () => {
    expect(body).toMatch(/^\s+GITLEAKS_VERSION:\s*\d+\.\d+\.\d+\s*$/m);
    expect(body).toMatch(/^\s+GITLEAKS_SHA256:\s*[0-9a-f]{64}\s*$/m);
  });

  it("checks the asset against the pinned digest, keeps the checksums.txt cross-check, and both run before extraction", () => {
    const pinned = body.indexOf('echo "${GITLEAKS_SHA256}  ${asset}" | sha256sum -c -');
    const crossCheck = body.indexOf('grep -F "$asset" checksums.txt | sha256sum -c -');
    const extract = body.indexOf('tar -xzf "$asset"');
    expect(pinned, "pinned-digest check missing").toBeGreaterThan(-1);
    expect(crossCheck, "checksums.txt cross-check missing").toBeGreaterThan(-1);
    expect(extract).toBeGreaterThan(Math.max(pinned, crossCheck));
    // ...inside a step that stops at the first failed check.
    const install = body.indexOf("- name: install gitleaks");
    const strict = body.indexOf("set -euo pipefail", install);
    expect(install).toBeGreaterThan(-1);
    expect(strict).toBeGreaterThan(install);
    expect(strict).toBeLessThan(pinned);
  });
});
