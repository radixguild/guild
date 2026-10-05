#!/bin/bash
# pack-kit.sh — build ONE distributable kit tarball the way the deploy serves it.
#
#   scripts/pack-kit.sh --pkg packages/agent-client --name agent --out /some/dir
#
# Produces, in --out:
#   <name>.tgz          `npm pack` of the package, renamed (npm names it by scope+version)
#   <name>.tgz.sha256   "<hex>  <name>.tgz" — the `shasum -a 256 -c` / `sha256sum -c` format,
#                       so the check the site tells people to run is one command
#   <name>.json         {name, package, version, sha256, bytes, files, git, packedAt, versioned}
#   <name>-<version>.tgz (+ .sha256)  the same bytes under a URL that changes with the version —
#                       for long-lived configs, because npx caches an install by URL (see step 5)
#
# ONE IMPLEMENTATION, TWO CALLERS. The deploy script (kept in the private operations
# repository) runs this on the box into /opt/guild-saas/kit-candidate (swapped into
# /opt/guild-saas/kit in the same command that swaps the app build — Bring Your Agent design
# note §2.4, private operations repository). The private CI ran the SAME script, served the
# result over loopback HTTP and ran the exact one-liner a person pastes:
# `npx -y -p http://…/agent.tgz guild-agent --help`, then `sha256sum -c` on the served pair.
# This repository's workflow (.github/workflows/test.yml) trims that step — it needs the leak
# gate below, which stays private — and keeps a plain `npm pack` + scratch-consumer install.
# So what the box serves is what this one script packs — a second, hand-rolled pack step in
# either place is how the two drift apart.
#
# WHAT IT GUARDS, IN ORDER:
#   1. `npm run build` in the package — dist/ is rebuilt from the checked-out source, never
#      reused. A stale dist/ would serve old code under a new source tree and a hash CI has
#      never seen. Built first so the gate below scans exactly the files that will ship.
#   2. scripts/publish-gate.mjs — the DENY-by-class leak gate (it exists because a pack once
#      shipped 25 kB of mainnet intent hashes). Red = nothing is packed. Not skippable.
#   3. `npm pack` — the `files` allowlist in package.json decides what ships; this script adds
#      nothing and removes nothing.
#   4. The hash is computed from the FINAL file, after the rename, by the same tool the check
#      on /agents names (sha256sum on the box and in CI; shasum -a 256 on a Mac).
#
# EXIT: 0 = packed. 1 = gate red / build failed / pack failed (nothing usable left in --out).
#       2 = bad arguments.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PKG=""
NAME=""
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pkg) PKG="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    -h | --help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "pack-kit: unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$PKG" ] || [ -z "$NAME" ] || [ -z "$OUT" ]; then
  echo "Usage: scripts/pack-kit.sh --pkg <package dir, relative to the repo root> --name <kit name> --out <dir>" >&2
  exit 2
fi
case "$NAME" in
  *[!a-z0-9-]*) echo "pack-kit: --name must be [a-z0-9-] (it becomes a URL path segment): $NAME" >&2; exit 2 ;;
esac
PKG_DIR="$ROOT/$PKG"
[ -f "$PKG_DIR/package.json" ] || { echo "pack-kit: no package.json at $PKG_DIR" >&2; exit 2; }

# sha256 tool: coreutils on the box and in CI, shasum on a Mac. Same algorithm, same hex.
if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
else
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

echo "pack-kit: $PKG → $OUT/$NAME.tgz"

# 1. Rebuild dist/ from source. `npm run build` is the package's own definition of a build.
#    BEFORE the gate, so the gate scans the dist/ that is about to ship, not a stale one.
echo "  → npm run build ($PKG)"
(cd "$PKG_DIR" && npm run build --silent)

# 2. The leak gate, on the whole package set — red means stop, with nothing written.
echo "  → publish gate (deny-by-class leak scan)"
if ! (cd "$ROOT" && node scripts/publish-gate.mjs); then
  echo "pack-kit: PUBLISH GATE RED — nothing packed. Fix the listed problem; do not bypass the gate." >&2
  exit 1
fi

# 3. Pack into a scratch dir, then move into place under the served name.
mkdir -p "$OUT"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "  → npm pack"
pack_json="$(cd "$PKG_DIR" && npm pack --json --pack-destination "$tmp" 2>/dev/null)"
packed="$(printf '%s' "$pack_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(j[0].filename)})')"
[ -f "$tmp/$packed" ] || { echo "pack-kit: npm pack reported $packed but the file is missing" >&2; exit 1; }
rm -f "$OUT/$NAME.tgz" "$OUT/$NAME.tgz.sha256" "$OUT/$NAME.json"
mv "$tmp/$packed" "$OUT/$NAME.tgz"

# 4. Hash the final file, write the check file in `-c` format, and a small metadata record.
sha="$(sha256_of "$OUT/$NAME.tgz")"
printf '%s  %s\n' "$sha" "$NAME.tgz" > "$OUT/$NAME.tgz.sha256"
bytes="$(wc -c < "$OUT/$NAME.tgz" | tr -d ' ')"
version="$(node -p "require('$PKG_DIR/package.json').version")"
pkgname="$(node -p "require('$PKG_DIR/package.json').name")"
files="$(printf '%s' "$pack_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(String(j[0].entryCount))})')"
git_head="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
packed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"name":"%s","package":"%s","version":"%s","sha256":"%s","bytes":%s,"files":%s,"git":"%s","packedAt":"%s","versioned":"%s"}\n' \
  "$NAME" "$pkgname" "$version" "$sha" "$bytes" "$files" "$git_head" "$packed_at" "$NAME-$version.tgz" > "$OUT/$NAME.json"

# 5. The VERSIONED twin — same bytes under a URL that changes with the version.
#    `npx -y -p <url>` caches an install by the URL it was given (its npx-cache key is a
#    hash of the spec string, and its "already installed" check compares the resolved
#    URL — not the package version, not the bytes; measured 2026-09-28, agent-pr-review on
#    #803). So a machine that has run the stable URL once keeps that build for every later
#    deploy at the same URL, version bump or not, until its ~/.npm/_npx is cleared. A
#    long-lived configuration (an MCP client entry) should therefore pin
#    <name>-<version>.tgz: an update is then a visible URL change, never a silent stale
#    reuse. The stable <name>.tgz stays for one-shot use (the pairing one-liner).
cp "$OUT/$NAME.tgz" "$OUT/$NAME-$version.tgz"
printf '%s  %s\n' "$sha" "$NAME-$version.tgz" > "$OUT/$NAME-$version.tgz.sha256"
[ "$(sha256_of "$OUT/$NAME-$version.tgz")" = "$sha" ] || { echo "pack-kit: versioned copy does not hash like the original" >&2; exit 1; }

echo "  packed  $pkgname@$version  $files files  $bytes bytes"
echo "  sha256  $sha"
echo "  wrote   $OUT/$NAME.tgz  $OUT/$NAME.tgz.sha256  $OUT/$NAME.json"
echo "  wrote   $OUT/$NAME-$version.tgz  $OUT/$NAME-$version.tgz.sha256  (versioned twin, same bytes)"
