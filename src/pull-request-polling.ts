import {
  envReferenceName,
  resolveEnvBackedValue,
  tryGetPullRequestFollowupState,
  tryListPullRequests,
  type GitHubIssueRepositoryInput,
  type GitHubIssuesApi,
  type PollingProjectConfig,
  type PollingServiceConfig,
  type RawGitHubPullRequest
} from "./issue-polling.js";
import {
  interpretPullRequest,
  type PullRequestState
} from "./pull-request-state.js";

export type PullRequestBranchOrigin =
  "issue_branch" | "routine_firing_branch" | "neither";

// Issue Branches are `sym/<project>/<issue>-<slug>` (planWorkspacePaths,
// src/workspace-paths.ts); Routine Firing branches are
// `sym/<project>/routine/<routine>/<firing-prefix>` (routineFiringBranchName,
// src/routines/workspace.ts). Both are Symphonika-created; only the
// `/routine/` segment tells them apart, so classification is structural on
// the ref string alone rather than re-deriving either naming scheme.
export function classifyPullRequestBranchOrigin(
  ref: string | undefined
): PullRequestBranchOrigin {
  if (ref === undefined || !ref.startsWith("sym/")) {
    return "neither";
  }
  return ref.includes("/routine/") ? "routine_firing_branch" : "issue_branch";
}

// One row per open PR, enriched with Symphonika's own Pull Request State
// (src/pull-request-state.ts) fetched at poll time — see #309 (ADR 0077):
// a dashboard list/detail page reading this per request would fire far more
// GraphQL follow-up calls, on an unpredictable cadence, than a bounded poll
// tick does. `stateAvailable` distinguishes "state fetch failed or is
// unsupported by this GitHubIssuesApi" from "GitHub genuinely reported
// unknown" — both would otherwise collapse to the same null/"unknown"
// fields and silently misrepresent the row.
export type ProjectPullRequestSnapshot = {
  branchOrigin: PullRequestBranchOrigin;
  checks: PullRequestState["checks"] | null;
  draft: boolean;
  headRef: string | null;
  headSha: string | null;
  mergeable: PullRequestState["mergeable"] | null;
  merged: boolean;
  open: boolean;
  prNumber: number;
  project: string;
  reviewDecision: PullRequestState["reviewDecision"] | null;
  stateAvailable: boolean;
  title: string;
  trackingState: PullRequestState["trackingState"] | null;
  unresolvedReviewThreads: number | null;
  url: string | null;
};

export type ProjectPullRequestPollReport = {
  error?: string;
  fetchedPullRequests: number;
  lastPolledAt?: string;
  name: string;
  ok: boolean;
};

export type PullRequestPollStatus = {
  errors: string[];
  projects: ProjectPullRequestPollReport[];
  pullRequests: ProjectPullRequestSnapshot[];
};

export function emptyPullRequestPollStatus(): PullRequestPollStatus {
  return { errors: [], projects: [], pullRequests: [] };
}

export async function pollConfiguredGitHubPullRequestsFromConfig(options: {
  config: PollingServiceConfig;
  env?: NodeJS.ProcessEnv;
  githubIssuesApi: GitHubIssuesApi;
}): Promise<PullRequestPollStatus> {
  const env = options.env ?? process.env;
  const status = emptyPullRequestPollStatus();

  for (const project of options.config.projects) {
    if (project.disabled === true) {
      continue;
    }
    await pollProjectPullRequests(
      project,
      env,
      options.githubIssuesApi,
      status
    );
  }

  return status;
}

async function pollProjectPullRequests(
  project: PollingProjectConfig,
  env: NodeJS.ProcessEnv,
  api: GitHubIssuesApi,
  status: PullRequestPollStatus
): Promise<void> {
  const lastPolledAt = new Date().toISOString();
  const token = resolveEnvBackedValue(project.tracker.token, env);
  if (token === undefined) {
    const variableName = envReferenceName(project.tracker.token);
    const error =
      variableName === undefined
        ? `projects.${project.name}.tracker.token must reference an environment variable like $GITHUB_TOKEN`
        : `projects.${project.name}.tracker.token references unset environment variable $${variableName}`;
    status.errors.push(error);
    status.projects.push({
      error,
      fetchedPullRequests: 0,
      lastPolledAt,
      name: project.name,
      ok: false
    });
    return;
  }

  const repoInput: GitHubIssueRepositoryInput = {
    owner: project.tracker.owner,
    repo: project.tracker.repo,
    token
  };

  let rawPullRequests: RawGitHubPullRequest[];
  try {
    rawPullRequests = (await tryListPullRequests(api, repoInput)) ?? [];
  } catch (error) {
    const message = `projects.${project.name}.tracker.repository ${project.tracker.owner}/${project.tracker.repo} pull requests could not be listed: ${errorMessage(error)}`;
    status.errors.push(message);
    status.projects.push({
      error: message,
      fetchedPullRequests: 0,
      lastPolledAt,
      name: project.name,
      ok: false
    });
    return;
  }

  // Each PR's state enrichment is an independent GraphQL round-trip with its
  // own internal error isolation (buildSnapshot's try/catch) — fetching them
  // concurrently keeps one project's poll tick from taking N times a single
  // round-trip's latency for no benefit.
  const numberedPullRequests = rawPullRequests.filter(
    (raw): raw is RawGitHubPullRequest & { number: number } =>
      raw.number !== undefined
  );
  const snapshots = await Promise.all(
    numberedPullRequests.map((raw) =>
      buildSnapshot(raw, raw.number, project.name, repoInput, api)
    )
  );
  status.pullRequests.push(...snapshots);

  status.projects.push({
    fetchedPullRequests: snapshots.length,
    lastPolledAt,
    name: project.name,
    ok: true
  });
}

async function buildSnapshot(
  raw: RawGitHubPullRequest,
  prNumber: number,
  projectName: string,
  repoInput: GitHubIssueRepositoryInput,
  api: GitHubIssuesApi
): Promise<ProjectPullRequestSnapshot> {
  const base: ProjectPullRequestSnapshot = {
    branchOrigin: classifyPullRequestBranchOrigin(raw.head?.ref),
    checks: null,
    draft: raw.draft ?? false,
    headRef: raw.head?.ref ?? null,
    headSha: raw.head?.sha ?? null,
    mergeable: null,
    merged: raw.merged_at !== null && raw.merged_at !== undefined,
    open: raw.state === "open",
    prNumber,
    project: projectName,
    reviewDecision: null,
    stateAvailable: false,
    title: raw.title ?? "",
    trackingState: null,
    unresolvedReviewThreads: null,
    url: raw.html_url ?? null
  };

  let followup;
  try {
    followup = await tryGetPullRequestFollowupState(api, {
      ...repoInput,
      pullNumber: prNumber
    });
  } catch {
    // A single PR's enrichment failing must not drop the row — #259's
    // orphans are exactly the case AC4 needs visible even when GitHub
    // follow-up state can't be fetched for them.
    return base;
  }
  if (followup === null || followup === undefined) {
    return base;
  }

  const state = interpretPullRequest(followup);
  return {
    ...base,
    checks: state.checks,
    headSha: state.headSha,
    mergeable: state.mergeable,
    merged: state.merged,
    open: state.open,
    reviewDecision: state.reviewDecision,
    stateAvailable: true,
    trackingState: state.trackingState,
    unresolvedReviewThreads: state.unresolvedReviewThreads,
    url: state.url
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
