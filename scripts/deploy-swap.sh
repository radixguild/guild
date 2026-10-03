#!/bin/bash
# deploy-swap.sh — the ONE remote command of a deploy that changes what is served:
# kit-candidate → kit, .next-candidate → .next, pm2 restart. Run ON THE BOX by
# scripts/deploy.sh (step 6); never by hand unless you have read that script.
#
#   bash scripts/deploy-swap.sh <app-dir> <candidate> <previous> <kit-candidate> <kit-dir> <kit-previous> <pm2-app>
#
# WHY A SCRIPT AND NOT A `&&` CHAIN (agent-pr-review on PR #801, 2026-09-28): the chain
# was atomic in the sense that nothing could abort BETWEEN its commands — but a command
# INSIDE it can fail (disk full, a permission, pm2 refusing to restart). With `set -e`
# in deploy.sh, that failure aborted the deploy at the swap step, BEFORE the live-verify
# rollback (the only path that restores the previous kit + build) ever ran: a box left
# with the kit swapped and the app half-swapped, and no automatic remediation.
#
# So the swap records how far it got, and an ERR trap undoes exactly those moves in
# reverse — the kit and the build go back TOGETHER, never one without the other — then
# exits non-zero so deploy.sh stops. The undo REPORTS WHAT IT ACHIEVED, not what it
# intended (rounds 2 and 3 of that review): every restore is checked, a restore into a
# path that already exists is refused (mv would silently NEST the directory and return
# 0), and the closing line is READ BACK FROM DISK — which build is in .next, which kit is
# in the kit dir, or that a half is absent because none existed before this deploy —
# or says the state is NOT restored and exactly where each directory is. The operator
# reads that line mid-incident; it must never name a directory that is not there.
#
# FROM-SCRATCH BOX (no previous build): there is nothing to go back to. If the failure
# comes after the build has been swapped in (the restart failed), the candidates STAY in
# place — a box with no .next serves nothing at all, and the candidate had passed the
# launch gate — the restart is retried, and the closing line says so. The script still
# exits non-zero: deploy.sh stops, and its live verify has not run.
#
# ORDER IS LOAD-BEARING: kit first, then the build, then the restart. Caddy serves
# /kit/* straight off the directory, so the kit is live the instant it moves; the .next
# move is kept adjacent to the pm2 restart because the running process resolves chunks
# from disk per request (the 2026-08-26 / 09-08 incident class). guild-app's
# tests/unit/deploy-kit-atomic.test.ts pins that order and runs this script against
# temp directories with a stub pm2 — the happy path, a first deploy, a failing pm2 with
# and without a previous build, and a restore that itself fails.
#
# PM2_BIN overrides the pm2 command (tests point it at a stub). Nothing else is
# configurable: the paths come from deploy.sh, which owns them.
set -euo pipefail

