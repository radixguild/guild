import { NextResponse } from "next/server"
import { NETWORK_HALT_AFTER_SECONDS, operatorHaltEngaged, readLedgerTip } from "./gateway"

/**
 * chain-halt-gate.ts — the server-side half of P1 (docs/design/security-hardening.md).
 *
 * P1 says the halt flag "blocks transaction-building, keeps read-only browsing alive with
 * an explanatory banner." Until this file, only the second half was true: `readLedgerTip`
 * and `operatorHaltEngaged` were read by exactly two routes — `/api/v1/network/status` and
 * `/api/v1/quote/xrd-usd` — both of which only *report*. Every mutating route was open. So
 * the halt was a banner the browser drew, and a direct API call walked straight past it.
 *
 * ONE definition, imported by every gated route — the same discipline `agent-lane.ts`
 * documents, for the same reason (two hand-kept copies of "the same" gate diverged
 * silently once already in this repo).
 *
 * ## What it gates, and why exactly this surface
 *
 * A route belongs here when it STARTS something whose next step is a signature the chain
 * cannot accept. Letting one through during a halt does not just fail — it strands a user
 * inside a lifecycle, holding a DB row whose on-chain counterpart can never exist:
 *
 *  - `POST /api/v1/tasks` — creating a task whose next step is funding escrow on-chain.
 *    The create page already shows the frozen notice from `/escrow/posting-status`, but
 *    that is client-side; a direct call still made an unfundable task.
 *  - `POST /api/v1/tasks/[id]/submissions` — the worker's work record. Its counterpart is
 *    an on-chain claim carrying a bond.
 *  - `POST /api/v1/submissions/[id]/review` — approval, whose counterpart is the on-chain
 *    release of the task vault.
 *  - `POST /api/v1/tasks/[id]/dispute-evidence` — evidence for a dispute that is resolved
 *    on-chain by the arbiter.
 *  - `POST /api/v1/funding-pools` and its `pledge` / `refund` — the crowdfund lane. Behind
 *    its own feature flag today, gated here so the flag can be flipped without anyone
 *    having to remember this.
 *  - `POST /api/v1/agents/[id]/manifest` — the owner's funding transaction for a paired
 *    agent (float + badge mint). Its whole purpose is a signature the chain must accept.
 *
 * ## What it deliberately does NOT gate
 *
 *  - `POST /api/v1/tasks/[id]/escrow` and `.../escrow/resync`. These CONFIRM a transaction
 *    that was already submitted, and move the DB toward chain truth. A transaction signed
 *    in the minutes before a halt still needs confirming, and resume-day reconciliation
 *    runs through this same core. Gating them would strand exactly the work a halt guard
 *    exists to protect. Healing stays open — the same call `agent-lane.ts` makes about
 *    resync, for the same reason.
 *  - Auth, notifications, tempcheck, groups, projects, the game roll. No chain counterpart.
 *  - Agent pairing: `POST /api/v1/agents/codes`, `/agents/pair`, `/agents/me/heartbeat`.
 *    DB-only — a code, a pending row, a last-seen stamp. The chain step of pairing is the
 *    owner's funding transaction, whose manifest route (above) is the one gated.
 *  - `POST /api/v1/agents/[id]/funded` CONFIRMS that already-signed funding tx (the same
 *    reason as the escrow confirm above). `PATCH /api/v1/agents/[id]` and its `suspend` /
 *    `resume` / `retire` are DB-only — and a halt is exactly when an owner may want to
 *    stop an agent or tighten its rules.
 *  - Every read. P1's whole point is that browsing survives a halt.
 *
 * ## Failure posture: fail OPEN on unknown, fail CLOSED on a known halt
 *
 * `readLedgerTip()` keeps its last-known value when a read fails (P1: "fail-closed means a
 * DB blip halts the site; fail-open means a halt is silently missed"), so a stale-but-known
 * tip still trips this gate — that is the case where we DO know the chain stopped. A `null`
 * tip means no tip has ever been read: unknown, not halted, and we let the write through.
 * `/api/v1/network/status` documents the same posture for the same reason — a cold-start
 * Gateway hiccup must not fabricate a sitewide stop. The operator lever stands on its own
 * either way: it is the one signal that does not depend on reaching the Gateway.
 */

export const CHAIN_HALTED_CODE = "CHAIN_HALTED"

export type ChainHaltState = {
  halted: boolean
  operatorHalt: boolean
  ageSeconds: number | null
  stateVersion: number | null
}

/** The halt decision, without the HTTP shell — the unit the tests exercise. */
export async function readChainHaltState(): Promise<ChainHaltState> {
  const operatorHalt = operatorHaltEngaged()
  const tip = await readLedgerTip()
  if (!tip) {
    // Never read a tip: unknown. Only the operator lever can halt from here.
    return { halted: operatorHalt, operatorHalt, ageSeconds: null, stateVersion: null }
  }
  return {
    halted: operatorHalt || tip.ageSeconds > NETWORK_HALT_AFTER_SECONDS,
    operatorHalt,
    ageSeconds: tip.ageSeconds,
    stateVersion: tip.stateVersion,
  }
}

/**
 * Call first in a gated route; return the response if it is non-null.
 *
 * The message names which of the two halts it is, because they need different things from
 * the reader: an operator stop is a decision someone made and can undo, a stalled ledger is
 * the network and nobody here can undo it.
 */
export async function chainWriteGate(): Promise<NextResponse | null> {
  const state = await readChainHaltState()
  if (!state.halted) return null

  const message = state.operatorHalt
    ? "Posting is paused by the operator. Nothing is lost — this reopens without a deploy."
    : "The Radix network has stopped producing blocks, so this step cannot be signed on-chain. " +
      "Browsing stays open; try again once the network resumes."

  return NextResponse.json(
    {
      ok: false,
      error: {
        code: CHAIN_HALTED_CODE,
        message,
        // Reported, not hidden: a caller (and a support conversation) can tell "the chain
        // stopped" from "the operator stopped us", and see how stale the tip is.
        detail: {
          operatorHalt: state.operatorHalt,
          ageSeconds: state.ageSeconds,
          stateVersion: state.stateVersion,
          haltAfterSeconds: NETWORK_HALT_AFTER_SECONDS,
        },
      },
    },
    { status: 503 },
  )
}
