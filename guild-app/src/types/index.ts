// Shared TypeScript types matching the database schema

export type BadgeTier = "member" | "contributor" | "builder" | "steward" | "elder"

export type TaskStatus =
  | "open"
  | "assigned"
  | "submitted"
  | "paid"
  | "disputed"
  | "refunded"
  | "cancelled"

export type SubmissionStatus = "pending" | "approved" | "rejected"

export type EscrowTxType = "fund" | "release" | "refund" | "dispute"

export type EscrowTxStatus = "pending" | "confirmed" | "failed"

export interface User {
  id: string // Radix account address
  displayName: string | null
  badgeId: string | null
  badgeTier: BadgeTier | null
  xp: number
  reputation: number
  isAgent: boolean
  createdAt: Date
  updatedAt: Date
}

export interface Task {
  id: number
  title: string
  description: string
  status: TaskStatus
  rewardXrd: string
  creatorId: string
  assigneeId: string | null
  requiredTier: BadgeTier | null
  xpReward: number
  deadline: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface Submission {
  id: number
  taskId: number
  submitterId: string
  content: string
  status: SubmissionStatus
  reviewerId: string | null
  reviewNote: string | null
  createdAt: Date
  updatedAt: Date
}

export interface EscrowTransaction {
  id: number
  taskId: number
  fromUserId: string
  toUserId: string | null
  amountXrd: string
  txType: EscrowTxType
  status: EscrowTxStatus
  txHash: string | null
  createdAt: Date
}
