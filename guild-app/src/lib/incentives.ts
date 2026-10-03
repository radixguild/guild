// Incentive tiers, bonuses, and task templates for Guild

import type { ReputationLevel } from "./reputation";

// ── Task Difficulty & Reward Tiers ──

export type TaskDifficulty = "easy" | "medium" | "hard" | "expert";

export interface IncentiveTier {
  difficulty: TaskDifficulty;
  rewardRange: [number, number]; // [min, max] XRD
  xpReward: number;
  minimumReputation: ReputationLevel;
  label: string;
}

export const INCENTIVE_TIERS: IncentiveTier[] = [
  { difficulty: "easy", rewardRange: [1, 10], xpReward: 10, minimumReputation: "newcomer", label: "Easy" },
  { difficulty: "medium", rewardRange: [10, 50], xpReward: 25, minimumReputation: "contributor", label: "Medium" },
  { difficulty: "hard", rewardRange: [50, 200], xpReward: 50, minimumReputation: "builder", label: "Hard" },
  { difficulty: "expert", rewardRange: [200, 1000], xpReward: 100, minimumReputation: "expert", label: "Expert" },
];

export function getTierForReward(rewardXrd: number): IncentiveTier {
  for (let i = INCENTIVE_TIERS.length - 1; i >= 0; i--) {
    if (rewardXrd >= INCENTIVE_TIERS[i].rewardRange[0]) {
      return INCENTIVE_TIERS[i];
    }
  }
  return INCENTIVE_TIERS[0];
}

// ── Bonus Multipliers ──

export const FAST_COMPLETION_THRESHOLDS = {
  within25Percent: 1.2, // Complete in ≤25% of estimated time → 20% bonus
  within50Percent: 1.1, // Complete in ≤50% of estimated time → 10% bonus
} as const;

export const STREAK_BONUS = {
  threshold: 5, // Complete 5 tasks in a row
  multiplier: 1.1, // 10% bonus
} as const;

export function calculateBonus(
  baseReward: number,
  opts: {
    estimatedHours?: number;
    actualHours?: number;
    consecutiveCompleted?: number;
  },
): { total: number; bonuses: string[] } {
  let total = baseReward;
  const bonuses: string[] = [];

  // Fast completion bonus
  if (opts.estimatedHours && opts.actualHours && opts.estimatedHours > 0) {
    const ratio = opts.actualHours / opts.estimatedHours;
    if (ratio <= 0.25) {
      total *= FAST_COMPLETION_THRESHOLDS.within25Percent;
      bonuses.push("Fast completion (+20%)");
    } else if (ratio <= 0.5) {
      total *= FAST_COMPLETION_THRESHOLDS.within50Percent;
      bonuses.push("Fast completion (+10%)");
    }
  }

  // Streak bonus
  if (opts.consecutiveCompleted && opts.consecutiveCompleted >= STREAK_BONUS.threshold) {
    total *= STREAK_BONUS.multiplier;
    bonuses.push(`Streak x${opts.consecutiveCompleted} (+10%)`);
  }

  return { total: Math.round(total * 100) / 100, bonuses };
}

// ── Radix Maintenance Task Templates ──

export interface TaskTemplate {
  id: string;
  title: string;
  description: string;
  deliverables: string[];
  estimatedHours: number;
  difficulty: TaskDifficulty;
  rewardRange: [number, number];
  minimumReputation: ReputationLevel;
  skillTags: string[];
}

export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: "code-review",
    title: "Code Review: Community PR",
    description:
      "Review a community-submitted pull request for code quality, correctness, and adherence to project standards. Provide actionable feedback.",
    deliverables: [
      "Written review with line-by-line comments",
      "Approval or list of required changes",
      "Summary of findings",
    ],
    estimatedHours: 2,
    difficulty: "medium",
    rewardRange: [10, 30],
    minimumReputation: "contributor",
    skillTags: ["code", "review"],
  },
  {
    id: "docs-update",
    title: "Documentation Update",
    description:
      "Update or create documentation for a specified component, API, or process. Ensure accuracy and clarity.",
    deliverables: [
      "Updated markdown files",
      "PR with changes",
      "Screenshots if applicable",
    ],
    estimatedHours: 3,
    difficulty: "easy",
    rewardRange: [5, 15],
    minimumReputation: "newcomer",
    skillTags: ["docs"],
  },
  {
    id: "bug-report",
    title: "Bug Reproduction & Report",
    description:
      "Reproduce a reported bug, document exact steps, environment details, and expected vs actual behavior.",
    deliverables: [
      "Detailed reproduction steps",
      "Environment details (OS, browser, wallet version)",
      "Screenshots or video",
      "GitHub issue filed",
    ],
    estimatedHours: 1,
    difficulty: "easy",
    rewardRange: [3, 10],
    minimumReputation: "newcomer",
    skillTags: ["testing", "bug-report"],
  },
  {
    id: "feature-impl",
    title: "Feature Implementation from Proposal",
    description:
      "Implement a feature that has been approved through Guild governance. Follow the specification from the proposal.",
    deliverables: [
      "Working implementation with tests",
      "PR linked to proposal",
      "Documentation updates",
    ],
    estimatedHours: 8,
    difficulty: "hard",
    rewardRange: [50, 200],
    minimumReputation: "builder",
    skillTags: ["code", "feature"],
  },
  {
    id: "security-audit",
    title: "Security Audit: Scrypto Component",
    description:
      "Audit a Scrypto smart contract for vulnerabilities, access control issues, and economic exploits. Provide a written report.",
    deliverables: [
      "Security audit report",
      "List of findings with severity ratings",
      "Recommended fixes",
    ],
    estimatedHours: 12,
    difficulty: "expert",
    rewardRange: [200, 500],
    minimumReputation: "expert",
    skillTags: ["security-audit", "scrypto"],
  },
  {
    id: "testing-qa",
    title: "Testing & QA",
    description:
      "Write or expand automated tests for a specified module. Run manual QA and report any regressions.",
    deliverables: [
      "New or updated test files",
      "Test coverage report",
      "QA notes with pass/fail results",
    ],
    estimatedHours: 4,
    difficulty: "medium",
    rewardRange: [15, 40],
    minimumReputation: "contributor",
    skillTags: ["testing", "qa"],
  },
];

// ── Welcome Task ──

export const WELCOME_TASK: TaskTemplate = {
  id: "welcome",
  title: "Welcome Task: Introduce Yourself",
  description:
    "Complete your Guild profile, connect your Radix wallet, and submit a brief introduction. This is your first step into the Guild ecosystem — guaranteed reward upon completion.",
  deliverables: [
    "Wallet connected and badge minted",
    "Brief introduction posted (name, skills, interests)",
    "First proposal vote cast",
  ],
  estimatedHours: 0.5,
  difficulty: "easy",
  rewardRange: [2, 2],
  minimumReputation: "newcomer",
  skillTags: ["onboarding"],
};
