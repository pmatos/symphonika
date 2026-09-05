import { z } from "zod";

import type {
  AgentProviderName,
  NormalizedProviderEvent
} from "../provider.js";

export type RoutineOutcomeStatus = "success" | "no_action" | "error";

export type RoutineOutcomeAction =
  "pr" | "issue_opened" | "issue_closed" | "commit" | "none";

export type RoutineOutcomeClaim = {
  action: RoutineOutcomeAction;
  status: RoutineOutcomeStatus;
  summary: string;
  title: string;
  url: string | null;
};

const routineOutcomeClaimSchema = z
  .object({
    action: z.enum(["pr", "issue_opened", "issue_closed", "commit", "none"]),
    status: z.enum(["success", "no_action", "error"]),
    summary: z.string(),
    title: z.string(),
    url: z.string().nullable()
  })
  .strict();

export const ROUTINE_OUTCOME_JSON_SCHEMA = {
  additionalProperties: false,
  properties: {
    action: {
      enum: ["pr", "issue_opened", "issue_closed", "commit", "none"],
      type: "string"
    },
    status: {
      enum: ["success", "no_action", "error"],
      type: "string"
    },
    summary: { type: "string" },
    title: { type: "string" },
    url: { type: ["string", "null"] }
  },
  required: ["status", "action", "url", "title", "summary"],
  type: "object"
} as const;

export type RoutineOutcomeSource =
  AgentProviderName | "gh" | "git" | "symphonika";

export type RoutineOutcome = RoutineOutcomeClaim & {
  source: RoutineOutcomeSource;
  verified: boolean;
};

export type ObservedRoutineAction = {
  action: Extract<RoutineOutcomeAction, "pr" | "issue_opened" | "issue_closed">;
  title: string;
  url: string | null;
};

type RoutineGithubIssueObservation = {
  closedAt: string | null;
  createdAt: string;
  state: string;
  title: string;
  url: string | null;
};

type RoutineGithubPullRequestObservation = {
  title: string;
  url: string | null;
};

export type RoutineGithubSnapshot = {
  issues: Record<string, RoutineGithubIssueObservation>;
  pullRequests: Record<string, RoutineGithubPullRequestObservation>;
};

export type ReconcileRoutineOutcomeInput = {
  claim: RoutineOutcomeClaim | null;
  commitsAhead: boolean;
  githubObservationAvailable: boolean;
  observedAction: ObservedRoutineAction | null;
  provider: AgentProviderName;
  terminalReason: string | null;
  terminalState: "succeeded" | "failed" | "cancelled";
};

export function parseRoutineOutcomeClaim(
  events: NormalizedProviderEvent[]
): RoutineOutcomeClaim | null {
  let completed: NormalizedProviderEvent | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "turn_completed") {
      completed = events[index];
      break;
    }
  }
  if (completed === undefined) {
    return null;
  }
  let candidate = completed.structuredOutput;
  if (candidate === undefined && typeof completed.result === "string") {
    try {
      candidate = JSON.parse(completed.result);
    } catch {
      return null;
    }
  }
  const parsed = routineOutcomeClaimSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function diffRoutineGithubSnapshots(
  before: RoutineGithubSnapshot,
  after: RoutineGithubSnapshot,
  windowStart: string
): ObservedRoutineAction | null {
  const newPullRequest = sortedNumericKeys(after.pullRequests).find(
    (number) => before.pullRequests[number] === undefined
  );
  if (newPullRequest !== undefined) {
    const pullRequest = after.pullRequests[newPullRequest]!;
    return {
      action: "pr",
      title: pullRequest.title,
      url: pullRequest.url
    };
  }
  // A time-bounded before-snapshot can be missing an issue that predates the
  // window, so absence alone does not mean "created during this firing" —
  // only an actual creation timestamp inside the window does.
  const windowStartMs = Date.parse(windowStart);
  const newlyOpenedIssue = sortedNumericKeys(after.issues).find((number) => {
    if (before.issues[number] !== undefined) {
      return false;
    }
    return Date.parse(after.issues[number]!.createdAt) >= windowStartMs;
  });
  if (newlyOpenedIssue !== undefined) {
    const issue = after.issues[newlyOpenedIssue]!;
    return {
      action: "issue_opened",
      title: issue.title,
      url: issue.url
    };
  }
  const newlyClosedIssue = sortedNumericKeys(after.issues).find((number) => {
    const issue = after.issues[number]!;
    if (issue.state.toLowerCase() !== "closed") {
      return false;
    }
    const beforeIssue = before.issues[number];
    if (beforeIssue === undefined) {
      return (
        issue.closedAt !== null && Date.parse(issue.closedAt) >= windowStartMs
      );
    }
    return beforeIssue.state.toLowerCase() !== "closed";
  });
  if (newlyClosedIssue !== undefined) {
    const issue = after.issues[newlyClosedIssue]!;
    return {
      action: "issue_closed",
      title: issue.title,
      url: issue.url
    };
  }
  return null;
}

