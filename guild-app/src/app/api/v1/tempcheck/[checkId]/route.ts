import { NextRequest, NextResponse } from "next/server"
import { fromError } from "@/lib/api-response"
import { TEMP_CHECKS, type CheckId } from "@/content/lights-on"
import { countSigned, getVoterChoice, getVotesForCheck, tallyVotes } from "@/db/queries/tempcheck"

// /lights-on's web temperature checks ("Who keeps the lights on?"). The poll
// CLOSED on 2026-10-12 with no votes on any of the nine checks, so the vote
// handler is gone: this route reads tallies and nothing more. Deleting the
// write path rather than leaving it open is the point — a vote cast now would
// be recorded and read by nobody. The tally stays readable so the zero is
// checkable by a stranger, and src/content/lights-on.ts's CHECKS_CLOSED
// carries the same statement in the page copy.

const VOTER_COOKIE = "tc_voter"
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isCheckId(value: string): value is CheckId {
  return Object.prototype.hasOwnProperty.call(TEMP_CHECKS, value)
}

function badRequest(code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status: 400 })
}

type RouteCtx = { params: Promise<{ checkId: string }> }

export async function GET(req: NextRequest, { params }: RouteCtx) {
  try {
    const { checkId } = await params
    if (!isCheckId(checkId)) {
      return badRequest("UNKNOWN_CHECK", "Unknown temperature check")
    }

    const check = TEMP_CHECKS[checkId]
    const rows = await getVotesForCheck(checkId)

    // `yourVote` is an addition on top of the {checkId, total, signed,
    // options} contract, not a replacement for it — sourced from the SAME
    // httpOnly cookie the vote handler used to set, never from anything
    // client-supplied, so a page reload can still show the voter their own choice
    // (the cookie is httpOnly precisely so client JS cannot read it itself).
    const voterKey = req.cookies.get(VOTER_COOKIE)?.value
    const yourVote = voterKey && UUID_RE.test(voterKey) ? await getVoterChoice(checkId, voterKey) : null

    return NextResponse.json({
      ok: true,
      data: {
        checkId,
        total: rows.length,
        signed: countSigned(rows),
        options: tallyVotes(rows, check.options.map((o) => o.key)),
        yourVote,
      },
    })
  } catch (err) {
    return fromError(err)
  }
}
