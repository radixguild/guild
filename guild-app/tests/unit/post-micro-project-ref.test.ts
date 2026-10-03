// scripts/lib/project-ref.mjs — the pure project-reference decision
// post-micro-tasks.mjs uses for its --project / --catalogue-project / per-row
// project_id|project support.
//
// post-micro-tasks.mjs itself reads live Gateway/DB state and calls
// process.exit at module scope, so it cannot be imported here — same shape as
// fleet-recycle.mjs (see tests/unit/fleet-recycle-reserve-guard.test.ts and
// scripts/lib/reserve-guard.mjs's own header comment). The testable decision
// was extracted to scripts/lib/project-ref.mjs specifically so it could be
// pinned directly, without a live Gateway, DB, or POSTER_PRIVATE_KEY.

import { describe, it, expect } from "vitest";
import { privateInputs } from "../support/private-input";

// scripts/lib/project-ref.mjs stays private at the open-source flip (not one
// of the guild-app/scripts/** carve-outs) — skip in the public export, throw
// in the private tree if it ever goes missing (tests/support/private-input.ts).
const PRIV = privateInputs("guild-app/scripts/lib/project-ref.mjs");
const PROJECT_REF_PATH = "../../scripts/lib/project-ref.mjs";
const projectRef = PRIV.skip ? null : await import(PROJECT_REF_PATH);
const {
  parseProjectArgValue,
  rowProjectRef,
  validateProjectRefShape,
  resolveProjectRefs,
  matchCatalogueProject,
} = projectRef ?? ({} as NonNullable<typeof projectRef>);

describe.skipIf(PRIV.skip)("parseProjectArgValue", () => {
  it("treats a bare positive-integer string as an id", () => {
    expect(parseProjectArgValue("3")).toEqual({ kind: "id", value: 3 });
    expect(parseProjectArgValue("42")).toEqual({ kind: "id", value: 42 });
  });

  it("treats anything else as a slug", () => {
    expect(parseProjectArgValue("p1-guild-infra")).toEqual({ kind: "slug", value: "p1-guild-infra" });
    expect(parseProjectArgValue("3-ish")).toEqual({ kind: "slug", value: "3-ish" });
    // A leading zero is not a "bare positive integer" in the id sense the
    // server would accept either — treated as a slug, not silently coerced.
    expect(parseProjectArgValue("03")).toEqual({ kind: "slug", value: "03" });
  });
});

describe.skipIf(PRIV.skip)("rowProjectRef", () => {
  it("reads project_id when set", () => {
    expect(rowProjectRef({ project_id: 5 })).toEqual({ kind: "id", value: 5 });
  });

  it("reads project (slug) when set", () => {
    expect(rowProjectRef({ project: "p1-guild-infra" })).toEqual({ kind: "slug", value: "p1-guild-infra" });
  });

  it("is null when neither is set (falls back to the batch default)", () => {
    expect(rowProjectRef({})).toBeNull();
  });

  it("is null when BOTH are set (ambiguous — validateProjectRefShape is what flags this as an error)", () => {
    expect(rowProjectRef({ project_id: 5, project: "x" })).toBeNull();
  });
});

describe.skipIf(PRIV.skip)("validateProjectRefShape", () => {
  it("is clean for a row with neither field", () => {
    expect(validateProjectRefShape({}, 0)).toEqual([]);
  });

  it("is clean for a valid project_id", () => {
    expect(validateProjectRefShape({ project_id: 5 }, 0)).toEqual([]);
  });

  it("is clean for a valid project slug", () => {
    expect(validateProjectRefShape({ project: "p1-guild-infra" }, 0)).toEqual([]);
  });

  it("flags BOTH project_id and project set on the same row", () => {
    const errs = validateProjectRefShape({ project_id: 5, project: "x" }, 2);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toBe("#3: set project_id OR project (slug), not both");
  });

  it("flags a non-positive-integer project_id", () => {
    expect(validateProjectRefShape({ project_id: 0 }, 0)).toEqual(["#1: project_id must be a positive integer"]);
    expect(validateProjectRefShape({ project_id: -1 }, 0)).toEqual(["#1: project_id must be a positive integer"]);
    expect(validateProjectRefShape({ project_id: 1.5 }, 0)).toEqual(["#1: project_id must be a positive integer"]);
  });

  it("flags an empty/non-string project slug", () => {
    expect(validateProjectRefShape({ project: "" }, 4)).toEqual(["#5: project must be a non-empty slug string"]);
    expect(validateProjectRefShape({ project: "   " }, 4)).toEqual(["#5: project must be a non-empty slug string"]);
  });
});

