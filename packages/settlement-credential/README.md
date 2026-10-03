# @radix-guild/settlement-credential

**Status: draft slice, built as a DRAFT PR so it costs nothing to decline.** This
implements decision 6 of the 2026-09-04 "Guild Reality Check" (`decision doc, private
artifact 56bc2f4c…`): *build the credential slice*. It has not been reviewed or
approved — nobody has clicked anything yet.

## What this is

A small, dependency-light package that turns a settled Guild task into a
**`TaskSettlementCredential`**: a signed, chain-agnostic, verifiable JSON receipt,
plus a static profile page that lists credentials and verifies them **in the
visitor's own browser** — nobody has to trust the list on its own say-so.

The shape, straight from the decision doc: the Guild witnesses the settlement
(`did:web:radixguild.com`), the worker and poster each co-sign
(`did:key`), and — crucially — **no score is stored anywhere**. A reputation score,
if one is ever computed, is recomputed at query time from the credentials
themselves, and only counts once **≥3 distinct funders** exist. This package issues
raw receipts. It does not compute or publish a score.

## What this is NOT

- **Not a live product.** Nothing here is wired into `guild-app`, no route serves
  it, and `profile/index.html` is not linked from anywhere the public can reach.
- **Not signed with a real key.** The one credential this package ships
  (`src/fixtures/unsigned-credential.task3.json`) has `"proofs": []` and the
  profile page labels it **UNSIGNED** — because it is. The real hand-signing
  ceremony (bigdev's `did:web:radixguild.com` witness key, plus the task's actual
  worker/poster keys) is **operator work**, not something this slice does for you.
  See "The ceremony (operator, later)" below.
- **Not a score.** `amount_xrd`, `outcome`, etc. are raw facts about one task. Nothing
  aggregates them. Every existing example this package could draw on
  (see the fixture) is between the operator's own wallets — self-dealt, disclosed as
  such, and explicitly not evidence of anything beyond "the mechanism runs."

## Why WebCrypto Ed25519, not a new dependency

Neither `packages/agent-client` nor `packages/agent-mcp` already depends on an
ed25519 library shaped for bundling into a static page — `agent-client`'s Ed25519
need is met by `@radixdlt/radix-engine-toolkit`, a WASM-backed dependency built for
signing Radix transactions, not for a 6 KB browser bundle. Per the brief's own
fallback rule ("prefer noble if already present, otherwise WebCrypto with a
documented Node ≥20 requirement"), this package uses **WebCrypto's native Ed25519**
(`crypto.subtle.sign/verify/importKey/exportKey('Ed25519', …)`) everywhere:

- **Node ≥ 20** — confirmed working with this repo's Node 22 (`node -e` smoke test,
  round-tripped a keypair, signed, and verified).
- **Bun 1.3.12** — same API, confirmed working (`bun test` exercises it directly).
- **Browser** — Chrome 135+, Firefox 130+, Safari 17+ all ship WebCrypto Ed25519. The
  profile page's own in-page verifier is browser-tested (see "Browser verification,
  tested" below); older browsers will show a JS error when clicking Verify rather
  than silently failing.

No new `package.json` dependency was added anywhere in this repo.

## Package contents

```
src/
  schema.ts             TaskSettlementCredential v0.1 types + buildUnsignedCredential()
  jcs.ts                RFC 8785 JSON Canonicalization (JCS) — what proofs sign over
  base58.ts             base58btc (multibase 'z' prefix) — no dependency
  did-key.ts            did:key encode/decode (Ed25519, multicodec 0xed01)
  did-web.ts            did:web URL resolution + verificationMethod lookup (fixture-driven, no network in tests)
  sign.ts               generateThrowawaySigningKey(), addProof() — WebCrypto Ed25519
  verify.ts             verifyCredential() — recomputes JCS bytes, checks every proof, flags a missing witness
  build-from-receipt.ts fetchCommittedDetails() (real Gateway call) + buildCredentialFromReceipt() (pure, degrades to state_version:null on failure)
  build-fixture-cli.ts  regenerates src/fixtures/* — `bun run build-fixture`
  browser-verifier.ts   entry point bundled into profile/verifier.bundle.js — `bun run build-verifier`
  index.ts              barrel export
  *.test.ts             50 tests, all passing (bun test)
  fixtures/
    unsigned-credential.task3.json             the ONE real, unsigned demo credential
    unsigned-credential.task3.provenance.json  where every field came from, incl. the failed Gateway read
profile/
  index.html            static page: lists credentials.json, verifies each in-browser
  credentials.json      the one fixture, wrapped with a label + notice
  verifier.bundle.js    bun-bundled IIFE of jcs.ts + verify.ts (same source, not a hand-ported copy)
```

