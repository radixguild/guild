// RETIRED escrow components. History / backfill reads ONLY — NEVER transact
// against anything in this file.
//
// ⚠️ THIS MODULE MUST NEVER BE IMPORTED BY APP RUNTIME CODE. It lives outside
// `config.ts` for one measured reason: `scripts/launch-check.sh` CHECK 7 asserts
// that the BUILT artifact contains EXACTLY ONE escrow-shaped component, then has
// the chain classify it (push carries `heartbeat_fee_xrd`, pull carries
// `expire_grace_secs`). That is how the box knows which escrow it actually baked.
//
// When these constants lived in `config.ts` the invariant broke on 2026-08-18:
// `ESCROW_COMPONENT_HISTORY` was built with `Object.freeze([...])`, and a
// module-scope call is not something the bundler will drop, so the array — and
// the two retired literals inside it — stayed in the server chunks. CHECK 7 then
// found THREE components and failed closed, blocking the deploy. Note that
// `ESCROW_COMPONENT_LEGACY` had sat in `config.ts` for months without tripping
// it, because nothing imported it and it was tree-shaken away. The bug was not
// the address; it was depending on tree-shaking to keep a gate's invariant true.
//
// Importing this from anything in `src/app/**` or `src/components/**` will bake
// a retired address back into the artifact and turn the gate red again.
// `tests/unit/about-claims.test.tsx` pins that rule so CI catches it, rather
// than the operator discovering it mid-deploy.

// Pre-cutover v1 escrow component (superseded by the vNext §8b cutover LIVE
// 2026-06-14). DEAD.
export const ESCROW_COMPONENT_LEGACY =
  "component_rdx1cz9mh49guszgssxwwsnvh47ug5lgkhtjqtfc0sp0gr2q6qy6t796s7";

// Every RETIRED escrow component, newest first.
//
// ⚠️ This list must be EXPLICIT, never derived from "current minus one". Each
// component restarts `next_task_id` at 1, so `tasks.on_chain_task_id` collides
// across ALL of them — the collision is now four-way (v1 · push · pull · Wave B), and
// `scripts/backfill-escrow-component.mjs` disambiguates a historic row by
// reading its fund tx's TaskCreatedEvent emitter across the candidate set.
// Before 2026-08-17 that script computed its candidates as
// `[ESCROW_COMPONENT, ESCROW_COMPONENT_LEGACY]`, so the moment the pointer moved
// to the PULL component the PUSH component silently dropped OUT of the set and
// any still-NULL row funded on it became permanently unresolvable. Append here
// at every cutover, in the same commit that moves ESCROW_COMPONENT.
export const ESCROW_COMPONENT_HISTORY: readonly string[] = Object.freeze([
  // pull / P2 — LIVE 2026-08-17 → 2026-09-13, retired IN PLACE by the Wave B
  // cutover (XRD whitelist entry frozen forever, ruled 2026-09-07 decision 64;
  // zero non-terminal tasks and zero uncollected entitlements at G4).
  // ⚠️ Appended 2026-09-14, a day LATE: the Wave B cutover moved the pointer by
  // env (.env.local on the box) and touched neither this file nor config.ts's
  // defaults — exactly the miss the paragraph above warns about, and for the
  // same reason as before (the pointer moved, nothing forced the list to). Any
  // task funded on this component with a still-NULL `tasks.escrow_component`
  // is unresolvable by the backfill until this entry exists. tests/unit/
  // escrow-address-drift.test.ts now requires every retired EscrowComponent
  // row in docs/ESCROW-ADDRESSES.md to be listed here.
  "component_rdx1cz468eqyr0fklyrlcsznadrwfnqnesw37vlm9j0xmq2s7427akd82f",
  // push / vNext §8b — LIVE 2026-06-14 → 2026-08-17, retired by the P2 PULL cutover
  "component_rdx1cr690hkrk2kv933cw3qdr6amkaphdlu2whjhhh8wppus922yx335r2",
  ESCROW_COMPONENT_LEGACY,
]);