if [ $# -ne 7 ]; then
  echo "usage: deploy-swap.sh <app-dir> <candidate> <previous> <kit-candidate> <kit-dir> <kit-previous> <pm2-app>" >&2
  exit 2
fi
APP_DIR="$1"; CANDIDATE="$2"; PREVIOUS="$3"; KIT_CANDIDATE="$4"; KIT_DIR="$5"; KIT_PREVIOUS="$6"; PM2_APP="$7"
PM2="${PM2_BIN:-pm2}"

cd "$APP_DIR"

# Preconditions, before anything moves: both candidates must exist. Nothing to undo yet.
if [ ! -d "$KIT_CANDIDATE" ]; then
  echo "deploy-swap: no kit candidate at $KIT_CANDIDATE — nothing swapped" >&2
  exit 1
fi
if [ ! -d "$CANDIDATE" ]; then
  echo "deploy-swap: no build candidate at $APP_DIR/$CANDIDATE — nothing swapped" >&2
  exit 1
fi

# What was there before we touched anything — the undo's only source of truth.
had_prev_kit=0;   [ -d "$KIT_DIR" ] && had_prev_kit=1
had_prev_build=0; [ -d .next ] && had_prev_build=1

# How far we got. The trap reads it to know what to reverse.
#   1 = old kit moved to kit-previous     2 = kit candidate moved into place
#   3 = old .next moved to previous       4 = build candidate moved into place
#   5 = pm2 restart attempted
stage=0

# restore_mv <src> <dst> — a checked move that refuses to nest. `mv dir existing-dir`
# succeeds by putting dir INSIDE existing-dir; an undo built on that would report a
# restore that did not happen.
restore_mv() {
  if [ -e "$2" ]; then
    echo "deploy-swap: cannot restore $1 → $2: $2 already exists (a plain mv would nest it)" >&2
    return 1
  fi
  if ! mv "$1" "$2"; then
    echo "deploy-swap: could not restore $1 → $2" >&2
    return 1
  fi
  return 0
}

undo() {
  local rc=$?
  trap - ERR
  echo "deploy-swap: FAILED at stage $stage (exit $rc) — undoing so the kit and the build stay a pair" >&2
  # Two kinds of failure, reported apart: a restore MOVE that failed (the files are not
  # where the closing line would claim) and a RESTART that failed (the files are right,
  # the process was not bounced — the previous process keeps serving the previous build,
  # whose chunks are back on disk, so that is consistent; a from-scratch box has no
  # previous process, so there nothing may be serving at all).
  local problems=0
  local restart_failed=0
  local kept_candidates=0
  if [ "$stage" -ge 4 ] && [ "$had_prev_build" -eq 0 ]; then
    # From-scratch box, failure after the build was swapped in: nothing to go back
    # to. Keep the candidates (build + kit, a consistent pair) and retry the restart.
    kept_candidates=1
    echo "deploy-swap: no previous build existed on this box — the candidate build and kit STAY in place" >&2
    if ! "$PM2" restart "$PM2_APP" --update-env; then restart_failed=1; fi
  else
    if [ "$stage" -ge 4 ]; then restore_mv .next "$CANDIDATE" || problems=$((problems + 1)); fi
    if [ "$stage" -ge 3 ] && [ "$had_prev_build" -eq 1 ]; then restore_mv "$PREVIOUS" .next || problems=$((problems + 1)); fi
    if [ "$stage" -ge 2 ]; then restore_mv "$KIT_DIR" "$KIT_CANDIDATE" || problems=$((problems + 1)); fi
    if [ "$stage" -ge 1 ] && [ "$had_prev_kit" -eq 1 ]; then restore_mv "$KIT_PREVIOUS" "$KIT_DIR" || problems=$((problems + 1)); fi
    if [ "$stage" -ge 5 ]; then
      # The restart itself failed (or something after it): restart again onto the
      # restored build so the process is not left serving renamed chunks.
      if ! "$PM2" restart "$PM2_APP" --update-env; then restart_failed=1; fi
    fi
  fi

  # The closing line describes what IS on disk now — read back, never the branch's
  # intent (round 3 of the review: a hardcoded "the PREVIOUS build and kit" was false
  # on the very first kit deploy, where no previous kit existed, and on a from-scratch
  # box where no build did). Each half is named from a directory test, and "none
  # existed before" is said in words when that is the case.
  local build_now kit_now candidates_now serving
  if [ -d .next ]; then
    if [ "$kept_candidates" -eq 1 ]; then build_now="the CANDIDATE build in .next (kept — no previous build existed)"; else build_now="the PREVIOUS build in .next"; fi
  elif [ -e .next ] || [ -L .next ]; then
    build_now="something that is NOT a directory sits at .next (a file or a broken link — inspect by hand; this script never creates that)"
  else
    build_now="NO build (.next is absent: none existed before this deploy, so nothing was serving then either)"
  fi
  if [ -d "$KIT_DIR" ]; then
    if [ "$kept_candidates" -eq 1 ]; then kit_now="the CANDIDATE kit in $KIT_DIR (kept with the candidate build)"; else kit_now="the PREVIOUS kit in $KIT_DIR"; fi
    if [ "$kept_candidates" -eq 1 ] && [ -d "$KIT_PREVIOUS" ]; then kit_now="$kit_now; a previous kit remains in $KIT_PREVIOUS"; fi
  elif [ -e "$KIT_DIR" ] || [ -L "$KIT_DIR" ]; then
    kit_now="something that is NOT a directory sits at $KIT_DIR (inspect by hand)"
  else
    kit_now="NO kit ($KIT_DIR is absent: none existed before this deploy; /kit/* answers 404 as it did)"
  fi
  # The candidate directories, also read back: after a restore they are where deploy.sh
  # left them; after "keep the candidates" their contents ARE .next and the kit dir.
  # Read ONLY when every restore succeeded (problems==0) — the only layouts that print
  # this sentence. On those paths the two are always in the same state: the kit candidate
  # moves at stage 2 and the build candidate at stage 4, and the undo restores both
  # whenever it restores either (stage>=4 implies stage>=2). A failed restore_mv is the one
  # way they can differ, and it sets problems>=1, which routes to the NOT FULLY RESTORED
  # layout — that layout lists every directory as present/MISSING and never reads this. So
  # inside the gate a mixed state is a bug in this script and is named as one; outside it
  # the same mixed state is an ordinary recorded restore failure, not a bug (round 7 of the
  # review: this check ran ungated and called a recorded I/O failure "a bug in this script").
  candidates_now=""
  if [ "$problems" -eq 0 ]; then
    local cand_present=0 kit_cand_present=0
    [ -d "$CANDIDATE" ] && cand_present=1
    [ -d "$KIT_CANDIDATE" ] && kit_cand_present=1
    if [ "$cand_present" -ne "$kit_cand_present" ]; then
      echo "deploy-swap: internal inconsistency — $CANDIDATE present=$cand_present, $KIT_CANDIDATE present=$kit_cand_present with no restore failure recorded; this script has a bug, inspect by hand" >&2
    fi
    if [ "$cand_present" -eq 1 ]; then
      candidates_now="candidates left in place to inspect ($CANDIDATE, $KIT_CANDIDATE)"
    else
      candidates_now="the candidate directories are gone — their contents are what is serving"
    fi
  fi
  serving="$build_now; $kit_now"

  if [ "$problems" -eq 0 ] && [ "$restart_failed" -eq 0 ]; then
    echo "deploy-swap: undo complete — on disk now: $serving. $candidates_now. The deploy did NOT happen; deploy.sh stops here." >&2
  elif [ "$problems" -eq 0 ]; then
    if [ "$kept_candidates" -eq 1 ]; then
      echo "deploy-swap: files kept in place (nothing to restore to) — on disk now: $serving; $candidates_now — but the pm2 restart FAILED TWICE (the swap's and the undo's)." >&2
    else
      echo "deploy-swap: files restored — on disk now: $serving; $candidates_now — but the pm2 restart FAILED TWICE (the swap's and the undo's)." >&2
    fi
    if [ "$had_prev_build" -eq 1 ]; then
      echo "deploy-swap: the process pm2 had before is still what runs, reading the previous build's chunks, which are back on disk — consistent, but unverified." >&2
    else
      echo "deploy-swap: no previous process existed on this box — NOTHING may be serving until a restart succeeds." >&2
    fi
    echo "deploy-swap: escalate: pm2 logs $PM2_APP; then \`$PM2 restart $PM2_APP --update-env\` by hand. The deploy did NOT happen." >&2
  else
    echo "deploy-swap: ⚠️ STATE NOT FULLY RESTORED — $problems restore step(s) failed. Nothing more is attempted automatically." >&2
    echo "deploy-swap: layout now (app dir $APP_DIR):" >&2
    for d in .next "$CANDIDATE" "$PREVIOUS" "$KIT_DIR" "$KIT_CANDIDATE" "$KIT_PREVIOUS"; do
      if [ -d "$d" ]; then echo "    present  $d" >&2; else echo "    MISSING  $d" >&2; fi
    done
    echo "deploy-swap: put the build back by hand from that layout (a serving app needs .next AND the kit that matches its page)," >&2
    echo "deploy-swap: then \`$PM2 restart $PM2_APP --update-env\`. Do NOT run another deploy until .next is present and serving." >&2
  fi
  exit "$rc"
}
trap undo ERR

# 1–2. The kit. Guarded so a first deploy (no kit yet) is not an error.
rm -rf "$KIT_PREVIOUS"
if [ "$had_prev_kit" -eq 1 ]; then mv "$KIT_DIR" "$KIT_PREVIOUS"; fi
stage=1
mv "$KIT_CANDIDATE" "$KIT_DIR"
stage=2

# 3–4. The build. Same first-deploy guard for a box with no .next yet.
rm -rf "$PREVIOUS"
if [ "$had_prev_build" -eq 1 ]; then mv .next "$PREVIOUS"; fi
stage=3
mv "$CANDIDATE" .next
stage=4

# 5. The restart, immediately — the window between the .next move and here is the
#    one the 2026-08-26 class lives in.
stage=5
"$PM2" restart "$PM2_APP" --update-env

trap - ERR
echo "deploy-swap: ok — $KIT_DIR and .next are the new build, previous kept as $KIT_PREVIOUS and $PREVIOUS, $PM2_APP restarted"
