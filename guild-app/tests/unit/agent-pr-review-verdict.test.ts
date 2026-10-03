import { describe, it, expect, beforeAll } from "vitest";
import {
  readScript,
  runWorkflowScript,
  loadPureRegion,
  THROW,
  type AgentCall,
  type PipelineMode,
} from "../support/workflow-script-harness";
import { privateInputs } from "../support/private-input";

/**
 * Gate on `.claude/workflows/agent-pr-review.js` — this repo's standing pre-merge
 * review for agent-built PRs ("green CI is not evidence").
 *
 * THE DEFECT (observed, not hypothetical). 2026-09-17, run `wf_c7932b5e-879` on
 * PR #704: the account hit its session usage limit, all five agents died, and the
 * workflow returned
 *   {"pr":704,"verdict":"MERGE","screened":false,"screen":null,"confirmed":[],
 *    "survival":"0/0","lens_verdicts":[]}
 * Dead lenses were `.filter(Boolean)`ed away; no lenses meant no findings; no
 * findings meant MERGE. A dead REFUTER failed open the same way, by dropping the
 * finding it was meant to judge.
 *
 * THE GATE RULE (ruled 2026-09-18, measured on the run records). The screen
 * prompt always said "yes, deep pass" for a plausibly mergeable PR; 7 of 7
 * screens that stopped a run on 2026-09-16/17 returned MERGE / NONE / "no", and
 * `force` had been passed in 0 of 22 runs. So the rule moved into the script: the
 * screen may end a run ONLY with a REWORK it judges dispositive — one agent may
 * block a merge, never approve one — and a HIGH/CRITICAL beside any mergeable
 * verdict is self-contradictory. The "screen gate" block pins both, and the
 * mutation block proves each guard is load-bearing on its own.
 *
 * HOW THIS IS TESTED. The script cannot be imported (top-level `return`, injected
 * globals), so `tests/support/workflow-script-harness.ts` runs its TEXT against
 * fake agents. Every scenario below therefore goes through the real script end to
 * end — screen gate, pipeline stages, refuter fan-out, verdict — not a copy of it.
 * A dead agent is delivered in every shape the runtime could plausibly use
 * (`SHAPES`), because the reference does not pin one down.
 *
 * MEASURED ONCE, BY HAND, 2026-09-18 (not re-run here — the pre-fix file is no
 * longer in the tree): the pre-fix script (`git show 3d9f799:…`) under this same
 * harness, all agents dead, returns the object above BYTE FOR BYTE in three of the
 * four shapes. The fourth (pipeline "pass-null" + a null-returning lens) yields
 * `lens_verdicts: ["claims-vs-code:null(0/0)", …]` instead of `[]`, so the real
 * runtime dropped the dead lenses' pipeline items rather than handing `null` on.
 *
 * WHAT THIS DOES NOT PROVE. That the real runtime turns a dead subagent into a
 * `null` / a dropped item at all. That wiring was observed once, in
 * `wf_c7932b5e-879`, and is documented in the `workflow-authoring` reference; it
 * is modelled here, never re-executed. No real agent runs in this file.
 */

type Finding = { title: string; severity: string; file: string; why: string; evidence: string };
type Verdict = {
  pr: number;
  verdict: string;
  complete: boolean;
  depth: string;
  summary: string;
  screened: boolean;
  screen: unknown;
  screen_problem: string | null;
  escalated_because: string | null;
  confirmed: Array<Finding & { status: string; lens: string; refute: unknown }>;
  unrefuted: Array<Finding & { status: string; lens: string; refute: unknown }>;
  dead_lenses: Array<{ lens: string; reason: string }>;
  counts: {
    lenses: { expected: number; completed: number; dead: number };
    findings: { raw: number; refuted: number; confirmed: number; unrefuted: number };
  };
  survival: string;
  lens_verdicts: string[];
};

// .claude/** stays EXCLUDE at the open-source flip (publish/MANIFEST.md) — this
// whole file runs the real .claude/workflows/agent-pr-review.js end to end, so it
// is private-tree-only by design, not an EXCLUDE gap (publish/REHEARSAL-2026-09-29.md).
const PRIV = privateInputs(".claude/workflows/agent-pr-review.js");
const SCRIPT = PRIV.skip ? "" : readScript();
const MERGEABLE = ["MERGE", "MERGE_WITH_FIXES"];

/** Marks an agent as dead. HOW it dies is the scenario's `death`. */
const DEAD = Symbol("dead");
type Death = "null" | "throw";

const SHAPES: Array<{ mode: PipelineMode; death: Death }> = [
  { mode: "drop-null", death: "null" },
  { mode: "drop-null", death: "throw" },
  { mode: "pass-null", death: "null" },
  { mode: "pass-null", death: "throw" },
];

const finding = (title: string, severity: string): Finding => ({
  title,
  severity,
  file: "guild-app/src/x.ts",
  why: "input -> wrong outcome",
  evidence: "x.ts:1",
});

