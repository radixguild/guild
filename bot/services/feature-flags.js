// Feature flags that used to be one flag.
//
// FEATURE_ESCROW was doing two unrelated jobs (found 2026-09-20 in a live command
// test with the operator):
//   1. start the escrow WATCHER + its API surface — the thing that must run in
//      production, and the reason the flag was set to "true" on 2026-09-14;
//   2. re-open the bot's LEGACY built-in bounty board — a SQLite board from before
//      the marketplace moved to radixguild.com.
// So switching the watcher on also put "Bounty Board — Open: 0 | Escrow: 0 XRD"
// with Create/Claim buttons in front of every newcomer, while the real board held
// 53 tasks in live on-chain escrow. The honest "tasks live on the web app" reply
// already existed; it was stranded behind the flag-off branch.
//
// The legacy board now has its own flag, default OFF. The watcher keeps
// FEATURE_ESCROW exactly as it was.

/** The escrow watcher + API surface. Unchanged meaning. */
function escrowSurfaceEnabled(env = process.env) {
  return env.FEATURE_ESCROW === "true";
}

/** The bot's legacy in-Telegram bounty board, wizard and milestones. Default off. */
function legacyBountyBoardEnabled(env = process.env) {
  return env.FEATURE_LEGACY_BOUNTY === "true";
}

/** Opt-in DMs to subscribers when a task is funded on-chain (#119). Default off. */
function taskAlertsEnabled(env = process.env) {
  return env.FEATURE_TASK_ALERTS === "true";
}

module.exports = { escrowSurfaceEnabled, legacyBountyBoardEnabled, taskAlertsEnabled };
