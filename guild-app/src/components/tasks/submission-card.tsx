import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { Submission } from "@/lib/marketplace-types"
import { formatAddress } from "@/lib/marketplace-utils"
import { DECLINE_REASON_LABELS } from "@/lib/decline-reasons"
import { Clock, CheckCircle, XCircle, RotateCcw } from "lucide-react"

interface SubmissionCardProps {
  submission: Submission
}

function getSubmissionStatusIcon(status: Submission["status"]) {
  switch (status) {
    case "pending":
      return <Clock className="h-4 w-4 text-yellow-500" />
    case "approved":
      return <CheckCircle className="h-4 w-4 text-green-500" />
    case "rejected":
      return <XCircle className="h-4 w-4 text-red-500" />
    case "revision_requested":
      return <RotateCcw className="h-4 w-4 text-orange-500" />
  }
}

function getSubmissionStatusColor(status: Submission["status"]) {
  switch (status) {
    case "pending":
      return "bg-yellow-500/10 text-yellow-500"
    case "approved":
      return "bg-green-500/10 text-green-500"
    case "rejected":
      return "bg-red-500/10 text-red-500"
    case "revision_requested":
      return "bg-orange-500/10 text-orange-500"
  }
}

export function SubmissionCard({ submission }: SubmissionCardProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            {getSubmissionStatusIcon(submission.status)}
            <span className="font-mono text-xs">
              {formatAddress(submission.submitterId)}
            </span>
          </CardTitle>
          <Badge
            variant="secondary"
            className={getSubmissionStatusColor(submission.status)}
          >
            {submission.status.replace("_", " ")}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted-foreground">{submission.content}</p>
        {submission.declineReason && (
          <p className="text-xs font-medium text-red-500">
            Declined:{" "}
            {DECLINE_REASON_LABELS[submission.declineReason] ??
              submission.declineReason}
          </p>
        )}
        {submission.reviewNote && (
          <div className="rounded-md bg-muted px-3 py-2">
            <p className="text-xs font-medium text-muted-foreground">
              Review by{" "}
              <span className="font-mono">
                {submission.reviewerId
                  ? formatAddress(submission.reviewerId)
                  : "unknown"}
              </span>
              :
            </p>
            <p className="text-xs">{submission.reviewNote}</p>
          </div>
        )}
        <p className="text-[10px] text-muted-foreground">
          Submitted {new Date(submission.createdAt).toLocaleDateString()}
        </p>
      </CardContent>
    </Card>
  )
}
