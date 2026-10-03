// scripts/lib/set-task-project-args.mjs — the pure argument-parsing/
// validation/plan-building decision set-task-project.mjs (the operator tool
// that files EXISTING tasks under a Guild project) uses.
//
// set-task-project.mjs itself reads/writes live Postgres and calls
// process.exit at module scope, so it cannot be imported here — same split
// as post-micro-tasks.mjs (see tests/unit/post-micro-project-ref.test.ts)
// and fleet-recycle.mjs (tests/unit/fleet-recycle-reserve-guard.test.ts).
// The testable decision was extracted to scripts/lib/set-task-project-args.mjs
// specifically so it could be pinned directly, without a live DATABASE_URL.

import { describe, it, expect } from "vitest";
import { privateInputs } from "../support/private-input";

// scripts/lib/set-task-project-args.mjs stays private at the open-source flip
// (not one of the guild-app/scripts/** carve-outs) — skip in the public
// export, throw in the private tree if it ever goes missing
// (tests/support/private-input.ts).
const PRIV = privateInputs("guild-app/scripts/lib/set-task-project-args.mjs");
const SET_TASK_PROJECT_ARGS_PATH = "../../scripts/lib/set-task-project-args.mjs";
const setTaskProjectArgs = PRIV.skip ? null : await import(SET_TASK_PROJECT_ARGS_PATH);
const {
  parseTaskIdList,
  parseProjectFlagValue,
  validateModeShape,
  validateTaskProjectMap,
  buildTaskPlanEntry,
  formatTitle,
} = setTaskProjectArgs ?? ({} as NonNullable<typeof setTaskProjectArgs>);

describe.skipIf(PRIV.skip)("parseTaskIdList", () => {
  it("parses a single id", () => {
    expect(parseTaskIdList("12")).toEqual([12]);
  });

  it("parses a comma-separated list, in order", () => {
    expect(parseTaskIdList("12,13,14")).toEqual([12, 13, 14]);
  });

  it("tolerates surrounding whitespace around entries", () => {
    expect(parseTaskIdList(" 12 , 13 ")).toEqual([12, 13]);
  });

  it("de-duplicates, keeping first occurrence order", () => {
    expect(parseTaskIdList("12,13,12")).toEqual([12, 13]);
  });

  it("throws on an empty value", () => {
    expect(() => parseTaskIdList("")).toThrow(/at least one id/);
  });

  it("throws on a non-positive-integer entry", () => {
    expect(() => parseTaskIdList("12,abc")).toThrow(/"abc" is not a positive integer/);
    expect(() => parseTaskIdList("0")).toThrow(/not a positive integer/);
    expect(() => parseTaskIdList("-1")).toThrow(/not a positive integer/);
    expect(() => parseTaskIdList("1.5")).toThrow(/not a positive integer/);
    // A leading zero is not a "bare positive integer" — same posture as
    // project-ref.mjs's parseProjectArgValue on "03".
    expect(() => parseTaskIdList("012")).toThrow(/not a positive integer/);
  });
});

describe.skipIf(PRIV.skip)("parseProjectFlagValue", () => {
  it("recognizes a catalogue code P1..P7", () => {
    expect(parseProjectFlagValue("P1")).toEqual({ kind: "catalogue", value: "P1" });
    expect(parseProjectFlagValue("P7")).toEqual({ kind: "catalogue", value: "P7" });
  });

  it("does not treat P8+ or lowercase p1 as a catalogue code (falls through to slug)", () => {
    expect(parseProjectFlagValue("P8")).toEqual({ kind: "slug", value: "P8" });
    expect(parseProjectFlagValue("p1")).toEqual({ kind: "slug", value: "p1" });
  });

  it("delegates a bare positive integer to the id case", () => {
    expect(parseProjectFlagValue("3")).toEqual({ kind: "id", value: 3 });
  });

  it("delegates anything else to the slug case", () => {
    expect(parseProjectFlagValue("p1-guild-infra")).toEqual({ kind: "slug", value: "p1-guild-infra" });
  });
});

describe.skipIf(PRIV.skip)("validateModeShape", () => {
  it("is clean for --task + --project", () => {
    expect(validateModeShape({ task: "12", project: "3", clear: false, fromCatalogue: false })).toEqual([]);
  });

  it("is clean for --task + --clear", () => {
    expect(validateModeShape({ task: "12", clear: true, fromCatalogue: false })).toEqual([]);
  });

  it("is clean for --from-catalogue + --map", () => {
    expect(validateModeShape({ clear: false, fromCatalogue: true, map: "map.json" })).toEqual([]);
  });

  it("flags neither mode given", () => {
    const errs = validateModeShape({ clear: false, fromCatalogue: false });
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/nothing to do/);
  });

  it("flags mixing --task with --from-catalogue/--map", () => {
    const errs = validateModeShape({ task: "12", project: "3", clear: false, fromCatalogue: true, map: "x.json" });
    expect(errs).toEqual(["--task/--project/--clear and --from-catalogue/--map are mutually exclusive"]);
  });

  it("flags --task with both --project and --clear", () => {
    const errs = validateModeShape({ task: "12", project: "3", clear: true, fromCatalogue: false });
    expect(errs).toEqual(["--project and --clear are mutually exclusive"]);
  });

  it("flags --task with neither --project nor --clear", () => {
    const errs = validateModeShape({ task: "12", clear: false, fromCatalogue: false });
    expect(errs).toEqual(["--task requires --project <id|slug|P1..P7> or --clear"]);
  });

  it("flags --from-catalogue without --map", () => {
    const errs = validateModeShape({ clear: false, fromCatalogue: true });
    expect(errs).toEqual(["--from-catalogue requires --map <path-to-json>"]);
  });

  it("flags --map without --from-catalogue", () => {
    const errs = validateModeShape({ clear: false, fromCatalogue: false, map: "x.json" });
    expect(errs).toEqual(["--map requires --from-catalogue"]);
  });
});

