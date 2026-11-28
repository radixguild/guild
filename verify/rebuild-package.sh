#!/usr/bin/env bash
#
# rebuild-package.sh — rebuild one deployed Scrypto package from this repository and write its
# .wasm, .rpd and SHA256SUMS. Compare the result with the chain using
# scripts/verify-package-parity.mjs (docs/AUDITOR-GUIDE.md section 5 has the full recipe).
#
#   verify/rebuild-package.sh <id> <outdir>                  # id from verify/deployed-packages.json
#   verify/rebuild-package.sh --prepare-only <id> <outdir>   # set up and check the source, do not build
#
# Needs: Linux x86_64, rustup with Rust 1.92.0 (+ rust-src, target wasm32-unknown-unknown),
# `scrypto` from radix-clis 1.3.1, Node 20+, git. The deployed bytes embed source paths under
# /root/.cargo and /root/.rustup, so the build refuses to run under any other CARGO_HOME or
# RUSTUP_HOME (set ALLOW_OTHER_HOMES=1 to build anyway; the hashes will then differ).
#
# It builds in a copy under <outdir>; the checkout is not modified. It reads nothing private, uses no
# keys and talks to no ledger. The build itself downloads the crates named in the committed Cargo.lock.

set -euo pipefail

PREPARE_ONLY=0
if [ "${1:-}" = "--prepare-only" ]; then PREPARE_ONLY=1; shift; fi
[ $# -eq 2 ] || { echo "usage: $0 [--prepare-only] <id> <outdir>" >&2; exit 2; }
ID="$1"
OUT="$2"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/verify/deployed-packages.json"

field() { # field <json path expression on the package entry>
  node -e '
    const [file, id, expr] = process.argv.slice(1)
    const m = JSON.parse(require("fs").readFileSync(file, "utf8"))
    const p = (m.packages || []).find((x) => x.id === id)
    if (!p) { console.error(`no package with id ${id} in ${file}`); process.exit(2) }
    const v = expr.split(".").reduce((o, k) => (o == null ? o : o[k]), p)
    if (v == null) process.exit(3)
    process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v))
  ' "$MANIFEST" "$ID" "$1"
}

SRC_PATH="$(field source_path)"
BLOBS_JSON="$(field source_blobs)"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
WORK="$OUT/src-$ID"
rm -rf "$WORK"
mkdir -p "$WORK"
# Copy the package directory as it is in the checkout, without any earlier build output.
tar -C "$ROOT/$SRC_PATH" --exclude=./target -cf - . | tar -C "$WORK" -xf -

# Per-package source reconstruction. Only packages whose source is not the directory as committed
# need a case here; the blob check below catches any change that does not land exactly.
case "$ID" in
  escrow-wave-b)
    rm -f "$WORK/src/nft_swap.rs"
    node -e '
      const fs = require("fs")
      const f = process.argv[1]
      const lines = fs.readFileSync(f, "utf8").split("\n")
      const start = lines.findIndex((l) => l.startsWith("// P7-02 (task 90):"))
      if (start < 0 || lines[start + 4] !== "pub mod nft_swap;" || lines[start + 5] !== "") {
        console.error("src/lib.rs: the nft_swap module block is not where expected; refusing to guess")
        process.exit(1)
      }
      lines.splice(start, 6)
      fs.writeFileSync(f, lines.join("\n"))
    ' "$WORK/src/lib.rs"
    ;;
  nft-swap) ;;
  *) echo "no reconstruction rule for id $ID (add a case, or use one of the ids in $MANIFEST)" >&2; exit 2 ;;
esac

# The source must be exactly the recorded files: every listed blob id matches, and src/ holds no
# file that is not listed.
fail=0
while IFS=$'\t' read -r path want; do
  got="$(git hash-object "$WORK/$path" 2>/dev/null || echo missing)"
  if [ "$got" = "$want" ]; then echo "source ok  $path  $got"; else echo "SOURCE MISMATCH  $path  got $got  want $want" >&2; fail=1; fi
done < <(node -e 'for (const [k, v] of Object.entries(JSON.parse(process.argv[1]))) console.log(`${k}\t${v}`)' "$BLOBS_JSON")
while IFS= read -r f; do
  rel="src/${f#"$WORK/src/"}"
  node -e 'process.exit(Object.hasOwn(JSON.parse(process.argv[1]), process.argv[2]) ? 0 : 1)' "$BLOBS_JSON" "$rel" \
    || { echo "SOURCE MISMATCH  $rel is not in source_blobs" >&2; fail=1; }
done < <(find "$WORK/src" -type f | sort)
[ "$fail" -eq 0 ] || { echo "source does not match the recorded blobs for $ID; not building" >&2; exit 1; }

if [ "$PREPARE_ONLY" -eq 1 ]; then echo "prepared $WORK (not built)"; exit 0; fi

if [ "${ALLOW_OTHER_HOMES:-0}" != "1" ]; then
  [ "${CARGO_HOME:-$HOME/.cargo}" = "/root/.cargo" ] && [ "${RUSTUP_HOME:-$HOME/.rustup}" = "/root/.rustup" ] || {
    echo "CARGO_HOME must be /root/.cargo and RUSTUP_HOME /root/.rustup (the deployed bytes embed those paths)." >&2
    echo "Set ALLOW_OTHER_HOMES=1 to build anyway; the hashes will not match." >&2
    exit 2
  }
fi

cd "$WORK"
echo "rustc:   $(rustc --version)"
echo "cargo:   $(cargo --version)"
echo "scrypto: $(scrypto --version)"
rustc --version | grep -q '^rustc 1\.92\.0 ' || { echo "rustc 1.92.0 required" >&2; exit 2; }
scrypto --version | grep -q '1\.3\.1' || { echo "scrypto CLI 1.3.1 (radix-clis 1.3.1) required" >&2; exit 2; }

cargo fetch --locked
SCRYPTO_CARGO_LOCKED=true scrypto build

name="$(node -e 'const t=require("fs").readFileSync("Cargo.toml","utf8");const m=t.match(/^name\s*=\s*"([^"]+)"/m);process.stdout.write(m[1].replace(/-/g,"_"))')"
for ext in wasm rpd; do
  f="target/wasm32-unknown-unknown/release/$name.$ext"
  [ -s "$f" ] || { echo "missing build output $f" >&2; exit 1; }
  cp "$f" "$OUT/$ID.$ext"
done
cd "$OUT"
sha256sum "$ID.wasm" "$ID.rpd" | tee SHA256SUMS
