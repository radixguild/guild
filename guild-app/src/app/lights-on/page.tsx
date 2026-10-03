import type { Metadata } from "next"
import { AppShell } from "@/components/app-shell"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { TempCheck } from "@/components/tempcheck/temp-check"
import { cn } from "@/lib/utils"
import {
  PAGE_HEADER,
  WHERE_THINGS_STAND,
  QUESTIONS_INTRO,
  Q3_GROUP,
  TEMP_CHECKS,
  WHAT_WE_MEASURED,
  WHAT_WE_DO_NOT_KNOW,
  WHAT_THIS_IS_NOT,
  HOW_TO_ANSWER,
  type CheckId,
  type TableSpec,
} from "@/content/lights-on"
import { withPageOg } from "@/lib/page-metadata";

// "Who keeps the lights on?" — an open temperature check to the Radix
// community, not a plan or a decision. Every sentence, heading, list and
// table on this page is the approved draft, verbatim, sourced from
// src/content/lights-on.ts so the copy is testable independently of this
// file. Registered as a COLD_ROUTE in scripts/honest-copy.mjs: this is a
// server component, so the draft's copy — and the widget's static
// disclaimer sentence — are all present in the server-rendered HTML the
// deploy gate scans. Only the vote TALLIES themselves are client-fetched
// after hydration (see TempCheck), and a tally is a count, never a claim.

export const metadata: Metadata = withPageOg("/lights-on", {
  title: "Who keeps the lights on? — Radix Guild",
  description: PAGE_HEADER.tagline,
});

function DataTable({ table, heading }: { table: TableSpec; heading?: string }) {
  const label = heading ?? table.heading
  return (
    <div>
      {label && <h4 className="text-sm font-semibold mb-2">{label}</h4>}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground border-b border-border">
              {table.columns.map((col) => (
                <th key={col} className="py-1.5 pr-4 font-medium">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i} className="border-b border-border/50 align-top">
                {row.map((cell, j) => (
                  <td key={j} className="py-1.5 pr-4">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** One question — a q1/q2/q4/q5/q6/q7 heading, or a q3a/q3b/q3c bold
 *  sub-question — followed by its body paragraph(s) and its TempCheck
 *  widget. `isMainHeading` (from the content module) decides which tag the
 *  question's own lead-in line renders as, matching the source markdown:
 *  a `###` heading for the numbered questions, bold paragraph text for the
 *  three parts of question 3. */
function QuestionBlock({ id, className }: { id: CheckId; className?: string }) {
  const q = TEMP_CHECKS[id]
  return (
    <div className={cn("space-y-2", className)}>
      {q.isMainHeading ? (
        <h3 className="text-base font-semibold pt-3 border-t border-border">{q.heading}</h3>
      ) : (
        <p className="text-sm font-semibold">{q.heading}</p>
      )}
      {q.body.map((paragraph, i) => (
        <p key={i} className="text-sm leading-relaxed">
          {paragraph}
        </p>
      ))}
      <TempCheck checkId={id} options={q.options} />
    </div>
  )
}

function LightsOnContent() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{PAGE_HEADER.title}</h1>
        <p className="text-sm font-semibold mt-2 leading-relaxed">{PAGE_HEADER.tagline}</p>
        <p className="text-xs text-muted-foreground italic mt-2 leading-relaxed">{PAGE_HEADER.byline}</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
            {WHERE_THINGS_STAND.heading}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ul className="list-disc pl-5 space-y-2 text-sm leading-relaxed">
            {WHERE_THINGS_STAND.facts.map((fact, i) => (
              <li key={i}>{fact}</li>
            ))}
          </ul>
          <p className="text-sm leading-relaxed text-muted-foreground">{WHERE_THINGS_STAND.closing}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">{QUESTIONS_INTRO.heading}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm leading-relaxed">{QUESTIONS_INTRO.body}</p>
          <p className="text-sm leading-relaxed">
            <strong>{QUESTIONS_INTRO.beforeMoneyLabel}</strong> {QUESTIONS_INTRO.beforeMoneyBody}
          </p>

          <QuestionBlock id="q1" className="!pt-0" />
          <QuestionBlock id="q2" />

          <div className="space-y-4 pt-3 border-t border-border">
            <h3 className="text-base font-semibold">{Q3_GROUP.heading}</h3>
            <p className="text-sm leading-relaxed">{Q3_GROUP.intro}</p>
            <div className="space-y-5 pl-1 border-l-2 border-border/60 ml-1">
              <QuestionBlock id="q3a" className="pl-3" />
              <QuestionBlock id="q3b" className="pl-3" />
              <QuestionBlock id="q3c" className="pl-3" />
            </div>
          </div>

          <QuestionBlock id="q4" />
          <QuestionBlock id="q5" />
          <QuestionBlock id="q6" />
          <QuestionBlock id="q7" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">{WHAT_WE_MEASURED.heading}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm leading-relaxed text-muted-foreground">{WHAT_WE_MEASURED.intro}</p>

          <DataTable table={WHAT_WE_MEASURED.hosting} />
          <p className="text-sm leading-relaxed">{WHAT_WE_MEASURED.hostingFootnote}</p>

          <DataTable table={WHAT_WE_MEASURED.people} />

          <div className="space-y-2">
            <h4 className="text-sm font-semibold">{WHAT_WE_MEASURED.membership.heading}</h4>
            <p className="text-sm leading-relaxed">{WHAT_WE_MEASURED.membership.intro}</p>
            <DataTable
              heading=""
              table={{
                heading: "",
                columns: WHAT_WE_MEASURED.membership.columns,
                rows: WHAT_WE_MEASURED.membership.rows,
              }}
            />
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{WHAT_WE_MEASURED.membershipClosing}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
            {WHAT_WE_DO_NOT_KNOW.heading}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc pl-5 space-y-2 text-sm leading-relaxed">
            {WHAT_WE_DO_NOT_KNOW.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
            {WHAT_THIS_IS_NOT.heading}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc pl-5 space-y-2 text-sm leading-relaxed">
            {WHAT_THIS_IS_NOT.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
            {HOW_TO_ANSWER.heading}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-relaxed">{HOW_TO_ANSWER.body}</p>
        </CardContent>
      </Card>
    </div>
  )
}

export default function LightsOnPage() {
  return (
    <AppShell>
      <LightsOnContent />
    </AppShell>
  )
}
