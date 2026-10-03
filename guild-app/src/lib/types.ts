export interface BadgeInfo {
  id: string;
  issued_to: string;
  schema_name: string;
  issued_at: number;
  tier: string;
  status: string;
  last_updated: number;
  xp: number;
  level: string;
  extra_data: string;
}

export interface TxResult {
  ok: boolean;
  txId?: string;
  error?: string;
}

// ── Task Marketplace Types ──

export type TaskStatus =
  | "open"
  | "assigned"
  | "submitted"
  | "paid"
  | "disputed"
  | "refunded"
  | "cancelled";

export interface Task {
  id: number;
  title: string;
  description: string;
  reward_xrd: number;
  reward_xp: number;
  status: TaskStatus;
  creator_tg_id: string;
  assignee_tg_id: string | null;
  assignee_address: string | null;
  escrow_component_address: string | null;
  escrow_tx_hash: string | null;
  dispute_window_hours: number;
  insurance_fee_xrd: number;
  skill_tags: string | null;
  task_description_hash: string | null;
  github_issue: string | null;
  github_pr: string | null;
  created_at: number;
  assigned_at: number | null;
  submitted_at: number | null;
  verified_at: number | null;
  paid_at: number | null;
  paid_tx: string | null;
}
