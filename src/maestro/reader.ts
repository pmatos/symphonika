import type { RunStore } from "../run-store.js";

// The narrow read-only surface Maestro's tool registry (src/maestro/
// tools.ts) and conversation loop are given over RunStore — never RunStore
// itself. Every field a Maestro reply might cite already carries an
// internal href and an observed/polled timestamp, so a citation is built
// straight from these records rather than re-derived or taken from model
// output. Deliberately excludes every write method (createRun,
// replaceProjectIssueSnapshots, writeIssueLabels, mergePullRequest, ...) by
// construction: there is no way to reach a mutation through this type.
//
// Every list method is capped at MAX_EVIDENCE_ITEMS: a single Project's
// issue/PR snapshot, or an unfiltered Run listing, has no inherent upper
// bound, and sending thousands of rows to the model on one chat message
// would both inflate the request and flood the rendered reply with
// citations. The cap is a defensive bound on response size, not a claim
// that the omitted rows don't exist — a reply that needs more should ask a
// narrower question (e.g. one Project at a time).
const MAX_EVIDENCE_ITEMS = 25;

type MaestroProjectEvidence = {
  href: string;
  lastPollError: string | null;
  lastPollOk: boolean | null;
  lastSuccessfulPollAt: string | null;
  observedAt: string;
  projectName: string;
  validationState: string;
};

type MaestroIssueEvidence = {
  href: string;
  issueNumber: number;
  kind: string;
  labels: string[];
  observedAt: string;
  projectName: string;
  reasons: string[];
  title: string;
};

type MaestroRunEvidence = {
  branchName: string;
  href: string;
  id: string;
  issueNumber: number;
  issueTitle: string;
  observedAt: string;
  projectName: string;
  state: string;
  terminalReason: string | null;
};

type MaestroPullRequestEvidence = {
  checks: string | null;
  draft: boolean;
  href: string;
  merged: boolean;
  observedAt: string;
  open: boolean;
  prNumber: number;
  projectName: string;
  reviewDecision: string | null;
  title: string;
  url: string | null;
};

// What a Run-specific repository question needs to read the Run's own code:
// the Project it belongs to, its branch, and the head sha Symphonika last
// observed on that branch's pull request (null when none was tracked, in
// which case the branch tip is fetched instead and disclosed as such).
type MaestroRunRevisionEvidence = {
  branchName: string;
  projectName: string;
  recordedHeadSha: string | null;
};

export type MaestroEvidenceReader = {
  getIssue(
    projectName: string,
    issueNumber: number
  ): MaestroIssueEvidence | undefined;
  getRun(runId: string): MaestroRunEvidence | undefined;
  getRunRevision(runId: string): MaestroRunRevisionEvidence | undefined;
  listIssues(projectName: string): MaestroIssueEvidence[];
  listProjects(): MaestroProjectEvidence[];
  listPullRequests(projectName: string): MaestroPullRequestEvidence[];
  listRuns(projectName?: string): MaestroRunEvidence[];
};

function projectHref(projectName: string): string {
  return `/projects/${encodeURIComponent(projectName)}`;
}

function issueHref(projectName: string, issueNumber: number): string {
  return `/issues/${encodeURIComponent(projectName)}/${issueNumber}`;
}

function pullRequestHref(projectName: string, prNumber: number): string {
  return `/prs/${encodeURIComponent(projectName)}/${prNumber}`;
}

function runHref(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}`;
}

function toRunEvidence(run: {
  branchName: string;
  id: string;
  issueNumber: number;
  issueTitle: string;
  project: string;
  state: string;
  terminalReason: string | null;
  updatedAt: string;
}): MaestroRunEvidence {
  return {
    branchName: run.branchName,
    href: runHref(run.id),
    id: run.id,
    issueNumber: run.issueNumber,
    issueTitle: run.issueTitle,
    observedAt: run.updatedAt,
    projectName: run.project,
    state: run.state,
    terminalReason: run.terminalReason
  };
}

function toIssueEvidence(
  projectName: string,
  row: {
    issueNumber: number;
    kind: string;
    labels: string[];
    polledAt: string;
    reasons: string[];
    title: string;
  }
): MaestroIssueEvidence {
  return {
    href: issueHref(projectName, row.issueNumber),
    issueNumber: row.issueNumber,
    kind: row.kind,
    labels: row.labels,
    observedAt: row.polledAt,
    projectName,
    reasons: row.reasons,
    title: row.title
  };
}

export function createMaestroEvidenceReader(
  runStore: RunStore
): MaestroEvidenceReader {
  const listIssues = (projectName: string): MaestroIssueEvidence[] =>
    runStore
      .listProjectIssueSnapshots(projectName, MAX_EVIDENCE_ITEMS)
      .map((row) => toIssueEvidence(projectName, row));

  const listRuns = (projectName?: string): MaestroRunEvidence[] =>
    runStore
      .listRuns({
        limit: MAX_EVIDENCE_ITEMS,
        ...(projectName === undefined ? {} : { project: projectName })
      })
      .map(toRunEvidence);

  return {
    // Indexed point lookup (the table's primary key is (project_name,
    // issue_number)) rather than scanning listIssues' capped output or the
    // full unsliced snapshot list -- a lookup by number must not report
    // "not found" for a real issue a MAX_EVIDENCE_ITEMS cap excluded.
    getIssue: (projectName, issueNumber) => {
      const row = runStore.getProjectIssueSnapshot(projectName, issueNumber);
      return row === undefined ? undefined : toIssueEvidence(projectName, row);
    },
    getRun: (runId) => {
      const run = runStore.getRun(runId);
      return run === undefined ? undefined : toRunEvidence(run);
    },
    getRunRevision: (runId) => {
      const run = runStore.getRun(runId);
      if (run === undefined) {
        return undefined;
      }
      const recorded = runStore
        .listProjectPullRequestSnapshots(run.project)
        .filter((pr) => pr.headRef === run.branchName && pr.headSha !== null)
        .at(-1);
      return {
        branchName: run.branchName,
        projectName: run.project,
        recordedHeadSha: recorded?.headSha ?? null
      };
    },
    listIssues,
    // Project status evidence (AC1): poll provenance, age, and failure
    // state — the same ProjectState fields /projects/:name's capacity
    // strip reads — not just a bare name. Scoped to active Projects by
    // listProjectStates()'s own default, matching the prior
    // listActiveProjectNames() behavior this replaced.
    listProjects: () =>
      runStore.listProjectStates().map((state) => ({
        href: projectHref(state.projectName),
        lastPollError: state.lastPollError,
        lastPollOk: state.lastPollOk,
        lastSuccessfulPollAt: state.lastSuccessfulPollAt,
        observedAt: state.lastSuccessfulPollAt ?? state.updatedAt,
        projectName: state.projectName,
        validationState: state.validationState
      })),
    listPullRequests: (projectName) =>
      runStore
        .listProjectPullRequestSnapshots(projectName, MAX_EVIDENCE_ITEMS)
        .map((pr) => ({
          checks: pr.checks,
          draft: pr.draft,
          href: pullRequestHref(projectName, pr.prNumber),
          merged: pr.merged,
          observedAt: pr.polledAt,
          open: pr.open,
          prNumber: pr.prNumber,
          projectName,
          reviewDecision: pr.reviewDecision,
          title: pr.title,
          url: pr.url
        })),
    listRuns
  };
}
