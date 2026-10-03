import type { Metadata } from "next"
import Link from "next/link"
import { AppShell } from "@/components/app-shell"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty-state"
import { countLedgerEvents, findLedgerEvents, type LedgerEvent } from "@/db/queries/escrow"
import { formatAddress } from "@/lib/marketplace-utils"
import { formatXrdUsdFromString } from "@/lib/format-xrd-usd"
import { getTestAccounts } from "@/lib/test-accounts"
import {
  classifyLedgerRow,
  ledgerInternalSummary,
  INTERNAL_CYCLE_LABEL,
  INTERNAL_CYCLE_TITLE,
} from "@/lib/ledger-internal"
import { ScrollText, ExternalLink } from "lucide-react"
import { withPageOg } from "@/lib/page-metadata";

// The Stage 1 deliverable from guild-public/docs/NODE-ROADMAP.md: "Ship a
// proof-ledger page: every settled task, dispute, and (later) node event
// linked to its transaction." Gate G1 requires this page LIVE.
//
// A real React Server Component — no client fetch, no chain read at request
// time. Every row already sits in escrow_transactions with a verified tx
// hash (the single writer in db/queries/escrow.ts records it only after
// the matching on-chain event is confirmed), so this page reads Postgres and
// nothing else. `searchParams` is a Next dynamic API, so the route is never
// statically prerendered — it renders fresh, server-side, on every request.
//
// HONESTY RULE (load-bearing, not decoration): findLedgerEvents() only ever
// returns rows with a real, confirmed on-chain tx hash. There is no
// synthetic or placeholder row anywhere below — an empty result renders the
// honest empty state, not a fabricated example.
//
// INTERNAL-CYCLE LABELLING (the second honesty rule): most of what this ledger
// holds today was produced by Guild-operated test accounts settling with each
// other. Those rows are NOT hidden — they are real on-chain events and hiding
// them would under-report — but each one carries a visible "internal test
// cycle" label, and a summary line above the table says how many there are.
// The allowlist is the server-only GUILD_TEST_ACCOUNTS env the leaderboard
// already excludes on (src/lib/test-accounts.ts); this page reads it on the
// server, classifies each row (src/lib/ledger-internal.ts), and renders only
// the boolean per row and the two counts. The address list never reaches the
// client. Empty env => nothing labelled, and the summary says so rather than
// claiming "0 internal" (see ledgerInternalSummary for why that matters).

export const metadata: Metadata = withPageOg("/ledger", {
  title: "Proof Ledger — Radix Guild",
  description:
    "Every settled task, dispute and payment event, linked to its on-chain transaction and the task it belongs to. Only confirmed on-chain events are shown.",
});

const PAGE_SIZE = 25

const dashboardTxUrl = (txHash: string) => `https://dashboard.radixdlt.com/transaction/${txHash}`

function formatWhen(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC"
}

const EVENT_STYLE: Record<LedgerEvent["txType"], string> = {
  release: "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
  refund: "border-border text-muted-foreground",
  dispute: "border-orange-500/40 text-orange-600 dark:text-orange-400",
  settle: "border-blue-500/40 text-blue-600 dark:text-blue-400",
  withdraw: "border-violet-500/40 text-violet-600 dark:text-violet-400",
}

function eventLabel(row: LedgerEvent): string {
  switch (row.txType) {
    case "release":
      return "Settled — paid to worker"
    case "refund":
      return "Settled — refunded to poster"
    case "dispute":
      return "Dispute raised"
    case "settle":
      return `Credited — ${row.party ?? "?"} (${row.lane ?? "?"})`
    case "withdraw":
      return `Collected — ${row.party ?? "?"} (${row.lane ?? "?"})`
    default:
      return row.txType
  }
}

