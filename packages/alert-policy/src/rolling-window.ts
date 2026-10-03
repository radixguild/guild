/**
 * Rolling-window volume threshold — the rule behind any alert whose condition
 * is "N events in the last H hours crossed an operator-set threshold" (Guild
 * Member-badge mint volume, task-creation volume, anything counted off a
 * timestamp stream). Pure and I/O-free, same posture as policy.ts: the
 * caller supplies raw event timestamps — however it read them, a Gateway
 * transaction stream, a DB query, a log scrape — plus the window/threshold/
 * now it wants evaluated. This module owns only the arithmetic of "how many,
 * and did that cross the line"; feeding the resulting boolean into
 * `createAlertEvaluator` (edge-trigger + backoff, evaluate.ts) is still the
 * caller's job, exactly like every other consumer's condition in this
 * package (see the README's `price-frozen` / `network-halt` examples).
 *
 * The window is INCLUSIVE on both ends: a timestamp exactly `windowMs` old,
 * or exactly `now`, counts. `now` is a parameter rather than read from the
 * clock for the same reason `decide()` takes one instead of calling
 * `Date.now()` itself — it is what keeps this testable and side-effect-free.
 */

export interface RollingThresholdInput {
  /** Event timestamps, ms epoch, any order (duplicates count once each). */
  timestampsMs: readonly number[];
  /** Window length in ms — "in the last H hours" is `H * 3_600_000`. */
  windowMs: number;
  /** The alert condition is `count >= threshold`. */
  threshold: number;
  /** Reference clock (ms epoch). */
  now: number;
}

export interface RollingThresholdResult {
  /** How many of `timestampsMs` fall inside the inclusive window [now - windowMs, now]. */
  count: number;
  /** `count >= threshold` — hand this straight to `evaluate({ condition, ... })`. */
  condition: boolean;
}

/**
 * How many of `timestampsMs` fall inside the inclusive window
 * `[now - windowMs, now]`. A timestamp after `now` (clock skew, a bad read)
 * is excluded rather than counted — this function never treats "later than
 * the reference clock" as "recent".
 */
export function countInWindow(
  timestampsMs: readonly number[],
  windowMs: number,
  now: number,
): number {
  const since = now - windowMs;
  let count = 0;
  for (const t of timestampsMs) {
    if (t >= since && t <= now) count++;
  }
  return count;
}

/**
 * The threshold-crossing predicate on its own, for a caller that already has
 * a count (e.g. a Gateway-side aggregate) and doesn't need the windowing
 * half. `threshold <= 0` always crosses — a deliberate "alert on any volume
 * at all" setting, not a special case this function treats differently.
 */
export function crossesThreshold(count: number, threshold: number): boolean {
  return count >= threshold;
}

/** The whole rule in one call: window a raw timestamp list, then test the count against the threshold. */
export function rollingThresholdCondition(
  input: RollingThresholdInput,
): RollingThresholdResult {
  const count = countInWindow(input.timestampsMs, input.windowMs, input.now);
  return { count, condition: crossesThreshold(count, input.threshold) };
}
