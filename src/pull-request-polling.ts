import { normalizeLabels } from "./issue-priority.js";
import {
  envReferenceName,
  isRateLimitError,
  resolveEnvBackedValue,
  tryGetPullRequestFollowupState,
  tryListPullRequests,
  type GitHubIssueRepositoryInput,
  type GitHubIssuesApi,
  type GitHubRepositoryIdentity,
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
type ProjectPullRequestSnapshot = {
  branchOrigin: PullRequestBranchOrigin;
  checks: PullRequestState["checks"] | null;
  draft: boolean;
  headRef: string | null;
  headSha: string | null;
  labels: string[];
  mergeable: PullRequestState["mergeable"] | null;
  merged: boolean;
  open: boolean;
  prNumber: number;
  project: string;
  repository: GitHubRepositoryIdentity;
  reviewDecision: PullRequestState["reviewDecision"] | null;
  stateAvailable: boolean;
  title: string;
  trackingState: PullRequestState["trackingState"] | null;
  unresolvedReviewThreads: number | null;
  url: string | null;
};

type ProjectPullRequestPollReport = {
  error?: string;
  fetchedPullRequests: number;
  lastPolledAt?: string;
  name: string;
  ok: boolean;
  repository: GitHubRepositoryIdentity;
};

export type PullRequestPollStatus = {
  errors: string[];
  projects: ProjectPullRequestPollReport[];
  pullRequests: ProjectPullRequestSnapshot[];
};

function emptyPullRequestPollStatus(): PullRequestPollStatus {
  return { errors: [], projects: [], pullRequests: [] };
}

export async function pollConfiguredGitHubPullRequestsFromConfig(options: {
  config: PollingServiceConfig;
  // Defaults to a process-lifetime module singleton (below) so daemon.ts's
  // repeated polling ticks share one enrichment budget without having to
  // thread a cache through. Tests inject a fresh Map so cases using the
  // same project/PR number don't see another case's cached enrichment.
  enrichmentCache?: Map<string, CachedPullRequestEnrichment>;
  env?: NodeJS.ProcessEnv;
  githubIssuesApi: GitHubIssuesApi;
}): Promise<PullRequestPollStatus> {
  const env = options.env ?? process.env;
  const cache = options.enrichmentCache ?? defaultEnrichmentCache;
  const status = emptyPullRequestPollStatus();
  const seenEnrichmentCacheKeys = new Set<string>();

  for (const project of options.config.projects) {
    if (project.disabled === true) {
      continue;
    }
    await pollProjectPullRequests(
      project,
      env,
      options.githubIssuesApi,
      status,
      cache,
      seenEnrichmentCacheKeys
    );
  }

  // A PR no longer returned by any project's poll (closed, merged and aged
  // out, or the repo/project reconfigured) has no reason to keep its
  // enrichment cached forever -- an unbounded-lifetime daemon would
  // otherwise leak one entry per PR ever seen.
  for (const key of cache.keys()) {
    if (!seenEnrichmentCacheKeys.has(key)) {
      cache.delete(key);
    }
  }

  return status;
}

async function pollProjectPullRequests(
  project: PollingProjectConfig,
  env: NodeJS.ProcessEnv,
  api: GitHubIssuesApi,
  status: PullRequestPollStatus,
  cache: Map<string, CachedPullRequestEnrichment>,
  seenEnrichmentCacheKeys: Set<string>
): Promise<void> {
  const lastPolledAt = new Date().toISOString();
  const repository: GitHubRepositoryIdentity = {
    owner: project.tracker.owner,
    repo: project.tracker.repo
  };
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
      ok: false,
      repository
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
    const listedPullRequests = await tryListPullRequests(api, repoInput);
    if (listedPullRequests === undefined) {
      throw new Error("GitHub API does not support listing pull requests");
    }
    rawPullRequests = listedPullRequests;
  } catch (error) {
    const message = `projects.${project.name}.tracker.repository ${project.tracker.owner}/${project.tracker.repo} pull requests could not be listed: ${errorMessage(error)}`;
    status.errors.push(message);
    status.projects.push({
      error: message,
      fetchedPullRequests: 0,
      lastPolledAt,
      name: project.name,
      ok: false,
      repository
    });
    return;
  }

  // Each PR's state enrichment is an independent GraphQL round-trip with its
  // own internal error isolation (buildSnapshot's try/catch) — fetching a
  // bounded batch at a time keeps one project's poll tick from taking N
  // times a single round-trip's latency, without an unbounded Promise.all
  // bursting every open PR's request at once against the same token the
  // primary PR-follow-up loop (pull-request-followup.ts, sequential by
  // design) also depends on for its own rate limit.
  const numberedPullRequests = rawPullRequests.filter(
    (raw): raw is RawGitHubPullRequest & { number: number } =>
      raw.number !== undefined
  );
  const nowMs = Date.now();
  for (const raw of numberedPullRequests) {
    seenEnrichmentCacheKeys.add(
      enrichmentCacheKey(project.name, repository, raw.number)
    );
  }
  // Shared across this batch's concurrent workers: once any of them hits a
  // rate limit, the rest stop starting NEW enrichment calls (an in-flight
  // call already underway when the flag flips still completes -- there's no
  // way to abort a request already sent) instead of draining the remainder
  // of a long PR list against an already-exhausted token. See ADR 0083.
  let enrichmentRateLimited = false;
  const built = await mapWithConcurrency(
    numberedPullRequests,
    PULL_REQUEST_ENRICHMENT_CONCURRENCY,
    (raw) =>
      buildSnapshot(
        raw,
        raw.number,
        project.name,
        repository,
        repoInput,
        api,
        nowMs,
        cache,
        () => enrichmentRateLimited
      ).then((result) => {
        if (result.enrichmentError !== undefined) {
          enrichmentRateLimited = true;
        }
        return result;
      })
  );
  status.pullRequests.push(...built.map((entry) => entry.snapshot));

  // A rate-limited enrichment call must still surface here even though the
  // row itself is kept (see buildSnapshot's catch) -- otherwise the caller
  // (daemon.ts's engageGithubBackoff) never sees the rate limit and retries
  // the same GraphQL calls every tick. See ADR 0083.
  const rateLimitError = built.find(
    (entry) => entry.enrichmentError !== undefined
  )?.enrichmentError;

  status.projects.push({
    ...(rateLimitError === undefined ? {} : { error: rateLimitError }),
    fetchedPullRequests: built.length,
    lastPolledAt,
    name: project.name,
    ok: true,
    repository
  });
  if (rateLimitError !== undefined) {
    status.errors.push(rateLimitError);
  }
}