function LedgerRow({ row, internal }: { row: LedgerEvent; internal: boolean }) {
  const showAmount = row.txType !== "dispute"
  return (
    <tr className="hover:bg-muted/30">
      <td className="px-3 py-2.5 align-top">
        <div className="flex flex-wrap items-center gap-1">
          <Badge variant="outline" className={`text-[10px] ${EVENT_STYLE[row.txType] ?? ""}`}>
            {eventLabel(row)}
          </Badge>
          {internal ? (
            <Badge
              variant="outline"
              className="border-amber-500/40 text-[10px] text-amber-700 dark:text-amber-400"
              title={INTERNAL_CYCLE_TITLE}
              data-testid="ledger-internal-badge"
            >
              {INTERNAL_CYCLE_LABEL}
            </Badge>
          ) : null}
        </div>
      </td>
      <td className="max-w-[220px] px-3 py-2.5 align-top">
        <Link
          href={`/tasks/${row.taskId}`}
          className="block truncate text-primary hover:underline"
          title={row.taskTitle ?? `Task #${row.taskId}`}
        >
          {row.taskTitle ?? `Task #${row.taskId}`}
        </Link>
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right align-top font-mono">
        {showAmount ? formatXrdUsdFromString(row.amountXrd, null, { unit: row.rewardResource ?? "XRD" }) : "—"}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 align-top font-mono text-[11px] text-muted-foreground">
        {formatAddress(row.fromUserId)}
        {row.toUserId ? <> &rarr; {formatAddress(row.toUserId)}</> : null}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 align-top">
        <a
          href={dashboardTxUrl(row.txHash)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-mono text-[11px] text-primary hover:underline"
        >
          {row.txHash.slice(0, 10)}&hellip;
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right align-top text-[11px] text-muted-foreground">
        {formatWhen(row.createdAt)}
      </td>
    </tr>
  )
}

// The honest reason the table below is empty, verified against
// docs/PROJECT-STATE.md's 2026-08-02 "ZERO-STATE DRAIN" entry: the deployed
// production escrow component was drained to 0.00 XRD deliberately (38
// cancels + 1 approve, operator-authorised), clearing the way for the PULL
// redesign (docs/design/escrow-pull-redesign.md) to cut over without any
// live task state to migrate. It has not been funded since. This is a
// snapshot of what the query returned, not a hardcoded claim — the moment a
// new confirmed row lands, this branch stops rendering and the table above
// takes over.
function LedgerEmptyState() {
  return (
    <EmptyState
      icon={<ScrollText />}
      title="Nothing settled yet"
      description={
        "Production escrow was drained to zero on 2026-08-02, pending the PULL settlement cutover — so " +
        "there is genuinely nothing to show. This page reads the same on-chain-confirmed ledger the app " +
        "settles from; the next task, dispute or payment event that confirms on-chain will appear here " +
        "automatically, with no manual step."
      }
    />
  )
}

async function LedgerContent({ before }: { before?: number }) {
  // Server-only: the allowlist is read here and used here. What leaves this
  // function is one boolean per row and two integers — never an address.
  const testAccounts = getTestAccounts()
  const [{ data, cursor, hasMore }, counts] = await Promise.all([
    findLedgerEvents({ limit: PAGE_SIZE, cursor: before }),
    countLedgerEvents(testAccounts),
  ])
  const summary = ledgerInternalSummary(counts, testAccounts.length > 0)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ScrollText className="h-5 w-5" />
          Proof Ledger
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every settled task, dispute and payment event the Guild&rsquo;s escrow has recorded, newest
          first. Each row links its transaction on the Radix Dashboard and the task it belongs to.
          Only events with a verified, confirmed on-chain transaction are listed here — nothing on
          this page is synthetic, estimated, or a placeholder.
        </p>
        {/* Rendered in EVERY state, including the empty ledger and the
            no-allowlist deployment: a stranger should never have to wonder
            whether the labelling exists. The wording per state lives in
            ledgerInternalSummary and is unit-pinned. */}
        <p
          className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground"
          data-testid="ledger-internal-summary"
        >
          {summary}
        </p>
      </div>

      {data.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <LedgerEmptyState />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
              {before ? "Older events" : "Latest events"}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Event</th>
                    <th className="px-3 py-2 font-medium">Task</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                    <th className="px-3 py-2 font-medium">From &rarr; To</th>
                    <th className="px-3 py-2 font-medium">Transaction</th>
                    <th className="px-3 py-2 text-right font-medium">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.map((row) => (
                    <LedgerRow
                      key={row.id}
                      row={row}
                      internal={classifyLedgerRow(row, testAccounts) === "internal"}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {(hasMore || before !== undefined) && (
        <div className="flex items-center justify-between text-xs">
          <div>
            {before !== undefined && (
              <Link href="/ledger" className="text-primary hover:underline">
                &larr; Back to latest
              </Link>
            )}
          </div>
          <div>
            {hasMore && cursor !== null && (
              <Link href={`/ledger?before=${cursor}`} className="text-primary hover:underline">
                Older events &rarr;
              </Link>
            )}
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {/* Was "Stage 1 of the node roadmap's open-books gate … Node-operation
            events join this page in later stages" until 2026-09-23 — a promise
            about node operation that no ruling backs, in internal roadmap
            language. The page shows what it shows. */}
        This ledger covers task and dispute settlement on the Guild&rsquo;s escrow. See{" "}
        <Link href="/trust" className="text-primary hover:underline">
          Trust &amp; verification
        </Link>{" "}
        for what else is checkable on-chain today.
      </p>
    </div>
  )
}

interface LedgerPageProps {
  searchParams: Promise<{ before?: string }>
}

// Postgres's `id` is a plain `integer` (int4, max 2147483647). The regex
// alone only rules out non-digit and leading-zero input — an arbitrarily
// long digit string like `?before=9999999999` still passes it, reaches
// findLedgerEvents() as `cursor`, and Postgres raises "value out of range
// for type integer" on the bound parameter: a 500 on a public page for
// nothing worse than a hand-edited or bookmarked URL. Anything outside
// int4 range (or outside JS's safe-integer range) is treated the same as
// "no cursor" — render page 1 — instead of erroring.
export function parseBeforeCursor(raw: string | undefined): number | undefined {
  if (!raw || !/^[1-9]\d*$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 1 && value <= 2147483647 ? value : undefined
}

export default async function LedgerPage({ searchParams }: LedgerPageProps) {
  const params = await searchParams
  const before = parseBeforeCursor(params.before)

  return (
    <AppShell>
      <LedgerContent before={before} />
    </AppShell>
  )
}
