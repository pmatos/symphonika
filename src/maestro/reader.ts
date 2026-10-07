import type { RunStore } from "../run-store.js";

// The narrow read-only surface Maestro's tool registry (src/maestro/
// tools.ts) and conversation loop are given over RunStore — never RunStore
// itself. Every field a Maestro reply might cite already carries an
// internal href and an observed/polled timestamp, so a citation is built
// straight from these records rather than re-derived or taken from model
// output. Deliberately excludes every write method (createRun,
// replaceProjectIssueSnapshots, writeIssueLabels, mergePullRequest, ...) by
// construction: there is no way to reach a mutation through this type.
export type MaestroIssueEvidence = {
  href: string;
  issueNumber: number;
  kind: string;
  labels: string[];
  observedAt: string;
  projectName: string;
  reasons: string[];
  title: string;
};

export type MaestroRunEvidence = {
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

export type MaestroPullRequestEvidence = {
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
  listProjects(): string[];
  listPullRequests(projectName: string): MaestroPullRequestEvidence[];
  listRuns(projectName?: string): MaestroRunEvidence[];
};

function issueHref(projectName: string, issueNumber: number): string {
  return `/issues/${encodeURIComponent(projectName)}/${issueNumber}`;
}

function pullRequestHref(projectName: string, prNumber: number): string {
  return `/prs/${encodeURIComponent(projectName)}/${prNumber}`;
}

function runHref(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}`;
}

export function createMaestroEvidenceReader(
  runStore: RunStore
): MaestroEvidenceReader {
  const listIssues = (projectName: string): MaestroIssueEvidence[] =>
    runStore.listProjectIssueSnapshots(projectName).map((row) => ({
      href: issueHref(projectName, row.issueNumber),
      issueNumber: row.issueNumber,
      kind: row.kind,
      labels: row.labels,
      observedAt: row.polledAt,
      projectName,
      reasons: row.reasons,
      title: row.title
    }));

  const listRuns = (projectName?: string): MaestroRunEvidence[] =>
    runStore
      .listRuns(
        projectName === undefined ? undefined : { project: projectName }
      )
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
    getIssue: (projectName, issueNumber) =>
      listIssues(projectName).find(
        (issue) => issue.issueNumber === issueNumber
      ),
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
    listProjects: () => runStore.listActiveProjectNames(),
    listPullRequests: (projectName) =>
      runStore.listProjectPullRequestSnapshots(projectName).map((pr) => ({
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
