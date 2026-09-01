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
