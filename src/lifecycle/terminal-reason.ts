import type { BranchPublication } from "./branch-on-origin.js";

export type CapReachedKind = "no_commits" | "no_pr" | "work_landed" | "unknown";

const CAP_REACHED_PREFIX = "cap_reached:";

const CAP_REACHED_KINDS: ReadonlySet<CapReachedKind> = new Set([
  "no_commits",
  "no_pr",
  "work_landed",
  "unknown"
]);

export function buildCapReachedReason(kind: CapReachedKind): string {
  return `${CAP_REACHED_PREFIX}${kind}`;
}

export function parseCapReachedReason(
  reason: string | null
): CapReachedKind | null {
  if (reason === null || !reason.startsWith(CAP_REACHED_PREFIX)) {
    return null;
  }
  const suffix = reason.slice(CAP_REACHED_PREFIX.length);
  return CAP_REACHED_KINDS.has(suffix as CapReachedKind)
    ? (suffix as CapReachedKind)
    : null;
}

const CAP_REACHED_LABELS: Readonly<Record<CapReachedKind, string>> = {
  no_commits: "no commits on issue branch",
  no_pr: "commits exist but no pull request",
  work_landed: "a pull request was merged (issue should normally have closed)",
  unknown: "branch state could not be determined"
};

export function formatCapReachedReason(
  kind: CapReachedKind,
  continuationCount: number
): string {
  const noun = continuationCount === 1 ? "continuation" : "continuations";
  return `continuation cap reached after ${continuationCount} ${noun}: ${CAP_REACHED_LABELS[kind]}`;
}

const NO_WORKSPACE_CHANGES_REASON = "no_workspace_changes";

// Shared by the writer (classify-failure.ts, when the workspace shows zero
// commits ahead of base) and readers that must not treat this specific
// blocked outcome like an ordinary one, e.g. the fresh-dispatch suppression
// guard (run-store.ts). See ADR 0058's issue #683 amendment.
export function isNoWorkspaceChangesReason(reason: string | null): boolean {
  return reason === NO_WORKSPACE_CHANGES_REASON;
}

const MERGE_PR_REFUSED_PREFIX = "merge_pr_refused:";

export function buildMergePrRefusedReason(
  prNumber: number,
  message: string
): string {
  return `${MERGE_PR_REFUSED_PREFIX} PR #${prNumber}: ${message}`;
}

// Shared by the writer (run-controller.ts, terminalizing a refused merge_pr
// Run) and every reader that must not treat this specific blocked outcome
// like an ordinary one: failure-only notification policy (issue-run.ts) and
// the global PR follow-up loop's re-merge guard (pull-request-followup.ts).
export function isMergePrRefusedReason(reason: string | null): boolean {
  return reason !== null && reason.startsWith(MERGE_PR_REFUSED_PREFIX);
}

const NO_PULL_REQUEST_TRACKED_PREFIX = "no_pull_request_tracked:";

// Written when a wait/merge_pr state's re-evaluation never finds a tracked
// pull request after MAX_PR_UNTRACKED_WAIT_ATTEMPTS ticks (run-controller.ts).
// Unlike merge_pr_refused, no reader needs to special-case this reason today
// — it should surface through the ordinary failure-notification path, since
// a silently-stuck issue surfacing is the whole point of the bound.
export function buildNoPullRequestTrackedReason(
  waitStateId: string,
  attempts: number,
  context: readonly string[] = []
): string {
  return withContext(
    `${NO_PULL_REQUEST_TRACKED_PREFIX} state "${waitStateId}" never observed a tracked pull request after ${attempts} checks`,
    context
  );
}

// Written (as a transient failure, so the retry budget applies) when a run
// exits 0 with commits ahead of base but the Issue Branch is missing from
// origin or sits at a different commit than the workspace head (issue #833).
export function buildBranchNotPushedReason(
  branchName: string,
  publication: Extract<BranchPublication, { kind: "missing" | "stale" }>
): string {
  const detail =
    publication.kind === "missing"
      ? "branch does not exist on origin"
      : `origin is at ${publication.originSha.slice(0, 12)}, workspace head is ${publication.localSha.slice(0, 12)}`;
  return `branch_not_pushed: branch "${branchName}" has commits but never reached origin (${detail})`;
}

const PULL_REQUEST_DISCOVERY_EXHAUSTED_PREFIX =
  "pull_request_discovery_exhausted:";

// Written when discoverPullRequests (pull-request-followup.ts) never finds a
// pull request for a succeeded run's branch after
// MAX_PULL_REQUEST_DISCOVERY_ATTEMPTS ticks. Mirrors
// buildNoPullRequestTrackedReason's shape for the other row set (`state =
// 'succeeded'`, not `'waiting'`) sharing the same silent-give-up gap; like
// that reason, no reader needs to special-case this one today.
export function buildPullRequestDiscoveryExhaustedReason(
  branchName: string,
  attempts: number,
  context: readonly string[] = []
): string {
  return withContext(
    `${PULL_REQUEST_DISCOVERY_EXHAUSTED_PREFIX} branch "${branchName}" never had a discoverable pull request after ${attempts} checks`,
    context
  );
}

// Diagnostic clauses (issue #830) appended after the stable reason prefix: what
// the remote actually holds for the branch and how the rest of the run chain
// ended. A reason with no clauses is byte-identical to the pre-#830 string.
function withContext(base: string, context: readonly string[]): string {
  return context.length === 0 ? base : `${base}; ${context.join("; ")}`;
}

export type BranchRemoteState =
  "never_pushed" | "pushed_no_pull_request" | "removed_after_pull_request";

export function describeBranchRemoteState(state: BranchRemoteState): string {
  switch (state) {
    case "never_pushed":
      return "branch was never pushed to origin";
    case "pushed_no_pull_request":
      return "branch exists on origin but has no open pull request";
    case "removed_after_pull_request":
      return "branch is no longer on origin but a pull request for it exists";
  }
}

const MAX_CHAIN_RUN_DETAIL_LENGTH = 200;

export function describeLatestChainRun(
  run: {
    cancelReason: string | null;
    id: string;
    state: string;
    terminalReason: string | null;
  },
  ended: boolean
): string {
  const raw = (run.terminalReason ?? run.cancelReason)?.replace(/\s+/g, " ");
  // Array.from keeps a cut from landing inside a surrogate pair of text
  // echoed from provider output.
  const detail =
    raw !== undefined && raw.length > MAX_CHAIN_RUN_DETAIL_LENGTH
      ? `${Array.from(raw).slice(0, MAX_CHAIN_RUN_DETAIL_LENGTH).join("")}…`
      : raw;
  const verb = ended ? "ended" : "is";
  return `latest run in this chain (${run.id}) ${verb} ${run.state}${detail === undefined ? "" : ` (${detail})`}`;
}