## The one real fixture, and what "real" means here

`src/fixtures/unsigned-credential.task3.json` describes a **genuinely settled**
Guild task: task 3's `auto_resolve_dispute` on the PULL escrow component, which
committed on mainnet 2026-08-26T13:53:43Z. Every field traces to a specific line in
the project's own record (cited in `build-fixture-cli.ts` and in the
fixture's own `.provenance.json` sibling). That record — `docs/PROJECT-STATE.md` and
`docs/ESCROW-ADDRESSES.md` below — is kept in the private operations repository, and its
line numbers are as of when the fixture was built; the transaction and the component
themselves are public on the Radix ledger:

| field | value | source |
|---|---|---|
| `settlement_tx` | `txid_rdx1xjcqadt7nz…` | `docs/PROJECT-STATE.md:6407` |
| `escrow_component` | `component_rdx1cz468e…akd82f` | `docs/PROJECT-STATE.md:2564` |
| `outcome` | `dispute_resolved` | the leg was `auto_resolve_dispute` |
| `amount_xrd` | `10` | `docs/PROJECT-STATE.md:6414-6416` — `SettlementCreditedEvent{worker_entitled: 10, poster_entitled: 11}`; this credential attests to the **worker's** leg |
| `resource` | native XRD | `docs/ESCROW-ADDRESSES.md:61` |
| `review_window_closed_at` | `2026-08-26T13:53:43Z` | the `auto_resolve_dispute` commit itself — for an already-disputed task, its own terminal call is the point of finality |

Two fields are **not** real:

- **`poster`/`worker` did:keys** are throwaway demo keys generated by
  `build-fixture-cli.ts`. `docs/PROJECT-STATE.md` names the real task's Radix
  account addresses, not Ed25519 did:keys — a real ceremony would need the parties'
  actual signing keys, which this slice does not have or generate.
- **`state_version` is `null`.** `build-fixture-cli.ts` calls the real Gateway
  (`POST https://mainnet.radixdlt.com/transaction/committed-details`) for this
  intent hash, and **the call failed** while this PR was built:

  ```
  HTTP 500 {"message":"The Gateway API cannot return current results as its
  database is not sufficiently up to date with the Network's Ledger (it is
  currently 4 days, 52 minutes, 19 seconds behind)","code":500,
  "details":{"type":"NotSyncedUpError", ...}}
  ```

  That's the ongoing mainnet halt (since 2026-08-31), not a bug in this package —
  `buildCredentialFromReceipt()` is specifically designed to degrade to
  `state_version: null` on a Gateway failure rather than throw, because a
  chain-agnostic receipt should still be constructible when the one
  chain-specific field is temporarily unavailable. `null` here means
  **witness-only**: a verifier should not treat this credential as chain-pinned,
  only as attesting to what its (in this case, absent) signers claim happened. Once
  mainnet resumes, re-running `bun run build-fixture` will pin a real
  `state_version` automatically — no code change needed.

The fixture's header (`unsigned-credential.task3.provenance.json`'s `notice` field,
and the profile page's own on-screen banner) states plainly: **self-dealt mechanism
demo, not evidence.**

## Verified: tests, types, and the browser

