#!/bin/bash
# kit-carry-forward.sh — keep every previously served VERSIONED kit twin serving.
#
#   scripts/kit-carry-forward.sh <live-kit-dir> <candidate-kit-dir> <kit-name> [<kit-name>...]
#
# WHY (agent-pr-review on PR #803, round 3): the deploy rebuilds the kit candidate from
# scratch and swaps it in as one directory, so a candidate holds only the CURRENT
# version's <name>.tgz and <name>-<version>.tgz. A config that pinned an older versioned
# URL — which the READMEs tell long-lived configs to do, because npx caches an install by
# URL — would 404 the moment a later deploy bumped that kit's version, with no overlap.
#
# So, after both packs and before the swap, copy every <name>-<version>.tgz (+ .sha256)
# that is live but not in the candidate INTO the candidate. The current twin always wins
# (never overwritten). A live twin whose bytes no longer match its own .sha256 — or whose
# tarball is gone — is REFUSED: its bytes are not carried, so a corrupted file cannot
# propagate forward under a trusted name, but its RECORD (.sha256) IS carried, without the
# bytes, and — when it is THIS script that dropped the bytes — a one-line <file>.refused note
# beside it saying when and why, so the watcher can tell that case from a tarball someone
# removed by hand (INCIDENTS 4.8 step 1). That record is what keeps the twin's URL in the watcher's list
# (guild-app/scripts/lib/kit-hash.mjs versionedKits lists records), so the URL pages as a
# 404 every run until that version is re-served or an operator RETIRES the twin with a
# <file>.retired note: from the next deploy on this script carries that twin's record and
# note but never its bytes again, so the URL 404s and the watcher treats that as intended
# (until then the twin keeps serving). Precedence: the candidate's own twin always wins — a
# later deploy that re-serves a retired version supersedes the note (a KEEP line says so; the
# guard has proven the bytes). A note whose record is gone is never visited by the loop and
# is named as an ORPHAN on stderr rather than vanishing quietly — round 5 of the review found that a refused twin
# simply vanished from the box and from the watcher, leaving every config pinned to it on a
# silent, permanent 404. RECORDS ARE NEVER DELETED: they are kit-version-guard.mjs's memory
# of which bytes a version meant, and round 9 found that "remove the record by hand" — the
# remedy this script used to print — was exactly how to make that guard forget a version.
# Idempotent; a first deploy (no live dir)
# is a no-op. Only the NAMED kits' twins are considered, and only files whose suffix is
# version-shaped (<name>-<major>.<minor>.<patch>[-pre][+build].tgz.sha256): a kit whose own
# name carries a dash (pack-kit allows one) can never be mistaken for another kit's twin,
# and a retired kit's twins stop being carried the moment it leaves the list.
#
# Exit 0 always on a completed run: a missing or empty live dir is the first deploy; a refused,
# retired, orphaned or UNREADABLE file is reported, never fatal — this step must never block a
# deploy over what it finds in the LIVE dir. The one fatal class, by design: a CANDIDATE dir
# this script cannot write to (a failed `cp`/`printf` into $CAND under set -e). A half-built
# candidate must not reach the swap, so that stops the deploy where it stands. Exit 2 = bad args.
set -euo pipefail

if [ $# -lt 3 ]; then
  echo "usage: kit-carry-forward.sh <live-kit-dir> <candidate-kit-dir> <kit-name> [<kit-name>...]" >&2
  exit 2
fi
LIVE="$1"; CAND="$2"; shift 2
for k in "$@"; do
  case "$k" in *[!a-z0-9-]*|"") echo "kit-carry-forward: bad kit name '$k'" >&2; exit 2 ;; esac
done
[ -d "$CAND" ] || { echo "kit-carry-forward: candidate dir $CAND does not exist" >&2; exit 2; }
if [ ! -d "$LIVE" ]; then
  echo "kit-carry-forward: no live kit dir at $LIVE — first deploy, nothing to carry"
  exit 0
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
else
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

# The first line of an operator's note, or a stated blank — never empty parens (round 12).
note_line() {
  local l; l="$(head -n1 "$1" 2>/dev/null || true)"
  case "$l" in *[![:space:]]*) ;; *) l="" ;; esac   # whitespace-only counts as empty (round 13)
  printf '%s' "${l:-no reason given}"
}
# copy_note <src> <dst> <label> — a note that cannot be READ is SAID and skipped, never fatal
# (round 13 of the review: a bare cp of an unreadable .retired aborted the whole step under
# set -e). The WRITE into the candidate stays a bare cp: if THAT fails the step must stop, per
# the contract above — round 14 of the review found the first cut swallowed both and blamed
# the source for a destination it could not write.
copy_note() {
  if [ ! -r "$1" ]; then
    echo "  WARN   $3 — cannot read $(basename "$1") ($([ -e "$1" ] && printf 'permissions?' || printf 'dangling symlink')); the note is NOT carried" >&2
    unreadable=$((unreadable + 1))
    return 0
  fi
  cp "$1" "$2"
}