// Concurrent, not sequential (unlike pull-request-followup.ts's loops) --
// but bounded, not a single Promise.all: GitHub's secondary rate limits
// react to request bursts, not just total call volume, so this caps how
// many of a project's PR-state fetches are in flight at once regardless
// of how many open PRs it has.
export const PULL_REQUEST_ENRICHMENT_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
  return results;
}

export type CachedPullRequestEnrichment = {
  checks: PullRequestState["checks"] | null;
  enrichedAtMs: number;
  mergeable: PullRequestState["mergeable"] | null;
  merged: boolean;
  open: boolean;
  reviewDecision: PullRequestState["reviewDecision"] | null;
  trackingState: PullRequestState["trackingState"] | null;
  unresolvedReviewThreads: number | null;
  url: string | null;
};

// The default when a caller doesn't inject its own (see
// pollConfiguredGitHubPullRequestsFromConfig): every daemon.ts polling tick
// should share one enrichment budget, the same way a single process shares
// one GitHub rate limit. Repository identity is part of the key because
// duplicate Project names are allowed and PR numbers are repository-local.
const defaultEnrichmentCache = new Map<string, CachedPullRequestEnrichment>();

function enrichmentCacheKey(
  projectName: string,
  repository: GitHubRepositoryIdentity,
  prNumber: number
): string {
  return `${projectName}@${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}#${prNumber}`;
}

// Enrichment is a GraphQL round-trip against the same token
// pull-request-followup.ts's own (sequential) polling depends on. Without a
// floor, hourly volume scales as ticks-per-hour x open-PR-count — at the
// default 30s poll interval, 120 x every open PR, every hour, forever. A
// five-minute floor still keeps displayed PR state well within an operator's
// tolerance for "how stale is this checks/reviewDecision column" while
// cutting that volume by roughly 10x.
const PULL_REQUEST_ENRICHMENT_MIN_INTERVAL_MS = 5 * 60_000;

