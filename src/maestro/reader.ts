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

export type MaestroEvidenceReader = {
  getIssue(
    projectName: string,
    issueNumber: number
  ): MaestroIssueEvidence | undefined;
  getRun(runId: string): MaestroRunEvidence | undefined;
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
  // listProjectIssueSnapshots returns every snapshot ordered by issue_number
  // ascending with no limit; slicing from the end (rather than the start)
  // keeps the newest/highest-numbered issues under the cap instead of
  // silently keeping only the oldest ones.
  const listIssues = (projectName: string): MaestroIssueEvidence[] =>
    runStore
      .listProjectIssueSnapshots(projectName)
      .slice(-MAX_EVIDENCE_ITEMS)
      .map((row) => toIssueEvidence(projectName, row));

  const listRuns = (projectName?: string): MaestroRunEvidence[] =>
    runStore
      .listRuns({
        limit: MAX_EVIDENCE_ITEMS,
        ...(projectName === undefined ? {} : { project: projectName })
      })
      .map((run) => ({
        branchName: run.branchName,
        href: runHref(run.id),
        id: run.id,
        issueNumber: run.issueNumber,
        issueTitle: run.issueTitle,
        observedAt: run.updatedAt,
        projectName: run.project,
        state: run.state,
        terminalReason: run.terminalReason
      }));

  return {
    // Deliberately not listIssues(projectName).find(...): listIssues is
    // capped to the newest MAX_EVIDENCE_ITEMS, so a lookup by number must
    // search the full, unsliced snapshot list or it would wrongly report
    // "not found" for a real issue the cap excluded from a list call.
    getIssue: (projectName, issueNumber) => {
      const row = runStore
        .listProjectIssueSnapshots(projectName)
        .find((candidate) => candidate.issueNumber === issueNumber);
      return row === undefined ? undefined : toIssueEvidence(projectName, row);
    },
    getRun: (runId) => {
      const run = runStore.getRun(runId);
      return run === undefined
        ? undefined
        : {
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
    // listProjectPullRequestSnapshots is likewise ordered pr_number
    // ascending with no limit; slice from the end for the same reason as
    // listIssues above.
    listPullRequests: (projectName) =>
      runStore
        .listProjectPullRequestSnapshots(projectName)
        .slice(-MAX_EVIDENCE_ITEMS)
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