carried=0; kept=0; refused=0; retired=0; unreadable=0
shopt -s nullglob
# Version-shaped suffix: semver core, optional -prerelease and +build (npm's own grammar).
VER_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
for sha_file in "$LIVE"/*.tgz.sha256; do
  tgz="${sha_file%.sha256}"
  base="$(basename "$tgz")"
  stem="${base%.tgz}"
  matched=""
  for k in "$@"; do
    case "$stem" in
      "$k"-*) if printf '%s' "${stem#"$k"-}" | grep -Eq "$VER_RE"; then matched="$k"; fi ;;
    esac
    [ -n "$matched" ] && break
  done
  [ -n "$matched" ] || continue
  if [ ! -r "$sha_file" ]; then
    # -e false with the glob having matched = a symlink whose target is gone; otherwise a
    # permission bit (round 14 of the review: one message blamed permissions for both).
    if [ -e "$sha_file" ]; then why="unreadable (permissions?)"; else why="a dangling symlink"; fi
    echo "  SKIP   $base — its record $(basename "$sha_file") is $why; nothing of it is carried" >&2
    unreadable=$((unreadable + 1))
    continue
  fi
  if [ -e "$CAND/$base" ]; then
    kept=$((kept + 1))
    if [ -f "$LIVE/$base.retired" ]; then
      # The candidate re-serves a version an operator had retired (a deliberate re-release;
      # kit-version-guard.mjs has already proven the bytes). The re-serve wins and the note
      # is superseded — said out loud, never silently (round 11 of the review).
      echo "  KEEP   $base — the candidate re-serves this version; the live .retired note ($(note_line "$LIVE/$base.retired")) is superseded and not carried"
    fi
    continue
  fi
  if [ -f "$LIVE/$base.retired" ]; then
    # Retired by an operator (a one-line <file>.retired note beside the record): the record
    # and the note travel, the BYTES stop here — this is the deploy that ends serving that
    # URL, whatever state the live tarball is in. The record keeps kit-version-guard.mjs's
    # memory of the version. (Round 10 of the review: the plain CARRY branch below used to
    # copy the bytes and drop the note, so a retirement silently reversed on the next deploy.)
    cp "$sha_file" "$CAND/$base.sha256"
    copy_note "$LIVE/$base.retired" "$CAND/$base.retired" "$base"
    echo "  RETIRE $base — retired by an operator ($(note_line "$LIVE/$base.retired")); record and note carried, bytes not — the URL 404s from this deploy on"
    retired=$((retired + 1))
    continue
  fi
  if [ ! -f "$tgz" ]; then
    # Record without bytes: an earlier deploy refused this twin (its .refused note says so and
    # is carried with the record) or someone removed the tarball (no note — INCIDENTS 4.8 step 1
    # is one way). Carry the record again so the URL stays watched; never invent the bytes.
    cp "$sha_file" "$CAND/$base.sha256"
    if [ -f "$LIVE/$base.refused" ]; then copy_note "$LIVE/$base.refused" "$CAND/$base.refused" "$base"; fi
    echo "  REFUSE $base — .sha256 present but the tarball is missing on the live box; record carried, bytes not (the URL stays a watched 404)"
    refused=$((refused + 1))
    continue
  fi
  if [ ! -r "$tgz" ]; then
    cp "$sha_file" "$CAND/$base.sha256"
    echo "  REFUSE $base — the live tarball is unreadable (permissions?); record carried, bytes not (the URL becomes a watched 404)"
    refused=$((refused + 1)); unreadable=$((unreadable + 1))
    continue
  fi
  expected="$(cut -d' ' -f1 "$sha_file")"
  actual="$(sha256_of "$tgz")"
  if [ "$actual" != "$expected" ]; then
    # The one case where THIS script drops the bytes: say so on disk, beside the record, so the
    # watcher can tell "the deploy refused it" from "someone removed it" (round 7 of the review).
    cp "$sha_file" "$CAND/$base.sha256"
    printf 'refused %s by kit-carry-forward: live bytes %s… did not match the record %s…\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${actual:0:16}" "${expected:0:16}" > "$CAND/$base.refused"
    echo "  REFUSE $base — live bytes (${actual:0:16}…) do not match its own .sha256 (${expected:0:16}…); record carried with a .refused note, bytes not (the URL becomes a watched 404)"
    refused=$((refused + 1))
    continue
  fi
  cp "$tgz" "$CAND/$base"
  cp "$sha_file" "$CAND/$base.sha256"
  echo "  CARRY  $base (${expected:0:16}…)"
  carried=$((carried + 1))
done

# A note with no record beside it (.retired or .refused for a <file>.tgz whose .sha256 is
# gone) is never visited by the loop above — it would vanish on the swap without a word.
# Say so: the record it belonged to should never have been deleted (see the header).
orphans=0
for note in "$LIVE"/*.tgz.retired "$LIVE"/*.tgz.refused; do
  stem="${note%.retired}"; stem="${stem%.refused}"
  if [ ! -f "$stem.sha256" ]; then
    echo "  ORPHAN $(basename "$note") — no $(basename "$stem").sha256 beside it; NOT carried (its record was deleted, which nothing in this repo advises)" >&2
    orphans=$((orphans + 1))
  fi
done

echo "kit-carry-forward: carried $carried, already current $kept, refused $refused, retired $retired"
[ "$orphans" -eq 0 ] || echo "kit-carry-forward: ⚠️ $orphans note(s) without a record were left behind (listed above); the guard has no memory of those versions." >&2
[ "$unreadable" -eq 0 ] || echo "kit-carry-forward: ⚠️ $unreadable file(s) could not be read (listed above) — fix their permissions in the live kit dir and deploy again; this step never blocks a deploy." >&2
[ "$refused" -eq 0 ] || echo "kit-carry-forward: ⚠️ a refused twin 404s after this deploy — its bytes did not match its own record, or were already gone. Its record (and, when this script dropped the bytes, a .refused note) stays on the box so guild-app/scripts/kit-hash-watch.mjs keeps paging that URL (once its cron is installed) until that version is re-served with its original bytes or you RETIRE it: printf 'retired %s — <why>\\n' \"\$(date -u +%FT%TZ)\" > <live kit dir>/<name>-<version>.tgz.retired. Never delete a .tgz.sha256: it is kit-version-guard.mjs's memory of which bytes that version meant." >&2
exit 0