- **`bun test src/` — 50 pass, 0 fail, 82 `expect()` calls** (ran in this PR).
  Covers: JCS key-ordering including the UTF-16-vs-code-point edge case RFC 8785
  actually turns on; base58btc round-trips; a did:key known-answer vector (see
  below); did:web resolution against a fixture document (no network); sign+verify
  round-trip, missing-witness detection, tamper detection (credentialSubject
  tampering breaks every proof; corrupting one proof's signature leaves the other
  untouched), and a wrong-key forgery attempt; `buildCredentialFromReceipt`'s
  Gateway-success and Gateway-failure paths (the failure path is exercised with the
  actual error text this PR's own halt-era Gateway call returned).
- **`bun x tsc --noEmit` — clean.**
- **Browser-tested, not just asserted.** `profile/index.html` was served locally
  (`python3 -m http.server`) and driven with a real browser: the shipped UNSIGNED
  fixture correctly shows an "UNSIGNED" badge and a "nothing to check yet" message
  on Verify; a temporary hand-signed test credential (worker + witness proofs, not
  committed) verified **VALID** with both proofs reported OK; a tampered copy of
  that same credential (bumped `amount_xrd`) correctly verified **INVALID**, both
  proofs failing with "signature does not match." All three checks ran with zero
  browser console errors.

### did:key known-answer vector — how it was actually verified

`did-key.test.ts` hardcodes one known-answer did:key string. Rather than trust a
memorized "the spec's example," it was built and cross-checked in this PR:

1. RFC 8032 §7.1's Ed25519 test vector 1 (secret seed `9d61b19d…cae7f60`) was
   regenerated with Node's own `node:crypto` (PKCS8-wrapped seed import). Signing
   the empty test message with the derived key reproduced RFC 8032's own published
   signature **byte-for-byte** — proof the derived public key is the genuine
   vector, not a transcription slip. (An earlier hand-typed attempt at this
   constant *was* off by one trailing byte, caught by exactly this check.)
2. The did:key string was computed by an independent base58btc + multicodec
   implementation written in Python — not this package's TypeScript — and the two
   agreed.

So it's a real, externally-reproducible vector; it is not claimed to be "the"
official did:key-spec worked example, because that specific claim was never
independently checked.

## The ceremony (operator, later)

This slice deliberately stops short of producing a signed credential. When
bigdev is ready:

1. Pick a real settled task (the fixture's task 3 is a fine first choice — it's
   already fully sourced above).
2. Derive the task's actual worker/poster identities to Ed25519 keys they hold
   (or accept that a first round is necessarily self-dealt-but-real, per the
   decision doc — the point of the 30-day test is external operators, not this
   one credential).
3. Stand up `did:web:radixguild.com`'s own witness key and publish its DID
   document at `https://radixguild.com/.well-known/did.json` (`did-web.ts`
   resolves exactly that path).
4. Call `addProof()` three times (`worker`, `poster`, `witness`) with real
   `CryptoKey`s — `importEd25519PrivateKeyPkcs8()` is provided for importing real
   key material; `generateThrowawaySigningKey()` is for demos only and says so in
   its own doc comment.
5. Commit the signed credential to `profile/credentials.json` (or serve it from
   wherever the real profile page ends up living) and run the 30-day test from
   decision 6: **kill at 0-for-5 verify-and-commit responses from x402/ACP agent
   operators within 30 days.**

None of this is money-moving code — no signer, no escrow call, no vault, no
trading pause. It produces a JSON document. The escrow blueprint, the keeper, the
reconcilers, and every other money-path file in this repo are untouched by this PR.

## Commands

```bash
cd packages/settlement-credential
bun install
bun test src/            # 50 pass, 0 fail
bun x tsc --noEmit       # clean
bun run build-fixture    # regenerate src/fixtures/* (hits the real Gateway; degrades gracefully if it 500s)
bun run build-verifier   # rebuild profile/verifier.bundle.js from src/browser-verifier.ts
```

To preview the profile page locally (a plain `file://` open will not work — the
`fetch('./credentials.json')` call needs http(s)):

```bash
cd packages/settlement-credential/profile
python3 -m http.server 8787
# open http://localhost:8787
```