describe.skipIf(PRIV.skip)("validateTaskProjectMap", () => {
  it("accepts a clean map, preserving key order", () => {
    const result = validateTaskProjectMap({ "12": "P3", "13": "P3", "14": "P6" });
    expect(result).toEqual({
      ok: true,
      entries: [
        { taskId: 12, code: "P3" },
        { taskId: 13, code: "P3" },
        { taskId: 14, code: "P6" },
      ],
    });
  });

  it("rejects a non-object payload", () => {
    expect(validateTaskProjectMap(null).ok).toBe(false);
    expect(validateTaskProjectMap("nope").ok).toBe(false);
    expect(validateTaskProjectMap(["12", "P3"]).ok).toBe(false);
  });

  it("rejects an empty object", () => {
    const result = validateTaskProjectMap({});
    expect(result).toEqual({ ok: false, errors: ["--map is empty — nothing to do"] });
  });

  it("rejects a non-integer key", () => {
    const result = validateTaskProjectMap({ abc: "P3" });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['map key "abc" is not a positive integer task id']);
  });

  it("rejects a leading-zero key (not a bare positive integer)", () => {
    const result = validateTaskProjectMap({ "012": "P3" });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/"012" is not a positive integer/);
  });

  it("rejects a value outside P1..P7", () => {
    const result = validateTaskProjectMap({ "12": "P8" });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['map["12"] = "P8" is not a catalogue code P1..P7']);
  });

  it("rejects a non-string value", () => {
    const result = validateTaskProjectMap({ "12": 3 });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['map["12"] = 3 is not a catalogue code P1..P7']);
  });

  it("collects every error across a bad batch rather than stopping at the first", () => {
    const result = validateTaskProjectMap({ "12": "P3", abc: "P1", "13": "P9" });
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});

describe.skipIf(PRIV.skip)("formatTitle", () => {
  it("returns a short title unchanged", () => {
    expect(formatTitle("fix the thing")).toBe("fix the thing");
  });

  it("passes a title of exactly 60 chars through unchanged", () => {
    const title = "x".repeat(60);
    expect(formatTitle(title)).toBe(title);
    expect(formatTitle(title)).toHaveLength(60);
  });

  it("truncates a longer title with an ellipsis, capped at 60 chars", () => {
    const title = "x".repeat(80);
    const out = formatTitle(title);
    expect(out).toHaveLength(60);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, 59)).toBe("x".repeat(59));
  });
});

describe.skipIf(PRIV.skip)("buildTaskPlanEntry", () => {
  it("flags an unknown task id, carrying the intended target through", () => {
    const entry = buildTaskPlanEntry(999, null, 3);
    expect(entry).toEqual({ taskId: 999, found: false, from: null, to: 3, skip: true, note: "unknown task id" });
  });

  it("builds a normal move (found, different project)", () => {
    const entry = buildTaskPlanEntry(12, { title: "fix the thing", projectId: 2 }, 3);
    expect(entry).toEqual({
      taskId: 12,
      found: true,
      title: "fix the thing",
      from: 2,
      to: 3,
      skip: false,
    });
  });

  it("treats a row with projectId null as 'no project', movable to a target", () => {
    const entry = buildTaskPlanEntry(12, { title: "fix the thing", projectId: null }, 3);
    expect(entry.from).toBeNull();
    expect(entry.skip).toBe(false);
  });

  it("skips (does not error) a row already at the target project", () => {
    const entry = buildTaskPlanEntry(12, { title: "fix the thing", projectId: 3 }, 3);
    expect(entry.skip).toBe(true);
    expect(entry.note).toBe("already at target — skipped");
  });

  it("skips a row already cleared when the target is --clear (null -> null)", () => {
    const entry = buildTaskPlanEntry(12, { title: "fix the thing", projectId: null }, null);
    expect(entry.skip).toBe(true);
    expect(entry.to).toBeNull();
  });

  it("builds a clear (found, target null, currently set)", () => {
    const entry = buildTaskPlanEntry(12, { title: "fix the thing", projectId: 3 }, null);
    expect(entry.skip).toBe(false);
    expect(entry.to).toBeNull();
  });
});