describe.skipIf(PRIV.skip)("resolveProjectRefs", () => {
  const PROJECTS = [
    { id: 3, slug: "p1-guild-infra" },
    { id: 4, slug: "p2-scanner" },
  ];

  it("resolves a row's own project_id, ignoring any global default", () => {
    const tasks = [{ title: "a", project_id: 4 }];
    const { resolvedProjectIds, unresolved } = resolveProjectRefs(tasks, PROJECTS, { kind: "id", value: 3 });
    expect(unresolved).toEqual([]);
    expect(resolvedProjectIds).toEqual([4]);
  });

  it("resolves a row's own project slug", () => {
    const tasks = [{ title: "a", project: "p2-scanner" }];
    const { resolvedProjectIds, unresolved } = resolveProjectRefs(tasks, PROJECTS, null);
    expect(unresolved).toEqual([]);
    expect(resolvedProjectIds).toEqual([4]);
  });

  it("falls back to the global default for a row that names neither field", () => {
    const tasks = [{ title: "a" }];
    const { resolvedProjectIds } = resolveProjectRefs(tasks, PROJECTS, { kind: "slug", value: "p1-guild-infra" });
    expect(resolvedProjectIds).toEqual([3]);
  });

  it("leaves a row unresolved (undefined) when it references no project AND there is no global default — byte-identical-when-unused", () => {
    const tasks = [{ title: "a" }, { title: "b", project_id: 3 }];
    const { resolvedProjectIds, unresolved } = resolveProjectRefs(tasks, PROJECTS, null);
    expect(unresolved).toEqual([]);
    expect(resolvedProjectIds).toEqual([undefined, 3]);
  });

  it("reports an unknown project_id with the row index and value, never throws", () => {
    const tasks = [{ title: "a", project_id: 999 }];
    const { resolvedProjectIds, unresolved } = resolveProjectRefs(tasks, PROJECTS, null);
    expect(resolvedProjectIds).toEqual([undefined]);
    expect(unresolved).toEqual(['#1: project id "999" does not exist']);
  });

  it("reports an unknown project slug with the row index and value", () => {
    const tasks = [{ title: "a", project: "does-not-exist" }];
    const { unresolved } = resolveProjectRefs(tasks, PROJECTS, null);
    expect(unresolved).toEqual(['#1: project slug "does-not-exist" does not exist']);
  });

  it("resolves a whole batch independently — each row's own reference wins, unresolved ones collect together", () => {
    const tasks = [
      { title: "a", project_id: 3 },
      { title: "b", project: "does-not-exist" },
      { title: "c" }, // no ref, no global default -> undefined, not an error
      { title: "d", project_id: 12345 },
    ];
    const { resolvedProjectIds, unresolved } = resolveProjectRefs(tasks, PROJECTS, null);
    expect(resolvedProjectIds).toEqual([3, undefined, undefined, undefined]);
    expect(unresolved).toEqual([
      '#2: project slug "does-not-exist" does not exist',
      '#4: project id "12345" does not exist',
    ]);
  });
});

describe.skipIf(PRIV.skip)("matchCatalogueProject", () => {
  const PROJECTS = [
    { id: 1, name: "P1 Guild Infra", slug: "p1-guild-infra" },
    { id: 2, name: "P2 Scanner", slug: "p2-scanner" },
    { id: 3, name: "P10 Something", slug: "p10-something" }, // must NOT match "P1" (prefix needs the space)
  ];

  it("matches the one project whose name starts with '<code> '", () => {
    const result = matchCatalogueProject(PROJECTS, "P1");
    expect(result).toEqual({ ok: true, project: PROJECTS[0] });
  });

  it("does not let 'P1' match 'P10 Something' (prefix match requires the trailing space)", () => {
    const result = matchCatalogueProject(PROJECTS, "P1");
    expect(result.ok).toBe(true);
    expect(result.project.id).toBe(1); // not 3
  });

  it("fails closed (ok:false) when nothing matches", () => {
    expect(matchCatalogueProject(PROJECTS, "P7")).toEqual({ ok: false, matches: 0 });
  });

  it("fails closed (ok:false) when more than one project matches — never guesses", () => {
    const dupes = [
      { id: 1, name: "P3 Alpha", slug: "p3-alpha" },
      { id: 2, name: "P3 Beta", slug: "p3-beta" },
    ];
    expect(matchCatalogueProject(dupes, "P3")).toEqual({ ok: false, matches: 2 });
  });
});