const cleanLens = { verdict: "MERGE", findings: [] as Finding[] };
const escalatingScreen = {
  verdict: "MERGE",
  highest_severity: "NONE",
  deep_review_worth_it: "yes",
  reason: "plausibly mergeable — exactly where the deep pass earns its keep",
  dispositive_defects: [] as string[],
};

type World = {
  screen?: unknown;
  lens?: (key: string) => unknown;
  refute?: (title: string) => unknown;
  death?: Death;
  mode?: PipelineMode;
  args?: unknown;
  source?: string;
};

async function review(w: World = {}) {
  const death = w.death ?? "null";
  const die = death === "throw" ? THROW : null;
  const agent = (c: AgentCall): unknown => {
    // The screen is awaited at the top level of the script, so a throw there aborts
    // the run (tested separately). A dead screen is always the documented `null`.
    if (c.label === "screen") return "screen" in w ? (w.screen === DEAD ? null : w.screen) : escalatingScreen;
    if (c.label.startsWith("review:")) {
      const out = w.lens ? w.lens(c.label.slice("review:".length)) : cleanLens;
      return out === DEAD ? die : out;
    }
    if (c.label.startsWith("refute:")) {
      const out = w.refute ? w.refute(c.label.slice("refute:".length)) : { verdict: "CONFIRMED", reasoning: "reproduced" };
      return out === DEAD ? die : out;
    }
    throw new Error(`unexpected agent label: ${c.label}`);
  };
  const run = await runWorkflowScript(w.source ?? SCRIPT, {
    args: w.args ?? { pr: 704 },
    agent,
    pipelineMode: w.mode ?? "drop-null",
  });
  return { r: run.result as Verdict, logs: run.logs, calls: run.calls };
}

const lensCalls = (calls: AgentCall[]) => calls.filter((c) => c.label.startsWith("review:"));

let LENS_KEYS: string[] = [];

beforeAll(async () => {
  if (PRIV.skip) return;
  const { calls } = await review();
  LENS_KEYS = lensCalls(calls).map((c) => c.label.slice("review:".length));
});

