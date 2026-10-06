"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { apiFetch } from "@/lib/api-fetch"
import { useWallet } from "@/hooks/useWallet"
import { signInDidNotComplete } from "@/lib/session-outcome"
import type { Submission } from "@/lib/marketplace-types"
import { DECLINE_REASONS, DECLINE_REASON_LABELS } from "@/lib/decline-reasons"
import { extractPrUrl } from "@/lib/pr-verify"
import { CheckCircle, XCircle, RotateCcw } from "lucide-react"

interface ReviewFormProps {
  submission: Submission
  onReviewed: (updated: Submission) => void
}

type ReviewStatus = "approved" | "rejected" | "revision_requested"

export function ReviewForm({ submission, onReviewed }: ReviewFormProps) {
  const { ensureSessionDetailed } = useWallet()
  const [notes, setNotes] = useState("")
  const [declineReason, setDeclineReason] = useState<string>("")
  const [pending, setPending] = useState<ReviewStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Step 4 (docs/design/github-reality-acceptance.md #4) — a soft-gate note,
  // display only. Scoped to submissions that actually reference a PR (same
  // test PrVerificationPanel uses): a design/research/ops submission with no
  // GitHub involvement gets no "not verified on GitHub" noise, matching the
  // design doc's "baseline, not only" rule (non-code tasks fall back to
  // manual review). Never disables a button and never touches the on-chain
  // approve_and_release call — Approve stays a poster act either way.
  const hasPrReference = extractPrUrl(submission.content) !== null
  const githubVerified = submission.prVerification?.overall === "verified"

  async function submit(status: ReviewStatus) {
    setPending(status)
    setError(null)
    try {
      const gate = await ensureSessionDetailed()
      if (!gate.ok) {
        setError(signInDidNotComplete("your review was not submitted", gate))
        return
      }
      const res = await apiFetch(`/api/v1/submissions/${submission.id}/review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          reviewer_notes: notes.trim() || undefined,
          ...(status === "rejected"
            ? { decline_reason: declineReason || undefined }
            : {}),
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.ok) {
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`)
      }
      onReviewed(body.data as Submission)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Review failed")
    } finally {
      setPending(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">
          Review submission
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor={`review-notes-${submission.id}`}>
            Reviewer notes (optional)
          </Label>
          <Textarea
            id={`review-notes-${submission.id}`}
            placeholder="Feedback for the submitter — required if rejecting."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`decline-reason-${submission.id}`}>
            Decline reason{" "}
            <span className="text-muted-foreground">(required to reject)</span>
          </Label>
          <Select
            id={`decline-reason-${submission.id}`}
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
          >
            <option value="">Select a reason…</option>
            {DECLINE_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {DECLINE_REASON_LABELS[reason] ?? reason}
              </option>
            ))}
          </Select>
          {declineReason === "" && (
            <p className="text-xs text-muted-foreground">
              Pick a decline reason to enable Reject.
            </p>
          )}
        </div>
        {error && (
          <p className="text-xs text-red-500" role="alert">
            {error}
          </p>
        )}
        {/* ⚠️ The Approve button below said "Approve & release" until
            2026-08-21. It signs nothing and releases nothing: this route's own
            comment says "Review records the submission decision only — it must
            NOT touch the escrow ledger or task status", and the on-chain
            approve_and_release is a separate, wallet-signed action. Under pull
            even THAT does not "release" to anyone — it credits an entitlement
            the payee withdraws. A money word on a non-money button is how a
            poster ends up believing they have paid. */}
        <p className="text-xs text-muted-foreground">
          Recording a decision here moves no money and does not stop the review clock. To pay,
          approve on-chain with your wallet. To contest the work, raise a dispute before the review
          window ends; after that, anyone can release the full reward to the submitter.
        </p>
        {/* Soft-gate wording (Step 4) — advisory only. "safe to release" describes
            the GitHub evidence, never the task's money state: this submission has
            NOT been paid or settled by this note, whatever it says. */}
        {hasPrReference && (
          <p className={`text-xs ${githubVerified ? "text-green-600 dark:text-green-500" : "text-muted-foreground"}`}>
            {githubVerified ? "verified — safe to release" : "not verified on GitHub yet"}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => submit("revision_requested")}
            disabled={pending !== null}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            {pending === "revision_requested" ? "Requesting…" : "Request changes"}
          </Button>
          <Button
            variant="outline"
            onClick={() => submit("rejected")}
            disabled={pending !== null || declineReason === ""}
          >
            <XCircle className="mr-2 h-4 w-4" />
            {pending === "rejected" ? "Rejecting…" : "Reject"}
          </Button>
          <Button
            onClick={() => submit("approved")}
            disabled={pending !== null}
          >
            <CheckCircle className="mr-2 h-4 w-4" />
            {pending === "approved" ? "Approving…" : "Approve submission"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
