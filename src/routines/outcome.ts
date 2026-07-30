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
  after: RoutineGithubSnapshot
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
  const newlyOpenedIssue = sortedNumericKeys(after.issues).find(
    (number) => before.issues[number] === undefined
  );
  if (newlyOpenedIssue !== undefined) {
    const issue = after.issues[newlyOpenedIssue]!;
    return {
      action: "issue_opened",
      title: issue.title,
      url: issue.url
    };
  }
  const newlyClosedIssue = sortedNumericKeys(after.issues).find(
    (number) =>
      after.issues[number]?.state.toLowerCase() === "closed" &&
      before.issues[number]?.state.toLowerCase() !== "closed"
  );
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

export function formatRoutineOutcomeLine(
  projectName: string,
  outcome: RoutineOutcome
): string {
  if (outcome.status === "error") {
    return `❌ ${projectName} — failed (${outcome.summary || "error"})`;
  }
  if (outcome.action === "none") {
    const unverified = outcome.verified ? "" : " (unverified)";
    return `⏭️  ${projectName} — nothing to do${unverified}`;
  }
  const url = outcome.url === null ? "" : ` ${outcome.url}`;
  const unverified = outcome.verified ? "" : " (unverified)";
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

  if (input.claim !== null) {
    return {
      ...input.claim,
      source: input.provider,
      verified:
        input.observedAction?.action === input.claim.action ||
        input.claim.action === "none" ||
        (input.claim.action === "commit" && input.commitsAhead)
    };
  }

  if (input.terminalState === "succeeded" && input.commitsAhead) {
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