async function buildSnapshot(
  raw: RawGitHubPullRequest,
  prNumber: number,
  projectName: string,
  repository: GitHubRepositoryIdentity,
  repoInput: GitHubIssueRepositoryInput,
  api: GitHubIssuesApi,
  nowMs: number,
  cache: Map<string, CachedPullRequestEnrichment>,
  isEnrichmentRateLimited: () => boolean
): Promise<{ enrichmentError?: string; snapshot: ProjectPullRequestSnapshot }> {
  const base: ProjectPullRequestSnapshot = {
    branchOrigin: classifyPullRequestBranchOrigin(raw.head?.ref),
    checks: null,
    draft: raw.draft ?? false,
    headRef: raw.head?.ref ?? null,
    headSha: raw.head?.sha ?? null,
    labels: normalizeLabels(raw.labels ?? []),
    mergeable: null,
    merged: raw.merged_at !== null && raw.merged_at !== undefined,
    open: raw.state === "open",
    prNumber,
    project: projectName,
    repository,
    reviewDecision: null,
    stateAvailable: false,
    title: raw.title ?? "",
    trackingState: null,
    unresolvedReviewThreads: null,
    url: raw.html_url ?? null
  };

  const cacheKey = enrichmentCacheKey(projectName, repository, prNumber);
  const cached = cache.get(cacheKey);
  if (
    cached !== undefined &&
    nowMs - cached.enrichedAtMs < PULL_REQUEST_ENRICHMENT_MIN_INTERVAL_MS
  ) {
    return {
      snapshot: {
        ...base,
        checks: cached.checks,
        mergeable: cached.mergeable,
        merged: cached.merged,
        open: cached.open,
        reviewDecision: cached.reviewDecision,
        stateAvailable: true,
        trackingState: cached.trackingState,
        unresolvedReviewThreads: cached.unresolvedReviewThreads,
        url: cached.url
      }
    };
  }

  if (isEnrichmentRateLimited()) {
    // A sibling worker in this same batch already hit a rate limit on this
    // token -- skip this PR's GraphQL call rather than adding to an already
    // exhausted budget. The row still appears (from the cheap REST data
    // above), just unenriched for this tick.
    return { snapshot: base };
  }

  try {
    const followup = await tryGetPullRequestFollowupState(api, {
      ...repoInput,
      pullNumber: prNumber
    });
    if (followup === null || followup === undefined) {
      return { snapshot: base };
    }

    const state = interpretPullRequest(followup);
    const headSha = state.headSha === "" ? base.headSha : state.headSha;
    const enriched: Omit<CachedPullRequestEnrichment, "enrichedAtMs"> = {
      checks: state.checks,
      mergeable: state.mergeable,
      merged: state.merged,
      open: state.open,
      reviewDecision: state.reviewDecision,
      trackingState: state.trackingState,
      unresolvedReviewThreads: state.unresolvedReviewThreads,
      url: state.url
    };
    cache.set(cacheKey, { ...enriched, enrichedAtMs: nowMs });
    // GraphQL normalizes an omitted headRefOid to an empty string because PR
    // Follow-up requires a string-valued head SHA. Resolve that sentinel from
    // this poll's REST result, but do not cache it: a later poll may observe a
    // newly pushed commit while reusing the other GraphQL enrichment fields.
    return {
      snapshot: { ...base, ...enriched, headSha, stateAvailable: true }
    };
  } catch (error) {
    // A single PR's enrichment failing -- during either the fetch or its
    // interpretation -- must not drop the row. #259's orphans are exactly
    // the case AC4 needs visible even when GitHub follow-up state can't be
    // used for them. A rate-limit-shaped failure is still surfaced (not
    // swallowed) via enrichmentError so the caller can engage backoff
    // instead of retrying it every tick -- see ADR 0083.
    const message = errorMessage(error);
    return {
      ...(isRateLimitError(message) ? { enrichmentError: message } : {}),
      snapshot: base
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
