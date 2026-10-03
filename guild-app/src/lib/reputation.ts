// Reputation scoring engine for Guild contributors

import type { TaskDifficulty } from "./incentives";

// ── Reputation Levels ──

export const REPUTATION_LEVELS = {
  newcomer: { min: 0, max: 50, label: "Newcomer" },
  contributor: { min: 51, max: 200, label: "Contributor" },
  builder: { min: 201, max: 500, label: "Builder" },
  expert: { min: 501, max: 1000, label: "Expert" },
  master: { min: 1001, max: Infinity, label: "Master" },
} as const;

export type ReputationLevel = keyof typeof REPUTATION_LEVELS;

// ── Point Values ──

const DIFFICULTY_MULTIPLIERS: Record<TaskDifficulty, number> = {
  easy: 1,
  medium: 2,
  hard: 4,
  expert: 8,
};

export const REPUTATION_POINTS = {
  task_complete_base: 10,
  review_accurate: 5,
  review_inaccurate: -3,
  task_abandoned: -10,
  submission_rejected: -5,
  proposal_vote: 2,
  dispute_arbitrated: 15,
};

// ── Core Functions ──

export function getReputationLevel(score: number): ReputationLevel {
  if (score >= REPUTATION_LEVELS.master.min) return "master";
  if (score >= REPUTATION_LEVELS.expert.min) return "expert";
  if (score >= REPUTATION_LEVELS.builder.min) return "builder";
  if (score >= REPUTATION_LEVELS.contributor.min) return "contributor";
  return "newcomer";
}

export function getReputationLabel(score: number): string {
  return REPUTATION_LEVELS[getReputationLevel(score)].label;
}

export function pointsForTaskCompletion(difficulty: TaskDifficulty): number {
  return REPUTATION_POINTS.task_complete_base * DIFFICULTY_MULTIPLIERS[difficulty];
}

export function pointsToNextLevel(currentScore: number): {
  currentLevel: ReputationLevel;
  nextLevel: ReputationLevel | null;
  pointsNeeded: number;
  progress: number;
} {
  const currentLevel = getReputationLevel(currentScore);

  const levels: ReputationLevel[] = ["newcomer", "contributor", "builder", "expert", "master"];
  const idx = levels.indexOf(currentLevel);

  if (idx >= levels.length - 1) {
    return { currentLevel, nextLevel: null, pointsNeeded: 0, progress: 100 };
  }

  const nextLevel = levels[idx + 1];
  const currentMin = REPUTATION_LEVELS[currentLevel].min;
  const nextMin = REPUTATION_LEVELS[nextLevel].min;
  const range = nextMin - currentMin;
  const earned = currentScore - currentMin;
  const progress = Math.min(100, Math.round((earned / range) * 100));

  return {
    currentLevel,
    nextLevel,
    pointsNeeded: nextMin - currentScore,
    progress,
  };
}

// ── Access Control ──

const MINIMUM_LEVEL_FOR_DIFFICULTY: Record<TaskDifficulty, ReputationLevel> = {
  easy: "newcomer",
  medium: "contributor",
  hard: "builder",
  expert: "expert",
};

export function canClaimDifficulty(
  reputationScore: number,
  difficulty: TaskDifficulty,
): boolean {
  const userLevel = getReputationLevel(reputationScore);
  const requiredLevel = MINIMUM_LEVEL_FOR_DIFFICULTY[difficulty];
  const levels: ReputationLevel[] = ["newcomer", "contributor", "builder", "expert", "master"];
  return levels.indexOf(userLevel) >= levels.indexOf(requiredLevel);
}

// ── Badge Milestone Checks ──

export interface BadgeMilestone {
  badge: string;
  label: string;
  check: (stats: ContributorStats) => boolean;
}

export interface ContributorStats {
  tasksCompleted: number;
  reviewsCompleted: number;
  streak: number;
  categoryCounts: Record<string, number>;
  votesCount: number;
  disputesArbitrated: number;
}

export const BADGE_MILESTONES: BadgeMilestone[] = [
  { badge: "first_task", label: "First Task", check: (s) => s.tasksCompleted >= 1 },
  { badge: "ten_tasks", label: "Ten Tasks", check: (s) => s.tasksCompleted >= 10 },
  { badge: "fifty_tasks", label: "Fifty Tasks", check: (s) => s.tasksCompleted >= 50 },
  { badge: "first_review", label: "First Review", check: (s) => s.reviewsCompleted >= 1 },
  { badge: "streak_five", label: "Streak Five", check: (s) => s.streak >= 5 },
  { badge: "code_expert", label: "Code Expert", check: (s) => (s.categoryCounts["code"] ?? 0) >= 20 },
  { badge: "design_expert", label: "Design Expert", check: (s) => (s.categoryCounts["design"] ?? 0) >= 20 },
  { badge: "docs_expert", label: "Docs Expert", check: (s) => (s.categoryCounts["docs"] ?? 0) >= 20 },
  { badge: "security_expert", label: "Security Expert", check: (s) => (s.categoryCounts["security-audit"] ?? 0) >= 10 },
  { badge: "qa_expert", label: "QA Expert", check: (s) => (s.categoryCounts["testing"] ?? 0) >= 15 },
  { badge: "governor", label: "Governor", check: (s) => s.votesCount >= 10 },
  { badge: "arbiter", label: "Arbiter", check: (s) => s.disputesArbitrated >= 5 },
];

export function checkNewBadges(
  stats: ContributorStats,
  existingBadges: string[],
): BadgeMilestone[] {
  return BADGE_MILESTONES.filter(
    (m) => !existingBadges.includes(m.badge) && m.check(stats),
  );
}
