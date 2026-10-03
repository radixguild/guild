import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Runs a Claude Code Workflow script (`.claude/workflows/*.js`) against FAKE
 * agents, so its control flow can be exercised for zero tokens.
 *
 * A workflow script cannot be `import`ed: it opens with `export const meta`, then
 * uses top-level `await` AND top-level `return`, and leans on globals the runtime
 * injects (`args`, `agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`,
 * `workflow`). It also cannot import anything itself — the runtime gives it no
 * module or filesystem access — so its logic has to live in the one file. This
 * harness therefore evaluates the file's TEXT as the body of an async function
 * with those globals passed in as parameters. What runs is the shipped script,
 * byte for byte, minus the single `export` keyword.
 *
 * ⚠️ WHAT THIS IS NOT. The fakes below model the runtime contract as the
 * `workflow-authoring` reference documents it:
 *   · agent()    → resolves `null` when the subagent dies on a terminal API
 *                  error or is skipped;
 *   · parallel() → never rejects; a thunk that throws resolves to `null` in place;
 *   · pipeline() → a stage that throws drops that item to `null` and skips its
 *                  remaining stages.
 * They are a MODEL, not the runtime. Where the reference is silent the harness
 * offers both readings instead of picking one — see `PipelineMode`.
 */

export const AGENT_PR_REVIEW = resolve(__dirname, "../../../.claude/workflows/agent-pr-review.js");

export function readScript(path: string = AGENT_PR_REVIEW): string {
  return readFileSync(path, "utf8");
}

export type AgentCall = { label: string; phase: string | undefined; prompt: string };

/** Return this from an `AgentImpl` to make agent() REJECT instead of resolving. */
export const THROW = Symbol("agent-throws");

/** A fake agent: return the structured output, `null` (a dead agent), or `THROW`. */
export type AgentImpl = (call: AgentCall) => unknown;

/**
 * The reference does not say what pipeline() does when a stage RESOLVES to null
 * (as opposed to throwing). Both readings are plausible, so both are offered:
 *   "drop-null" — the item is dropped to null and its later stages are skipped;
 *   "pass-null" — null is handed to the next stage like any other value.
 * A script that is only correct under one of them is not correct.
 */
export type PipelineMode = "drop-null" | "pass-null";

export type RunOptions = { args?: unknown; agent: AgentImpl; pipelineMode?: PipelineMode };
export type RunResult = { result: unknown; logs: string[]; calls: AgentCall[] };

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...params: string[]
) => (...values: unknown[]) => Promise<unknown>;

type Stage = (prev: unknown, item: unknown, index: number) => unknown;

export async function runWorkflowScript(source: string, opts: RunOptions): Promise<RunResult> {
  const body = source.replace(/^export const meta = /m, "const meta = ");
  if (body === source) {
    throw new Error("harness: expected the script to declare `export const meta = ` — nothing was rewritten");
  }

  const mode: PipelineMode = opts.pipelineMode ?? "drop-null";
  const logs: string[] = [];
  const calls: AgentCall[] = [];

  const agent = async (prompt: string, o: { label?: string; phase?: string } = {}) => {
    const call: AgentCall = { label: o.label ?? "", phase: o.phase, prompt };
    calls.push(call);
    const out = opts.agent(call);
    if (out === THROW) throw new Error(`[${call.label}] failed: simulated terminal API error`);
    return out;
  };

  const parallel = (thunks: Array<() => unknown>) =>
    Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)));

  const pipeline = (items: unknown[], ...stages: Stage[]) =>
    Promise.all(
      items.map(async (item, i) => {
        let v: unknown = item;
        for (const stage of stages) {
          try {
            v = await stage(v, item, i);
          } catch {
            return null;
          }
          if (v == null && mode === "drop-null") return null;
        }
        return v;
      }),
    );

  const budget = { total: null, spent: () => 0, remaining: () => Infinity };
  const workflow = () => {
    throw new Error("harness: workflow() is not modelled");
  };

  const run = new AsyncFunction("args", "agent", "parallel", "pipeline", "phase", "log", "budget", "workflow", body);
  const result = await run(opts.args, agent, parallel, pipeline, () => {}, (m: string) => logs.push(m), budget, workflow);
  return { result, logs, calls };
}

const PURE_BEGIN = "// >>> PURE-VERDICT-LOGIC:BEGIN";
const PURE_END = "// <<< PURE-VERDICT-LOGIC:END";

/**
 * Slices the marked pure region out of the script and evaluates it ALONE, in
 * strict mode, with none of the runtime globals in scope. If the region ever
 * reaches for `agent`, `log`, `args`, `PR`… the call throws a ReferenceError
 * here, which is the point: the verdict must be a function of its inputs.
 */
export function loadPureRegion(source: string, exportNames: string[]): Record<string, (...a: unknown[]) => unknown> {
  const count = (needle: string) => source.split(needle).length - 1;
  if (count(PURE_BEGIN) !== 1 || count(PURE_END) !== 1) {
    throw new Error(
      `harness: expected exactly one "${PURE_BEGIN}" and one "${PURE_END}" marker, found ${count(PURE_BEGIN)} / ${count(PURE_END)}`,
    );
  }
  const start = source.indexOf(PURE_BEGIN);
  const end = source.indexOf(PURE_END);
  if (end <= start) throw new Error("harness: pure-region END marker precedes BEGIN");
  const region = source.slice(start, end);
  return new Function(`"use strict";\n${region}\nreturn { ${exportNames.join(", ")} };`)();
}