// ---------------------------------------------------------------------------
describe.skipIf(PRIV.skip)("harness self-checks — the assertions below can fail", () => {
  it("discovers the lenses from the script itself, and there is at least one", () => {
    expect(LENS_KEYS.length).toBeGreaterThanOrEqual(1);
    expect(new Set(LENS_KEYS).size).toBe(LENS_KEYS.length);
  });

  // The non-vacuity anchor. If the harness could never produce MERGE, every
  // "is not MERGE" assertion in this file would pass for the wrong reason.
  it.each(SHAPES)("a healthy run DOES return a complete MERGE ($mode / $death)", async ({ mode, death }) => {
    const { r, calls } = await review({ mode, death });
    expect(r.verdict).toBe("MERGE");
    expect(r.complete).toBe(true);
    expect(r.depth).toBe("full");
    expect(r.counts.lenses).toEqual({ expected: LENS_KEYS.length, completed: LENS_KEYS.length, dead: 0 });
    expect(r.dead_lenses).toEqual([]);
    expect(calls.filter((c) => c.label === "screen")).toHaveLength(1);
  });

  it("requires args.pr, as the script always has", async () => {
    await expect(review({ args: {} })).rejects.toThrow(/args\.pr is required/);
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(PRIV.skip)("2026-09-17 defect: every agent dead must not read as a pass", () => {
  it.each(SHAPES)("all five agents dead → INCOMPLETE, never MERGE ($mode / $death)", async ({ mode, death }) => {
    const { r, logs } = await review({ screen: DEAD, lens: () => DEAD, mode, death });

    expect(r.verdict).toBe("INCOMPLETE");
    expect(MERGEABLE).not.toContain(r.verdict);
    expect(r.complete).toBe(false);
    expect(r.counts.lenses).toEqual({ expected: LENS_KEYS.length, completed: 0, dead: LENS_KEYS.length });
    expect(r.counts.findings).toEqual({ raw: 0, refuted: 0, confirmed: 0, unrefuted: 0 });
    expect(r.dead_lenses.map((d) => d.lens)).toEqual(LENS_KEYS);

    // The two fields that made the original result skimmable as clean.
    expect(r.survival).not.toBe("0/0");
    expect(r.survival).toMatch(/INCOMPLETE/);
    expect(r.lens_verdicts).toEqual(LENS_KEYS.map((k) => `${k}:DEAD`));

    // The screen died too, and the result says so rather than showing a bare null.
    expect(r.screen).toBeNull();
    expect(r.screen_problem).toMatch(/no result/);

    const last = logs[logs.length - 1];
    expect(last).toMatch(/INCOMPLETE/);
    expect(last).toMatch(/NO MERGE DECISION CAN BE READ FROM THIS RUN/);
    for (const k of LENS_KEYS) expect(last).toContain(k);
    expect(last).not.toMatch(/→ MERGE/);
  });

  it.each(SHAPES)("ONE dead lens among clean ones → INCOMPLETE naming it ($mode / $death)", async ({ mode, death }) => {
    for (const victim of LENS_KEYS) {
      const { r } = await review({ lens: (k) => (k === victim ? DEAD : cleanLens), mode, death });
      expect(r.verdict, victim).toBe("INCOMPLETE");
      expect(r.complete, victim).toBe(false);
      expect(r.dead_lenses.map((d) => d.lens), victim).toEqual([victim]);
      expect(r.counts.lenses, victim).toEqual({
        expected: LENS_KEYS.length,
        completed: LENS_KEYS.length - 1,
        dead: 1,
      });
      expect(r.summary, victim).toContain(victim);
      expect(r.lens_verdicts, victim).toHaveLength(LENS_KEYS.length);
      expect(r.lens_verdicts, victim).toContain(`${victim}:DEAD`);
    }
  });

  it.each(SHAPES)("a dead lens does not erase a CONFIRMED HIGH elsewhere: REWORK stands, flagged partial ($mode / $death)", async ({ mode, death }) => {
    const [first, ...rest] = LENS_KEYS;
    const { r, logs } = await review({
      lens: (k) => (k === first ? { verdict: "REWORK", findings: [finding("guard removed", "HIGH")] } : k === rest[0] ? DEAD : cleanLens),
      mode,
      death,
    });
    expect(r.verdict).toBe("REWORK");
    expect(r.complete).toBe(false);
    expect(r.confirmed.map((f) => f.title)).toEqual(["guard removed"]);
    expect(r.dead_lenses.map((d) => d.lens)).toEqual([rest[0]]);
    expect(r.summary).toMatch(/PARTIAL REVIEW/);
    expect(r.summary).toMatch(/NOT exhaustive/);
    expect(logs[logs.length - 1]).toContain(rest[0]);
  });

  it("a confirmed MEDIUM does not rescue a partial run into MERGE_WITH_FIXES", async () => {
    const [first, second] = LENS_KEYS;
    const { r } = await review({
      lens: (k) => (k === first ? { verdict: "MERGE_WITH_FIXES", findings: [finding("stale comment", "MEDIUM")] } : k === second ? DEAD : cleanLens),
    });
    expect(r.verdict).toBe("INCOMPLETE");
    expect(r.confirmed.map((f) => f.title)).toEqual(["stale comment"]);
  });

  it.each([
    ["no findings array", { verdict: "MERGE" }],
    ["verdict outside the enum", { verdict: "LGTM", findings: [] }],
    ["a finding with an unknown severity", { verdict: "MERGE", findings: [finding("x", "critical")] }],
    ["a finding that is not an object", { verdict: "MERGE", findings: ["oops"] }],
    ["a bare string", "MERGE"],
    ["an empty object", {}],
  ])("a MALFORMED lens result (%s) counts as dead, not as clean", async (_name, bad) => {
    const [victim] = LENS_KEYS;
    for (const mode of ["drop-null", "pass-null"] as const) {
      const { r } = await review({ lens: (k) => (k === victim ? bad : cleanLens), mode });
      expect(r.verdict).toBe("INCOMPLETE");
      expect(r.dead_lenses).toEqual([{ lens: victim, reason: "malformed lens result" }]);
    }
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(PRIV.skip)("refuter fail-open: a finding whose refuter died is KEPT, marked unrefuted", () => {
  const oneFinding = (sev: string) => (k: string) =>
    k === LENS_KEYS[0] ? { verdict: "MERGE_WITH_FIXES", findings: [finding("doc names a flag that does not exist", sev)] } : cleanLens;

  it.each(SHAPES)("dead refuter → finding survives in `unrefuted`, verdict INCOMPLETE ($mode / $death)", async ({ mode, death }) => {
    const { r } = await review({ lens: oneFinding("MEDIUM"), refute: () => DEAD, mode, death });
    expect(r.verdict).toBe("INCOMPLETE");
    expect(r.complete).toBe(false);
    expect(r.unrefuted).toHaveLength(1);
    expect(r.unrefuted[0]).toMatchObject({
      title: "doc names a flag that does not exist",
      severity: "MEDIUM",
      lens: LENS_KEYS[0],
      status: "UNREFUTED",
      refute: null,
    });
    expect(r.confirmed).toEqual([]); // nobody confirmed it, so it is not labelled confirmed
    expect(r.counts.findings).toEqual({ raw: 1, refuted: 0, confirmed: 0, unrefuted: 1 });
    expect(r.counts.lenses.dead).toBe(0); // the LENS completed; only its refuter died
    expect(r.summary).toMatch(/never refuter-judged/);
    expect(r.lens_verdicts[0]).toBe(`${LENS_KEYS[0]}:MERGE_WITH_FIXES(0/1, 1 unrefuted)`);
  });

  it.each([
    ["a verdict outside the enum", { verdict: "MAYBE", reasoning: "?" }],
    ["an empty object", {}],
    ["a bare string", "CONFIRMED"],
  ])("a MALFORMED refuter result (%s) is unrefuted too — not silently REFUTED", async (_n, bad) => {
    const { r } = await review({ lens: oneFinding("LOW"), refute: () => bad });
    expect(r.verdict).toBe("INCOMPLETE");
    expect(r.unrefuted.map((f) => f.title)).toEqual(["doc names a flag that does not exist"]);
  });

  it("an unrefuted HIGH neither vanishes nor becomes REWORK: nobody judged it", async () => {
    const { r } = await review({ lens: oneFinding("HIGH"), refute: () => DEAD });
    expect(r.verdict).toBe("INCOMPLETE");
    expect(r.unrefuted.map((f) => f.severity)).toEqual(["HIGH"]);
  });

  it("only the DEAD refuter's finding is unrefuted; its siblings keep their own verdicts", async () => {
    const lens = (k: string) =>
      k === LENS_KEYS[0]
        ? { verdict: "REWORK", findings: [finding("alpha", "LOW"), finding("bravo", "MEDIUM"), finding("charlie", "LOW")] }
        : cleanLens;
    const refute = (t: string) =>
      t === "alpha" ? { verdict: "CONFIRMED", reasoning: "y" } : t === "bravo" ? DEAD : { verdict: "REFUTED", reasoning: "n" };
    for (const death of ["null", "throw"] as const) {
      const { r } = await review({ lens, refute, death });
      expect(r.verdict).toBe("INCOMPLETE");
      expect(r.confirmed.map((f) => f.title)).toEqual(["alpha"]);
      expect(r.unrefuted.map((f) => f.title)).toEqual(["bravo"]);
      expect(r.counts.findings).toEqual({ raw: 3, refuted: 1, confirmed: 1, unrefuted: 1 });
    }
  });

  it("a CONFIRMED CRITICAL still returns REWORK when another refuter died — flagged partial", async () => {
    const lens = (k: string) =>
      k === LENS_KEYS[0] ? { verdict: "REWORK", findings: [finding("drain", "CRITICAL"), finding("typo", "LOW")] } : cleanLens;
    const { r } = await review({ lens, refute: (t) => (t === "drain" ? { verdict: "CONFIRMED", reasoning: "y" } : DEAD) });
    expect(r.verdict).toBe("REWORK");
    expect(r.complete).toBe(false);
    expect(r.unrefuted.map((f) => f.title)).toEqual(["typo"]);
    expect(r.summary).toMatch(/PARTIAL REVIEW/);
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(PRIV.skip)("complete runs keep their old meaning", () => {
  const lensWith = (fs: Finding[]) => (k: string) => (k === LENS_KEYS[0] ? { verdict: "REWORK", findings: fs } : cleanLens);

  it("every finding REFUTED → MERGE (refutation still kills findings)", async () => {
    const { r } = await review({
      lens: lensWith([finding("a", "HIGH"), finding("b", "LOW")]),
      refute: () => ({ verdict: "REFUTED", reasoning: "could not reproduce" }),
    });
    expect(r.verdict).toBe("MERGE");
    expect(r.complete).toBe(true);
    expect(r.counts.findings).toEqual({ raw: 2, refuted: 2, confirmed: 0, unrefuted: 0 });
    expect(r.survival).toBe("0/2");
  });

  it("CONFIRMED MEDIUM/LOW → MERGE_WITH_FIXES; CONFIRMED HIGH or CRITICAL → REWORK; sorted worst-first", async () => {
    const mwf = await review({ lens: lensWith([finding("low one", "LOW"), finding("medium one", "MEDIUM")]) });
    expect(mwf.r.verdict).toBe("MERGE_WITH_FIXES");
    expect(mwf.r.complete).toBe(true);
    expect(mwf.r.confirmed.map((f) => f.severity)).toEqual(["MEDIUM", "LOW"]);
    expect(mwf.r.survival).toBe("2/2");

    for (const sev of ["HIGH", "CRITICAL"]) {
      const rework = await review({ lens: lensWith([finding("low one", "LOW"), finding("bad one", sev)]) });
      expect(rework.r.verdict).toBe("REWORK");
      expect(rework.r.complete).toBe(true);
      expect(rework.r.confirmed[0].severity).toBe(sev);
    }
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(PRIV.skip)("screen gate", () => {
  const stop = (over: Record<string, unknown> = {}) => ({
    verdict: "REWORK",
    highest_severity: "HIGH",
    deep_review_worth_it: "no",
    reason: "dispositive and mechanically verifiable",
    dispositive_defects: ["x.sh:3 — bash -n x.sh"],
    ...over,
  });

  it("a well-formed dispositive REWORK stops the run, runs NO lenses, and says it was one agent", async () => {
    const { r, calls, logs } = await review({ screen: stop() });
    expect(lensCalls(calls)).toHaveLength(0);
    expect(r).toMatchObject({ verdict: "REWORK", screened: true, depth: "screen-only", complete: true, screen_problem: null, escalated_because: null });
    expect(r.counts.lenses).toEqual({ expected: 0, completed: 0, dead: 0 });
    expect(r.summary).toMatch(/did NOT run/);
    expect(logs[logs.length - 1]).toMatch(/screen-only/);
  });

  it("a REWORK stops at the screen whatever non-CRITICAL severity it reports — a wrong REWORK costs a second look, never a merge", async () => {
    for (const highest_severity of ["NONE", "LOW", "MEDIUM", "HIGH"]) {
      const { r, calls } = await review({ screen: stop({ highest_severity }) });
      expect(lensCalls(calls), highest_severity).toHaveLength(0);
      expect(r, highest_severity).toMatchObject({ verdict: "REWORK", screened: true, depth: "screen-only" });
    }
  });

  // RULED 2026-09-18: one agent may block a merge, never approve one. Until then a
  // well-formed MERGE / NONE / "no" ended the run with a one-agent MERGE — the shape 7 of
  // 7 screens returned on 2026-09-16/17 (#686 #687 #690 #691 #693 #702 #704), each
  // against the prompt's own "yes when plausibly mergeable" rule. This is that shape.
  it("the 7-of-7 shape — MERGE / NONE / 'no' — can no longer stop the run: it is well-formed, and it escalates", async () => {
    const seven = stop({ verdict: "MERGE", highest_severity: "NONE" });
    const { r, calls, logs } = await review({ screen: seven });
    expect(lensCalls(calls)).toHaveLength(LENS_KEYS.length);
    expect(r).toMatchObject({ screened: false, depth: "full", verdict: "MERGE", complete: true });
    expect(r.screen).toEqual(seven); // reported beside the lenses, not discarded
    expect(r.screen_problem).toBeNull(); // nothing wrong with it — it is simply not allowed to approve
    expect(r.escalated_because).toMatch(/never approve one/);
    expect(logs[logs.length - 2]).toMatch(/one agent may block a merge, never approve one/);
    expect(r.survival).not.toMatch(/screened out/);
  });

  it.each([
    ["MERGE_WITH_FIXES", "NONE"],
    ["MERGE_WITH_FIXES", "MEDIUM"],
    ["MERGE", "LOW"],
    ["MERGE", "MEDIUM"],
  ])("any mergeable verdict escalates — %s at %s with 'no' still runs every lens", async (verdict, highest_severity) => {
    const { r, calls } = await review({ screen: stop({ verdict, highest_severity }) });
    expect(lensCalls(calls)).toHaveLength(LENS_KEYS.length);
    expect(r).toMatchObject({ screened: false, depth: "full", screen_problem: null });
    expect(r.escalated_because).toContain(`the screen said ${verdict}`);
  });

  it("a MERGE-bound screen cannot rescue a run whose lenses died: still INCOMPLETE, never the screen's MERGE", async () => {
    const { r } = await review({ screen: stop({ verdict: "MERGE", highest_severity: "NONE" }), lens: () => DEAD });
    expect(r.verdict).toBe("INCOMPLETE");
    expect(r.screened).toBe(false);
  });

  it.each([
    ["verdict + worth-it only (the partial object that used to pass the gate)", { verdict: "MERGE", deep_review_worth_it: "no" }],
    ["a partial REWORK — only a well-formed screen may stop the run", { verdict: "REWORK", deep_review_worth_it: "no" }],
    ["worth-it only", { deep_review_worth_it: "no" }],
    ["verdict outside the enum", stop({ verdict: "SHIP_IT", highest_severity: "NONE" })],
    ["severity outside the enum", stop({ highest_severity: "high" })],
    ["no reason / defects", { verdict: "REWORK", highest_severity: "HIGH", deep_review_worth_it: "no" }],
    ["a bare string", "MERGE"],
    ["self-contradictory: clean MERGE while reporting a HIGH", stop({ verdict: "MERGE", highest_severity: "HIGH" })],
    ["self-contradictory: MERGE_WITH_FIXES while reporting a HIGH (ruled 2026-09-18)", stop({ verdict: "MERGE_WITH_FIXES", highest_severity: "HIGH" })],
    ["self-contradictory: MERGE_WITH_FIXES while reporting a CRITICAL", stop({ verdict: "MERGE_WITH_FIXES", highest_severity: "CRITICAL" })],
  ])("a malformed or contradictory screen (%s) can never yield a screened verdict — it falls through to the lenses", async (_n, bad) => {
    // …and with the lenses healthy the full pass decides:
    const healthy = await review({ screen: bad });
    expect(lensCalls(healthy.calls)).toHaveLength(LENS_KEYS.length);
    expect(healthy.r).toMatchObject({ screened: false, depth: "full", verdict: "MERGE", complete: true });
    expect(healthy.r.screen_problem).toBeTruthy();
    expect(healthy.r.escalated_because).toMatch(/screen unusable/);

    // …and with the lenses dead there is no MERGE to be had from the screen.
    const dead = await review({ screen: bad, lens: () => DEAD });
    expect(dead.r.verdict).toBe("INCOMPLETE");
    expect(dead.r.screened).toBe(false);
  });

  // FLIPPED ON PURPOSE, 2026-09-18. The previous version of this test pinned
  // MERGE_WITH_FIXES + HIGH + "no" as "stops at the screen" and said a ruling would flip
  // it. bigdev ruled the same day: a HIGH beside any mergeable verdict is a contradiction
  // (the deep pass maps a confirmed HIGH to REWORK), named in `screen_problem`. The
  // REWORK-only gate would escalate it anyway; this pins that the contradiction is
  // detected in its own right, so it survives if that gate rule is ever relaxed.
  it("MERGE_WITH_FIXES + HIGH is self-contradictory: named as such, and escalated", async () => {
    const { r, calls, logs } = await review({ screen: stop({ verdict: "MERGE_WITH_FIXES", highest_severity: "HIGH" }) });
    expect(lensCalls(calls)).toHaveLength(LENS_KEYS.length);
    expect(r.screened).toBe(false);
    expect(r.screen_problem).toBe("self-contradictory — verdict MERGE_WITH_FIXES while reporting a HIGH defect");
    expect(logs[logs.length - 2]).toMatch(/self-contradictory/);
  });

  it("the contradiction is a property of the pure screenProblem(), not of the gate around it", () => {
    const { screenProblem } = loadPureRegion(SCRIPT, ["screenProblem"]);
    for (const verdict of ["MERGE", "MERGE_WITH_FIXES"]) {
      for (const sev of ["HIGH", "CRITICAL"]) {
        expect(screenProblem(stop({ verdict, highest_severity: sev })), `${verdict}+${sev}`).toMatch(/self-contradictory/);
      }
      for (const sev of ["NONE", "LOW", "MEDIUM"]) {
        expect(screenProblem(stop({ verdict, highest_severity: sev })), `${verdict}+${sev}`).toBeNull();
      }
    }
    // REWORK beside any severity is coherent: the pipeline's own label for a confirmed HIGH.
    for (const sev of ["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"]) {
      expect(screenProblem(stop({ highest_severity: sev })), `REWORK+${sev}`).toBeNull();
    }
  });

  it("CRITICAL always escalates, and so does args.force — and the result says which", async () => {
    const critical = await review({ screen: stop({ highest_severity: "CRITICAL" }) });
    expect(lensCalls(critical.calls)).toHaveLength(LENS_KEYS.length);
    expect(critical.r.screened).toBe(false);
    expect(critical.r.escalated_because).toMatch(/CRITICAL/);

    const forced = await review({ screen: stop(), args: { pr: 704, force: true } });
    expect(lensCalls(forced.calls)).toHaveLength(LENS_KEYS.length);
    expect(forced.r.screened).toBe(false);
    expect(forced.r.escalated_because).toMatch(/args\.force/);

    const asked = await review({ screen: stop({ deep_review_worth_it: "yes" }) });
    expect(lensCalls(asked.calls)).toHaveLength(LENS_KEYS.length);
    expect(asked.r.escalated_because).toMatch(/asked for the deep pass/);
  });

  it("a screen that THROWS aborts the run outright — loud, and no verdict at all", async () => {
    await expect(
      runWorkflowScript(SCRIPT, { args: { pr: 704 }, agent: (c) => (c.label === "screen" ? THROW : cleanLens) }),
    ).rejects.toThrow(/simulated terminal API error/);
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(PRIV.skip)("pure decide(): exhaustive over every lens-state combination", () => {
  type Outcome = Record<string, unknown> | null | undefined;
  // Loaded in beforeAll, not at collection time: if the markers ever go missing the
  // tests in THIS block fail, and the end-to-end scenarios above still run and report.
  let pure: ReturnType<typeof loadPureRegion>;
  let decide: (keys: unknown, outcomes: unknown) => Verdict;
  let settleLens: (k: string, res: unknown, refutes: unknown) => Outcome;
  beforeAll(() => {
    pure = loadPureRegion(SCRIPT, ["decide", "settleLens", "screenProblem", "screenStops", "whyEscalated"]);
    decide = pure.decide as typeof decide;
    settleLens = pure.settleLens as typeof settleLens;
  });

  const ok = { verdict: "CONFIRMED", reasoning: "y" };
  const no = { verdict: "REFUTED", reasoning: "n" };
  // Each state: how one lens can end, including both ways of being dead.
  const STATES: Record<string, (k: string) => Outcome> = {
    "dropped (null)": () => null,
    "dead (settled)": (k) => settleLens(k, null, []),
    clean: (k) => settleLens(k, cleanLens, []),
    "confirmed LOW": (k) => settleLens(k, { verdict: "MERGE_WITH_FIXES", findings: [finding("l", "LOW")] }, [ok]),
    "confirmed HIGH": (k) => settleLens(k, { verdict: "REWORK", findings: [finding("h", "HIGH")] }, [ok]),
    "all refuted": (k) => settleLens(k, { verdict: "REWORK", findings: [finding("r", "CRITICAL")] }, [no]),
    "unrefuted CRITICAL": (k) => settleLens(k, { verdict: "REWORK", findings: [finding("u", "CRITICAL")] }, [null]),
  };
  const DEAD_STATES = ["dropped (null)", "dead (settled)"];
  const KEYS = ["w", "x", "y", "z"];

  it("MERGE / MERGE_WITH_FIXES is reachable ONLY when every lens completed and every finding was judged", () => {
    const names = Object.keys(STATES);
    let combos = 0;
    let mergeable = 0;
    const seen = new Set<string>();
    for (const a of names) for (const b of names) for (const c of names) for (const d of names) {
      combos++;
      const picked = [a, b, c, d];
      const r = decide(KEYS, picked.map((s, i) => STATES[s](KEYS[i])));
      const label = picked.join(" | ");
      seen.add(r.verdict);

      const deadCount = picked.filter((s) => DEAD_STATES.includes(s)).length;
      const unrefuted = picked.filter((s) => s === "unrefuted CRITICAL").length;
      const confirmedHigh = picked.includes("confirmed HIGH");
      const confirmedAny = confirmedHigh || picked.includes("confirmed LOW");
      const whole = deadCount === 0 && unrefuted === 0;

      // The oracle, stated independently of the implementation.
      const want = confirmedHigh ? "REWORK" : !whole ? "INCOMPLETE" : confirmedAny ? "MERGE_WITH_FIXES" : "MERGE";
      expect(r.verdict, label).toBe(want);
      expect(r.complete, label).toBe(whole);

      if (MERGEABLE.includes(r.verdict)) {
        mergeable++;
        expect(r.counts.lenses, label).toEqual({ expected: 4, completed: 4, dead: 0 });
        expect(r.counts.findings.unrefuted, label).toBe(0);
      }
      const f = r.counts.findings;
      expect(f.raw, label).toBe(f.refuted + f.confirmed + f.unrefuted);
      expect(r.counts.lenses.completed + r.counts.lenses.dead, label).toBe(4);
      expect(r.counts.lenses.dead, label).toBe(deadCount);
      expect(r.lens_verdicts, label).toHaveLength(4);
      for (const dl of r.dead_lenses) expect(r.summary, label).toContain(dl.lens);
    }
    expect(combos).toBe(7 ** 4);
    expect(mergeable).toBeGreaterThan(0); // the property above was not vacuous
    expect([...seen].sort()).toEqual(["INCOMPLETE", "MERGE", "MERGE_WITH_FIXES", "REWORK"]);
  });

  it("cannot pass vacuously: no expected lenses, or garbage outcomes, is INCOMPLETE", () => {
    expect(decide([], []).verdict).toBe("INCOMPLETE");
    expect(decide([], []).summary).toMatch(/no lenses were configured/);
    expect(decide(undefined, undefined).verdict).toBe("INCOMPLETE");
    for (const junk of [undefined, null, "MERGE", 7, {}, [null, undefined, "x", 7, {}, { lens: 5 }, { lens: "w" }]]) {
      const r = decide(KEYS, junk);
      expect(r.verdict).toBe("INCOMPLETE");
      expect(r.counts.lenses).toEqual({ expected: 4, completed: 0, dead: 4 });
    }
  });

  it("matches lenses by KEY: a stranger's clean result cannot stand in for an expected lens", () => {
    const outcomes = [...KEYS.slice(1).map((k) => STATES.clean(k)), STATES.clean("not-a-configured-lens")];
    const r = decide(KEYS, outcomes);
    expect(r.verdict).toBe("INCOMPLETE");
    expect(r.dead_lenses.map((d) => d.lens)).toEqual(["w"]);
  });

  it("an ambiguous lens key is dead, never first-one-wins: no outcome is silently discarded", () => {
    // Two outcomes for one lens — a dead one that would have hidden a CONFIRMED CRITICAL.
    const hidden = settleLens("w", { verdict: "REWORK", findings: [finding("drain", "CRITICAL")] }, [{ verdict: "CONFIRMED", reasoning: "y" }]);
    const rest = KEYS.slice(1).map((k) => STATES.clean(k));
    for (const pair of [[STATES["dead (settled)"]("w"), hidden], [hidden, STATES["dead (settled)"]("w")], [STATES.clean("w"), STATES.clean("w")]]) {
      const r = decide(KEYS, [...pair, ...rest]);
      expect(r.verdict).toBe("INCOMPLETE");
      expect(r.dead_lenses).toEqual([{ lens: "w", reason: "ambiguous — 2 outcomes reported for one lens" }]);
    }
    // The same key configured twice: both slots are dead, so a single clean result cannot fill two seats.
    const twice = decide(["w", "w"], [STATES.clean("w")]);
    expect(twice.verdict).toBe("INCOMPLETE");
    expect(twice.counts.lenses).toEqual({ expected: 2, completed: 0, dead: 2 });
  });

  it("is pure: the region evaluates with no runtime globals in scope", () => {
    // loadPureRegion() evaluated it in strict mode with no agent/log/args/PR defined,
    // and every call above ran. Pin the exports so a rename cannot hollow this out.
    for (const name of ["decide", "settleLens", "screenProblem", "screenStops", "whyEscalated"]) {
      expect(typeof pure[name], name).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(PRIV.skip)("mutation self-proof — re-introducing each defect turns these scenarios red", () => {
  const mutate = (from: string, to: string) => {
    const mutated = SCRIPT.replace(from, to);
    // A mutation that matched nothing would make the assertions below vacuous.
    expect(mutated, `mutation target not found in the script: ${from}`).not.toBe(SCRIPT);
    return mutated;
  };

  it("drop the completeness requirement → all-dead reads MERGE again (the original defect)", async () => {
    const source = mutate(
      "const complete = expected.length > 0 && dead.length === 0 && unrefuted.length === 0",
      "const complete = true",
    );
    const { r } = await review({ source, screen: DEAD, lens: () => DEAD });
    expect(r.verdict).toBe("MERGE");
  });

  it("treat a dead refuter as REFUTED → its finding vanishes and the run reads MERGE", async () => {
    const source = mutate("status: ok ? v.verdict : 'UNREFUTED'", "status: ok ? v.verdict : 'REFUTED'");
    const { r } = await review({
      source,
      lens: (k) => (k === LENS_KEYS[0] ? { verdict: "REWORK", findings: [finding("drain", "CRITICAL")] } : cleanLens),
      refute: () => DEAD,
    });
    expect(r.verdict).toBe("MERGE");
    expect(r.unrefuted).toEqual([]);
  });

  it("trust a partial screen again → { verdict: REWORK, deep_review_worth_it: no } short-circuits to a screened REWORK", async () => {
    // REWORK, not MERGE: since 2026-09-18 a MERGE is also stopped by the REWORK-only rule, so a
    // MERGE-shaped partial would leave this proof pointing at two guards instead of one.
    const source = mutate("return !force && screenProblem(screen) === null", "return !force && !!screen");
    const { r, calls } = await review({ source, screen: { verdict: "REWORK", deep_review_worth_it: "no" } });
    expect(r).toMatchObject({ verdict: "REWORK", screened: true });
    expect(lensCalls(calls)).toHaveLength(0);
  });

  const REWORK_ONLY = "&& screen.verdict === 'REWORK'\n";

  it("drop the REWORK-only rule → the 7-of-7 shape (MERGE / NONE / 'no') is a one-agent MERGE again", async () => {
    const source = mutate(REWORK_ONLY, "");
    const { r, calls } = await review({
      source,
      screen: { verdict: "MERGE", highest_severity: "NONE", deep_review_worth_it: "no", reason: "clean", dispositive_defects: [] },
    });
    expect(r).toMatchObject({ verdict: "MERGE", screened: true, depth: "screen-only" });
    expect(lensCalls(calls)).toHaveLength(0);
  });

  it("…but MERGE_WITH_FIXES + HIGH still cannot stop the run without the REWORK-only rule: the contradiction check stands on its own", async () => {
    const source = mutate(REWORK_ONLY, "");
    const { r, calls } = await review({
      source,
      screen: { verdict: "MERGE_WITH_FIXES", highest_severity: "HIGH", deep_review_worth_it: "no", reason: "x", dispositive_defects: ["x.sh:3"] },
    });
    expect(lensCalls(calls)).toHaveLength(LENS_KEYS.length);
    expect(r.screened).toBe(false);
    expect(r.screen_problem).toMatch(/self-contradictory/);
  });

  it("narrow the contradiction back to clean MERGE → MERGE_WITH_FIXES + HIGH stops at the screen again once the REWORK-only rule is gone", async () => {
    // Both guards removed at once: this is exactly the pre-ruling gate, and the pinned
    // pre-ruling behaviour comes back — which is what proves each guard is load-bearing.
    const source = mutate(REWORK_ONLY, "").replace(
      "if (screen.verdict !== 'REWORK' && (screen.highest_severity === 'HIGH'",
      "if (screen.verdict === 'MERGE' && (screen.highest_severity === 'HIGH'",
    );
    expect(source).not.toBe(mutate(REWORK_ONLY, "")); // the second replacement matched too
    const screen = { verdict: "MERGE_WITH_FIXES", highest_severity: "HIGH", deep_review_worth_it: "no", reason: "x", dispositive_defects: ["x.sh:3"] };
    const { r, calls } = await review({ source, screen });
    expect(r).toMatchObject({ verdict: "MERGE_WITH_FIXES", screened: true, depth: "screen-only", screen_problem: null });
    expect(lensCalls(calls)).toHaveLength(0);
  });
});
