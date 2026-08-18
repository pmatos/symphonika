// #308's triage verdict: a short, human string explaining why Symphonika is
// (or isn't) working an issue. Built from the persisted poll snapshot's own
// `kind`/`reasons` (evaluateProjectEligibility's output at poll time, see
// issue-polling.ts), never recomputed against live config — the snapshot IS
// the verdict, per ADR 0073. See docs/adr/0077-issue-triage-and-label-writes.md
// for why this stays a pure transform rather than a live recomputation.

export type IssueVerdictSnapshot = {
  kind: "candidate" | "filtered";
  reasons: string[];
};

const EXCLUDED_LABEL_REASON = /^has excluded label (.+)$/;
const MISSING_LABEL_REASON = /^missing required label (.+)$/;
const OPERATIONAL_LABEL_REASON = /^has operational label (.+)$/;
const STATE_REASON = /^state (.+) is not eligible$/;
// evaluateProjectEligibility's own dependency-gate reasons (src/issue-polling.ts) --
// native GitHub blockedBy data, never parsed from issue-body text.
const DEPENDENCY_REASON = /^blocked by open dependency (.+)$/;
const DEPENDENCY_TRUNCATED_REASON =
  /^has more dependency links than could be checked.*$/;

// Operational labels whose presence means a Run may currently hold this
// issue (see REQUIRED_OPERATIONAL_LABELS in operational-labels.ts); the
// caller resolves the actual Run id, if any, via the Run Store — this
// module stays pure and DB-free.
const CLAIM_LABELS: ReadonlySet<string> = new Set([
  "sym:claimed",
  "sym:running"
]);

// Describes a single snapshot row's verdict. `claimedRunId` is the most
// recent Run's id for this (project, issue), resolved by the caller — pass
// undefined when no matching Run exists (e.g. the label was added by hand
// outside Symphonika).
export function describeIssueVerdict(
  snapshot: IssueVerdictSnapshot,
  claimedRunId: string | undefined
): string {
  if (snapshot.kind === "candidate") {
    return "eligible";
  }
  if (snapshot.reasons.length === 0) {
    return "filtered";
  }
  return snapshot.reasons
    .map((reason) => describeReason(reason, claimedRunId))
    .join("; ");
}

function describeReason(
  reason: string,
  claimedRunId: string | undefined
): string {
  const excluded = EXCLUDED_LABEL_REASON.exec(reason);
  if (excluded !== null) {
    return `filtered: ${excluded[1]}`;
  }

  const missing = MISSING_LABEL_REASON.exec(reason);
  if (missing !== null) {
    return `filtered: missing ${missing[1]}`;
  }

  const operational = OPERATIONAL_LABEL_REASON.exec(reason);
  if (operational !== null) {
    const label = operational[1] ?? "";
    if (CLAIM_LABELS.has(label)) {
      return claimedRunId === undefined
        ? `blocked: ${label}`
        : `claimed by run ${claimedRunId}`;
    }
    return `blocked: ${label}`;
  }

  const state = STATE_REASON.exec(reason);
  if (state !== null) {
    return `filtered: state ${state[1]}`;
  }

  const dependency = DEPENDENCY_REASON.exec(reason);
  if (dependency !== null) {
    return `blocked: dependency ${dependency[1]} open`;
  }

  if (DEPENDENCY_TRUNCATED_REASON.test(reason)) {
    return `blocked: ${reason}`;
  }

  return reason;
}
