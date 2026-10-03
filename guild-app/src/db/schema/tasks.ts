import {
  pgTable,
  text,
  timestamp,
  integer,
  numeric,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { users } from "./users"
import { projects } from "./projects"
import { workingGroups } from "./working-groups"
import type { TaskTerms } from "@/lib/task-terms"

export const tasks = pgTable(
  "tasks",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    // Text enum = TYPE-ONLY (no DB constraint / migration). `refunded` is the
    // terminal state of a poster-favoured dispute auto-resolve; `paid` covers
    // the worker-favoured one (earnings count).
    status: text("status", {
      enum: ["open", "assigned", "submitted", "paid", "cancelled", "disputed", "refunded"],
    })
      .default("open")
      .notNull(),
    // Reversible "swept as stale-unfunded" marker (R3-1). Set to the sweep time by
    // scripts/prune-unfunded.mjs when an abandoned, never-funded create (`open`,
    // on_chain_task_id NULL, reward > 0) ages past the TTL, to declutter the public
    // board + open-count stats. NON-terminal and money-safe by construction: the
    // row stays `open`, escrow state is untouched, and NOTHING is cancelled — so a
    // funded create whose confirm was merely lost (which also sits open+NULL-id, and
    // which the reconciler can't heal) is never stranded. Reversal is automatic: the
    // read filter hides a row only while `hidden_at IS NOT NULL AND on_chain_task_id
    // IS NULL`, so a later create-confirm/resync that sets on_chain_task_id makes it
    // reappear with no un-hide write. NULL = never swept (the normal case).
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    // 18dp to match the chain's `Decimal` — see the note on
    // escrow_transactions.amount_xrd. Held in step with that column deliberately:
    // a reward the board can express but the escrow ledger cannot record is a
    // reconciliation failure waiting to happen.
    rewardXrd: numeric("reward_xrd", { precision: 38, scale: 18 })
      .default("0")
      .notNull(),
    // Reward-resource flip prep (USD-stablecoin swap, not yet live). NULL =
    // XRD (every pre-flip row, and the only value that has ever existed).
    // ⚠️ `reward_xrd`'S NAME IS A LIE once this is non-NULL — it is the amount
    // in WHATEVER resource this column names, not necessarily XRD. Never
    // format/display/sum `reward_xrd` without reading this column first (see
    // formatXrdUsd's `unit` option). Additive and nullable on purpose: the
    // component swap is a later, separate op, and this column just makes the
    // eventual flip a config/data change instead of a schema scramble.
    rewardResource: text("reward_resource"),
    creatorId: text("creator_id")
      .references(() => users.id)
      .notNull(),
    assigneeId: text("assignee_id").references(() => users.id),
    requiredTier: text("required_tier").default("member"), // min on-chain Guild Member tier to claim
    xpReward: integer("xp_reward").default(0).notNull(),
    // Escrow on-chain linkage (step 4). Set after the create_task tx commits —
    // the blueprint assigns its own u64 task_id (distinct from this row's id),
    // and the claim/submit/approve manifests key off it. Null until funded
    // on-chain (captured from TaskCreatedEvent by the escrow-confirm endpoint).
    onChainTaskId: integer("on_chain_task_id"),
    // Which escrow COMPONENT funded this task. Each component instantiation
    // numbers its tasks from 1, so onChainTaskId alone COLLIDES across the
    // old→vNext §8b cutover — this disambiguates it. Set atomically with
    // onChainTaskId by the create confirm (= the component the TaskCreatedEvent
    // was verified against). Null = pre-backfill / unknown (readers fall back to
    // the current ESCROW_COMPONENT for those rows). See
    // findTaskByOnChainIdOnComponent + scripts/backfill-escrow-component.mjs.
    escrowComponent: text("escrow_component"),
    // Optional project grouping (TASK-TERMS-DESIGN §5) — app-layer only, the
    // escrow stays one-task-one-payout.
    projectId: integer("project_id").references(() => projects.id),
    deadline: timestamp("deadline", { withTimezone: true }),
    // On-chain dispute time: the dispute tx's consensus timestamp (what the
    // blueprint's disputed_at / 72h auto-resolve window keys off), captured by
    // the dispute confirm. Null = never disputed, or disputed before this
    // column shipped (readers fall back to updatedAt — up to ~minutes early,
    // never authoritative; the CHAIN enforces the real window).
    disputedAt: timestamp("disputed_at", { withTimezone: true }),
    // ── Dispute evidence. The blueprint's raise_dispute takes an Option<Hash>:
    // a 32-BYTE COMMITMENT, not a message. Until 2026-09-01 the app hashed the
    // literal string `dispute:task:<id>` and sent that — a commitment to a
    // value derivable from the task id, which commits to nothing and told the
    // other party nothing about why their work was being challenged.
    //
    // These two columns make the commitment mean something. `disputeEvidence`
    // is the plaintext the raiser wrote; `disputeEvidenceHash` is its SHA-256,
    // recomputed SERVER-SIDE on write and stored alongside. Anyone can hash the
    // plaintext themselves and compare it to the Option<Hash> in the
    // RaiseDisputeEvent on-chain — so we are the custodian of the text, not an
    // authority on it. If we ever altered a word, the hashes stop matching and
    // the ledger says so.
    //
    // WRITE-ONCE, enforced by the route (and by the check below): the on-chain
    // hash is fixed at dispute time, so allowing an edit afterwards would let a
    // party swap the case they committed to while the ledger still points at
    // the old one. Both NULL = disputed without evidence (every row predating
    // this column, and any dispute raised from a hand-built manifest).
    disputeEvidence: text("dispute_evidence"),
    disputeEvidenceHash: text("dispute_evidence_hash"),
    // Working-group routing key (Model A — docs/design/working-groups-model-a.md).
    // NULLABLE and staying that way: a task with no group is a normal task that
    // simply does not route to a member feed, and every task predating this
    // column is exactly that. Do NOT tighten to NOT NULL without a backfill AND
    // a create-path default — an uncategorised task must remain postable.
    workingGroupId: integer("working_group_id").references(() => workingGroups.id),
    // Structured committed terms (docs/TASK-TERMS-DESIGN.md). Folded into the
    // v2 work-brief hash at escrow funding — IMMUTABLE once onChainTaskId is
    // set (the hash would no longer re-derive). Null → task uses the v1 brief.
    terms: jsonb("terms").$type<TaskTerms>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("tasks_status_idx").on(table.status),
    index("tasks_creator_idx").on(table.creatorId),
    index("tasks_assignee_idx").on(table.assigneeId),
    index("tasks_deadline_idx").on(table.deadline),
    index("tasks_project_idx").on(table.projectId),
    index("tasks_working_group_idx").on(table.workingGroupId),
    // Belt-and-suspenders behind the app-layer CAS (captureEscrowIdIfUnset):
    // a funded (onChainTaskId, escrowComponent) pair is unique at the DB level,
    // so two rows can never both bind the same on-chain task even if the CAS is
    // ever bypassed. PARTIAL on `onChainTaskId IS NOT NULL` — unfunded rows all
    // share NULL and must not collide; pre-backfill rows with a NULL component
    // are the legacy edge the drift watcher covers (Postgres treats their NULL
    // component as distinct, so they never false-conflict).
    uniqueIndex("tasks_onchain_component_unique")
      .on(table.onChainTaskId, table.escrowComponent)
      .where(sql`${table.onChainTaskId} is not null`),
    // Evidence is a pair or it is nothing. A plaintext with no hash cannot be
    // checked against the ledger, and a hash with no plaintext is a commitment
    // to something nobody can produce — both are worse than no evidence,
    // because both LOOK like evidence in the UI. Enforced here rather than
    // trusting every writer, in the same spirit as
    // escrow_entitlement_fields_present.
    check(
      "tasks_dispute_evidence_paired",
      sql`(${table.disputeEvidence} is null) = (${table.disputeEvidenceHash} is null)`,
    ),
  ]
)