// Shared by every caller that renders an outcome claim (the per-project
// outcome line here and the fan-out summary's no-PR explanation) so the
// verified/unverified suffix can't drift between them.
export function unverifiedOutcomeSuffix(outcome: RoutineOutcome): string {
  return outcome.verified ? "" : " (unverified)";
}

export function formatRoutineOutcomeLine(
  projectName: string,
  outcome: RoutineOutcome
): string {
  const unverified = unverifiedOutcomeSuffix(outcome);
  if (outcome.status === "error") {
    return `❌ ${projectName} — failed (${outcome.summary || "error"})${unverified}`;
  }
  if (outcome.action === "none") {
    return `⏭️  ${projectName} — nothing to do${unverified}`;
  }
  const url = outcome.url === null ? "" : ` ${outcome.url}`;
  return `✅ ${projectName} — ${outcome.action}: "${outcome.title}"${url}${unverified}`;
}

export function reconcileRoutineOutcome(
  input: ReconcileRoutineOutcomeInput
): RoutineOutcome {
  if (
    input.observedAction !== null &&
    (input.claim === null ||
      input.claim.action === "none" ||
      input.claim.action === "commit" ||
      input.claim.status === "error")
  ) {
    return {
      ...input.observedAction,
      source: "gh",
      status: "success",
      summary: "Observed via GitHub state diff.",
      verified: true
    };
  }

  // A `none`/absent claim under-reports a real commit-only outcome, and so
  // does an external-action claim (pr/issue_opened/issue_closed) that no
  // GitHub observation corroborates — the retention query only protects rows
  // whose canonical action is a verified `commit`, so leaving an unconfirmed
  // external-action claim as the canonical outcome would let age-based
  // pruning delete the only copy of real commits behind it. Git evidence
  // overrides both cases here — unqualified by the claim's own status, per
  // ADR 0068 rule 4 — so a future retention pass never treats a
  // commit-bearing firing as claim-verified "nothing to do" or an
  // unconfirmed external action.
  const claimIsUnconfirmedExternalAction =
    input.claim !== null &&
    (input.claim.action === "pr" ||
      input.claim.action === "issue_opened" ||
      input.claim.action === "issue_closed") &&
    input.observedAction?.action !== input.claim.action;
  if (
    input.terminalState === "succeeded" &&
    input.commitsAhead &&
    (input.claim === null ||
      input.claim.action === "none" ||
      claimIsUnconfirmedExternalAction)
  ) {
    return {
      action: "commit",
      source: "git",
      status: "success",
      summary: "Observed commits ahead of the configured base branch.",
      title: "Commit retained in the Routine Firing workspace",
      url: null,
      verified: true
    };
  }

  if (
    input.claim !== null &&
    (input.terminalState === "succeeded" || input.observedAction !== null)
  ) {
    return {
      ...input.claim,
      source: input.provider,
      verified:
        (input.claim.action === "commit" && input.commitsAhead) ||
        (input.claim.status !== "error" &&
          (input.observedAction?.action === input.claim.action ||
            (input.claim.action === "none" &&
              input.githubObservationAvailable)))
    };
  }

  if (input.terminalState === "succeeded" && input.githubObservationAvailable) {
    return {
      action: "none",
      source: "gh",
      status: "no_action",
      summary: "GitHub state diff observed no external action.",
      title: "",
      url: null,
      verified: true
    };
  }

  if (input.terminalState === "succeeded") {
    return {
      action: "none",
      source: "symphonika",
      status: "no_action",
      summary: "No externally observable action was reported.",
      title: "",
      url: null,
      verified: false
    };
  }

  return {
    action: "none",
    source: "symphonika",
    status: "error",
    summary:
      input.terminalReason ??
      (input.terminalState === "cancelled" ? "cancelled" : "routine failed"),
    title: "",
    url: null,
    verified: false
  };
}

function sortedNumericKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).sort(
    (left, right) => Number(left) - Number(right)
  );
}
