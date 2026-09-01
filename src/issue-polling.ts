import { readFile } from "node:fs/promises";
import { Octokit } from "@octokit/rest";
import { parse } from "yaml";
import { z } from "zod";

import { projectDispatchSchema } from "./config-schemas.js";
import { normalizeLabels, priorityForLabels } from "./issue-priority.js";
import { REQUIRED_OPERATIONAL_LABELS } from "./operational-labels.js";

export type GitHubIssueRepositoryInput = {
  owner: string;
  repo: string;
  // Octokit carries cancellation under `request`, not at the top level, so
  // every method sharing this base gets the same plumbing via requestOption.
  signal?: AbortSignal;
  token: string;
};

function requestOption(input: { signal?: AbortSignal }): {
  request?: { signal: AbortSignal };
} {
  return input.signal === undefined
    ? {}
    : { request: { signal: input.signal } };
}

export type GitHubIssuesListInput = GitHubIssueRepositoryInput & {
  since?: string;
  state: "all" | "closed" | "open";
};

export type GitHubIssueLabelInput = GitHubIssueRepositoryInput & {
  issueNumber: number;
  labels: string[];
};

export type RawGitHubIssue = {
  body?: string | null;
  closed_at?: string | null;
  created_at?: string | null;
  html_url?: string | null;
  id?: number;
  labels?: unknown[];
  number?: number;
  pull_request?: unknown;
  state?: string;
  title?: string;
  updated_at?: string | null;
  url?: string | null;
};

export type RawGitHubCommit = {
  sha?: string;
};

export type RawGitHubPullRequest = {
  draft?: boolean;
  head?: { ref?: string; sha?: string };
  html_url?: string | null;
  labels?: unknown[];
  merged_at?: string | null;
  number?: number;
  state?: string;
  title?: string;
};

export type RawGitHubPullRequestFile = {
  filename?: string;
  previous_filename?: string;
};

type RawGitHubPullRequestReviewComment = {
  author?: string | null;
  body?: string | null;
  createdAt?: string | null;
  line?: number | null;
  path?: string | null;
  url?: string | null;
};

export type RawGitHubPullRequestReviewThread = {
  comments: RawGitHubPullRequestReviewComment[];
  id: string;
  isOutdated?: boolean | null;
  isResolved: boolean;
  line?: number | null;
  path?: string | null;
};

export type RawGitHubPullRequestFollowupState = {
  draft: boolean;
  headSha: string;
  mergeable: "CONFLICTING" | "MERGEABLE" | "UNKNOWN" | null;
  merged: boolean;
  number: number;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  state: "CLOSED" | "MERGED" | "OPEN" | "UNKNOWN";
  statusCheckRollupState:
    "ERROR" | "EXPECTED" | "FAILURE" | "PENDING" | "SUCCESS" | null;
  unresolvedReviewThreads: RawGitHubPullRequestReviewThread[];
  url: string;
};

export type GitHubBranchCommitsInput = GitHubIssueRepositoryInput & {
  branch: string;
  perPage?: number;
};

export type GitHubBranchPullRequestsInput = GitHubIssueRepositoryInput & {
  branch: string;
};

export type GitHubPullRequestInput = GitHubIssueRepositoryInput & {
  pullNumber: number;
};

export type GitHubPullRequestMergeInput = GitHubPullRequestInput & {
  expectedHeadSha?: string;
  method: "merge" | "rebase" | "squash";
};

export type GitHubIssuesApi = {
  addLabelsToIssue?: (input: GitHubIssueLabelInput) => Promise<void>;
  getIssue?: (
    input: GitHubIssueRepositoryInput & { issueNumber: number }
  ) => Promise<RawGitHubIssue | null>;
  getIssueDependencies?: (
    input: GitHubIssueRepositoryInput & { issueNumbers: number[] }
  ) => Promise<Map<number, RawGitHubIssueDependencies>>;
  listBranchCommits?: (
    input: GitHubBranchCommitsInput
  ) => Promise<RawGitHubCommit[] | null>;
  listIssues?: (input: GitHubIssuesListInput) => Promise<RawGitHubIssue[]>;
  listOpenIssues: (
    input: GitHubIssueRepositoryInput
  ) => Promise<RawGitHubIssue[]>;
  listPullRequests?: (
    input: GitHubIssueRepositoryInput
  ) => Promise<RawGitHubPullRequest[]>;
  listPullRequestsForBranch?: (
    input: GitHubBranchPullRequestsInput
  ) => Promise<RawGitHubPullRequest[]>;
  listPullRequestFiles?: (
    input: GitHubPullRequestInput
  ) => Promise<RawGitHubPullRequestFile[]>;
  getPullRequestFollowupState?: (
    input: GitHubPullRequestInput
  ) => Promise<RawGitHubPullRequestFollowupState | null>;
  mergePullRequest?: (input: GitHubPullRequestMergeInput) => Promise<void>;
  removeLabelsFromIssue?: (input: GitHubIssueLabelInput) => Promise<void>;
};

export type IssueSnapshot = {
  // GitHub's native issue-dependencies feature (Issue.blockedBy), fetched
  // separately via GraphQL during polling -- not derived from body text.
  // Optional (not every caller of this widely-used type deals in
  // dependency data): absent reads the same as "no known blockers", not
  // "unresolved". See docs/adr/0081-issue-dependency-gating-and-graph-view.md.
  blockedBy?: RawGitHubIssueDependencyRef[];
  blockedByTruncated?: boolean;
  body: string;
  created_at: string;
  id: number;
  labels: string[];
  number: number;
  // Best-effort "## Parent" heading parse (see parseParentIssueNumber) --
  // display-only graph clustering, never a gating signal. Undefined when
  // absent or unparseable, same as no epic membership.
  parentIssueNumber?: number;
  priority: number;
  state: string;
  title: string;
  updated_at: string;
  url: string;
};

type ProjectIssueSnapshot = {
  issue: IssueSnapshot;
  project: string;
  repository: GitHubRepositoryIdentity;
};

export type FilteredProjectIssueSnapshot = ProjectIssueSnapshot & {
  reasons: string[];
};

export type ProjectIssuePollReport = {
  candidateIssues?: number;
  fetchedIssues: number;
  filteredIssues?: number;
  lastPolledAt?: string;
  name: string;
  ok: boolean;
  repository: GitHubRepositoryIdentity;
  weight?: number;
  error?: string;
};

export type GitHubRepositoryIdentity = {
  owner: string;
  repo: string;
};

export type IssuePollStatus = {
  candidateIssues: ProjectIssueSnapshot[];
  errors: string[];
  filteredIssues: FilteredProjectIssueSnapshot[];
  projects: ProjectIssuePollReport[];
};

export type PollConfiguredGitHubIssuesOptions = {
  configPath: string;
  env?: NodeJS.ProcessEnv;
  githubIssuesApi?: GitHubIssuesApi;
};

export type PollingProjectConfig = z.infer<typeof pollingProjectSchema>;
export type PollingServiceConfig = {
  polling?: {
    interval_ms?: number | undefined;
  };
  projects: PollingProjectConfig[];
};

const providerNameSchema = z.enum(["codex", "claude", "omp"]);

// Routine Hosts (ADR 0062) are never polled for issues; check `mode` before
// this raw entry reaches pollingProjectSchema, which is dispatch-only.
function isRoutineHostProject(rawProject: unknown): boolean {
  return (
    rawProject !== null &&
    typeof rawProject === "object" &&
    "mode" in rawProject &&
    rawProject.mode === "routine_host"
  );
}

const pollingProjectSchema = z
  .object({
    name: z.string().trim().min(1),
    disabled: z.boolean().optional(),
    weight: z.number().int().positive().optional(),
    // Per-project concurrency cap; consumed by the runtime picker only.
    // Kept in this duplicate schema to preserve parsing parity. See ADR 0053.
    max_in_flight: z.number().int().positive().optional(),
    dispatch: projectDispatchSchema.optional(),
    tracker: z
      .object({
        kind: z.literal("github"),
        owner: z.string().trim().min(1),
        repo: z.string().trim().min(1),
        token: z.string().trim().min(1)
      })
      .passthrough(),
    issue_filters: z
      .object({
        states: z.array(z.literal("open")).min(1),
        labels_all: z.array(z.string().trim().min(1)),
        labels_none: z.array(z.string().trim().min(1))
      })
      .passthrough(),
    priority: z
      .object({
        labels: z.record(z.string(), z.number().int().nonnegative()),
        default: z.number().int().nonnegative()
      })
      .passthrough(),
    agent: z
      .object({
        provider: providerNameSchema
      })
      .passthrough()
  })
  .passthrough();

const pollingServiceConfigSchema = z
  .object({
    polling: z
      .object({
        interval_ms: z.number().int().positive().optional()
      })
      .passthrough()
      .optional(),
    projects: z.array(z.unknown()).min(1)
  })
  .passthrough();

const SILENT_OCTOKIT_LOG = {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined
};

class OctokitGitHubIssuesApi implements GitHubIssuesApi {
  async addLabelsToIssue(input: GitHubIssueLabelInput): Promise<void> {
    const octokit = this.octokit(input.token);
    await octokit.rest.issues.addLabels({
      issue_number: input.issueNumber,
      labels: input.labels,
      owner: input.owner,
      repo: input.repo,
      ...requestOption(input)
    });
  }

  async getIssue(
    input: GitHubIssueRepositoryInput & { issueNumber: number }
  ): Promise<RawGitHubIssue | null> {
    const octokit = this.octokit(input.token);
    try {
      const response = await octokit.rest.issues.get({
        issue_number: input.issueNumber,
        owner: input.owner,
        repo: input.repo
      });
      return response.data;
    } catch (error) {
      if (isOctokitNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async listBranchCommits(
    input: GitHubBranchCommitsInput
  ): Promise<RawGitHubCommit[] | null> {
    const octokit = this.octokit(input.token);
    try {
      const response = await octokit.rest.repos.listCommits({
        owner: input.owner,
        per_page: input.perPage ?? 1,
        repo: input.repo,
        sha: input.branch
      });
      return response.data;
    } catch (error) {
      if (isOctokitNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async listOpenIssues(
    input: GitHubIssueRepositoryInput
  ): Promise<RawGitHubIssue[]> {
    const octokit = this.octokit(input.token);
    const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
      owner: input.owner,
      per_page: 100,
      repo: input.repo,
      state: "open"
    });

    return issues;
  }

  async getIssueDependencies(
    input: GitHubIssueRepositoryInput & { issueNumbers: number[] }
  ): Promise<Map<number, RawGitHubIssueDependencies>> {
    const octokit = this.octokit(input.token);
    return fetchIssueDependencies(
      (query, variables) => octokit.graphql(query, variables),
      input
    );
  }

  async listIssues(input: GitHubIssuesListInput): Promise<RawGitHubIssue[]> {
    const octokit = this.octokit(input.token);
    return octokit.paginate(octokit.rest.issues.listForRepo, {
      owner: input.owner,
      per_page: 100,
      repo: input.repo,
      ...(input.since === undefined ? {} : { since: input.since }),
      state: input.state
    });
  }

  async listPullRequests(
    input: GitHubIssueRepositoryInput
  ): Promise<RawGitHubPullRequest[]> {
    const octokit = this.octokit(input.token);
    return octokit.paginate(octokit.rest.pulls.list, {
      owner: input.owner,
      per_page: 100,
      repo: input.repo,
      state: "open"
    });
  }

  async listPullRequestsForBranch(
    input: GitHubBranchPullRequestsInput
  ): Promise<RawGitHubPullRequest[]> {
    const octokit = this.octokit(input.token);
    const response = await octokit.rest.pulls.list({
      head: `${input.owner}:${input.branch}`,
      owner: input.owner,
      per_page: 100,
      repo: input.repo,
      state: "all"
    });
    return response.data;
  }

  async listPullRequestFiles(
    input: GitHubPullRequestInput
  ): Promise<RawGitHubPullRequestFile[]> {
    const octokit = this.octokit(input.token);
    return octokit.paginate(octokit.rest.pulls.listFiles, {
      owner: input.owner,
      per_page: 100,
      pull_number: input.pullNumber,
      repo: input.repo
    });
  }

  async getPullRequestFollowupState(
    input: GitHubPullRequestInput
  ): Promise<RawGitHubPullRequestFollowupState | null> {
    const octokit = this.octokit(input.token);
    return fetchPullRequestFollowupState(
      (query, variables) => octokit.graphql(query, variables),
      input
    );
  }

  async mergePullRequest(input: GitHubPullRequestMergeInput): Promise<void> {
    const octokit = this.octokit(input.token);
    await octokit.rest.pulls.merge({
      merge_method: input.method,
      owner: input.owner,
      pull_number: input.pullNumber,
      repo: input.repo,
      ...(input.expectedHeadSha === undefined
        ? {}
        : { sha: input.expectedHeadSha })
    });
  }

  async removeLabelsFromIssue(input: GitHubIssueLabelInput): Promise<void> {
    const octokit = this.octokit(input.token);
    const request = requestOption(input);
    for (const label of input.labels) {
      // Idempotent per label, inside the loop -- catching a 404 around
      // the whole multi-label call instead would abort on the first
      // absent label and never attempt the rest.
      await swallowLabelNotFound(() =>
        octokit.rest.issues.removeLabel({
          issue_number: input.issueNumber,
          name: label,
          owner: input.owner,
          repo: input.repo,
          ...request
        })
      );
    }
  }

  private octokit(token: string): Octokit {
    return new Octokit({
      auth: token,
      log: SILENT_OCTOKIT_LOG
    });
  }
}

export const DEFAULT_GITHUB_ISSUES_API = new OctokitGitHubIssuesApi();
export const DEFAULT_POLLING_INTERVAL_MS = 30_000;

type GraphqlPullRequestFollowupResponse = {
  repository?: {
    pullRequest?: GraphqlPullRequest | null;
  } | null;
};

type GraphqlReviewThreadConnection = {
  nodes?: Array<GraphqlReviewThread | null> | null;
  pageInfo?: {
    endCursor?: string | null;
    hasNextPage?: boolean | null;
  } | null;
};

type GraphqlPullRequest = {
  commits?: {
    nodes?: Array<{
      commit?: {
        statusCheckRollup?: {
          state?: string | null;
        } | null;
      } | null;
    } | null> | null;
  } | null;
  // GitHub declares this as GitObjectID!, but the executor result enters as
  // unknown and is validated at runtime before it becomes a successful PR
  // Follow-up observation.
  headRefOid?: string | null;
  isDraft?: boolean | null;
  mergeable?: string | null;
  merged?: boolean | null;
  number?: number | null;
  reviewDecision?: string | null;
  reviewThreads?: GraphqlReviewThreadConnection | null;
  state?: string | null;
  url?: string | null;
};

type GraphqlReviewThreadsPageResponse = {
  repository?: {
    pullRequest?: {
      reviewThreads?: GraphqlReviewThreadConnection | null;
    } | null;
  } | null;
};

type GraphqlReviewThread = {
  comments?: {
    nodes?: Array<GraphqlReviewComment | null> | null;
  } | null;
  id: string;
  isOutdated?: boolean | null;
  isResolved?: boolean | null;
  line?: number | null;
  path?: string | null;
};

type GraphqlReviewComment = {
  author?: {
    login?: string | null;
  } | null;
  body?: string | null;
  createdAt?: string | null;
  line?: number | null;
  path?: string | null;
  url?: string | null;
};

const REVIEW_THREAD_FIELDS = `
  pageInfo {
    hasNextPage
    endCursor
  }
  nodes {
    id
    isResolved
    isOutdated
    path
    line
    comments(first: 20) {
      nodes {
        author {
          login
        }
        body
        url
        createdAt
        path
        line
      }
    }
  }
`;

const PULL_REQUEST_FOLLOWUP_QUERY = `
  query PullRequestFollowup($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        number
        url
        state
        merged
        isDraft
        headRefOid
        mergeable
        reviewDecision
        reviewThreads(first: 50) {
          ${REVIEW_THREAD_FIELDS}
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
              }
            }
          }
        }
      }
    }
  }
`;

const PULL_REQUEST_REVIEW_THREADS_PAGE_QUERY = `
  query PullRequestReviewThreadsPage(
    $owner: String!
    $repo: String!
    $number: Int!
    $after: String!
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 50, after: $after) {
          ${REVIEW_THREAD_FIELDS}
        }
      }
    }
  }
`;

export type GraphqlExecutor = (
  query: string,
  variables: Record<string, unknown>
) => Promise<unknown>;

// A batch-fetched blocking issue's own state -- travels with the edge so
// `evaluateProjectEligibility` can decide "resolved" without a second fetch
// against the blocker's repo. See ADR (issue dependency gating).
export type RawGitHubIssueDependencyRef = {
  number: number;
  owner: string;
  repo: string;
  state: "CLOSED" | "OPEN";
  title: string;
};

export type RawGitHubIssueDependencies = {
  blockedBy: RawGitHubIssueDependencyRef[];
  // true when the issue has more `blockedBy` links than
  // ISSUE_DEPENDENCIES_MAX_BLOCKERS_PER_ISSUE -- the overflow is not
  // fetched, and callers must treat this as unresolved rather than silently
  // allowing dispatch on a partial view.
  truncated: boolean;
};

export async function fetchPullRequestFollowupState(
  executeGraphql: GraphqlExecutor,
  input: GitHubPullRequestInput
): Promise<RawGitHubPullRequestFollowupState | null> {
  const initial = (await executeGraphql(PULL_REQUEST_FOLLOWUP_QUERY, {
    number: input.pullNumber,
    owner: input.owner,
    repo: input.repo
  })) as GraphqlPullRequestFollowupResponse;

  const pullRequest = initial.repository?.pullRequest;
  if (pullRequest === null || pullRequest === undefined) {
    return null;
  }
  // GitHub's schema guarantees headRefOid even after the head ref is deleted.
  // Octokit also throws responses that contain GraphQL errors, including
  // partial responses, so reaching this branch means a custom executor
  // returned malformed data. Do not turn it into a successful observation:
  // mergeability/check/review state must stay bound to a known commit.
  if (
    typeof pullRequest.headRefOid !== "string" ||
    pullRequest.headRefOid.length === 0
  ) {
    throw new Error(
      "GitHub GraphQL pull request response is missing non-empty headRefOid"
    );
  }

  const allThreads = collectReviewThreads(pullRequest.reviewThreads);
  let pageInfo = pullRequest.reviewThreads?.pageInfo;

  while (
    pageInfo?.hasNextPage === true &&
    typeof pageInfo.endCursor === "string"
  ) {
    const page = (await executeGraphql(PULL_REQUEST_REVIEW_THREADS_PAGE_QUERY, {
      after: pageInfo.endCursor,
      number: input.pullNumber,
      owner: input.owner,
      repo: input.repo
    })) as GraphqlReviewThreadsPageResponse;

    const continuation = page.repository?.pullRequest?.reviewThreads;
    if (continuation === null || continuation === undefined) {
      break;
    }
    allThreads.push(...collectReviewThreads(continuation));
    pageInfo = continuation.pageInfo;
  }

  return {
    draft: pullRequest.isDraft ?? false,
    headSha: pullRequest.headRefOid,
    mergeable: normalizeMergeable(pullRequest.mergeable),
    merged: pullRequest.merged ?? false,
    number: pullRequest.number ?? input.pullNumber,
    reviewDecision: normalizeReviewDecision(pullRequest.reviewDecision),
    state: normalizePullRequestState(pullRequest.state),
    statusCheckRollupState: normalizeStatusCheckRollupState(
      pullRequest.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state
    ),
    unresolvedReviewThreads: allThreads
      .filter((thread) => thread.isResolved !== true)
      .map((thread) => ({
        comments: (thread.comments?.nodes ?? [])
          .filter(
            (comment): comment is GraphqlReviewComment => comment !== null
          )
          .map((comment) => ({
            author: comment.author?.login ?? null,
            body: comment.body ?? null,
            createdAt: comment.createdAt ?? null,
            line: comment.line ?? null,
            path: comment.path ?? null,
            url: comment.url ?? null
          })),
        id: thread.id,
        isOutdated: thread.isOutdated ?? null,
        isResolved: thread.isResolved ?? false,
        line: thread.line ?? null,
        path: thread.path ?? null
      })),
    url: pullRequest.url ?? ""
  };
}

// Capped rather than fully paginated: every `blockedBy` count observed
// while designing this feature was well under this, and a truncated
// (rather than fully-resolved-via-cursor) result is treated as unresolved
// by callers -- fail closed on the rare issue with more links than this,
// instead of adding pagination-following complexity for it.
const ISSUE_DEPENDENCIES_MAX_BLOCKERS_PER_ISSUE = 25;

type GraphqlIssueDependenciesBlocker = {
  number?: number | null;
  repository?: {
    name?: string | null;
    owner?: { login?: string | null } | null;
  } | null;
  state?: string | null;
  title?: string | null;
};

type GraphqlIssueDependenciesIssue = {
  blockedBy?: {
    nodes?: Array<GraphqlIssueDependenciesBlocker | null> | null;
    totalCount?: number | null;
  } | null;
  number?: number | null;
};

type GraphqlIssueDependenciesResponse = {
  repository?: Record<string, GraphqlIssueDependenciesIssue | null> | null;
};

function issueDependenciesAlias(issueNumber: number): string {
  return `i${issueNumber}`;
}

function buildIssueDependenciesQuery(issueNumbers: number[]): string {
  const fields = issueNumbers
    .map(
      (issueNumber) => `
        ${issueDependenciesAlias(issueNumber)}: issue(number: ${issueNumber}) {
          number
          blockedBy(first: ${ISSUE_DEPENDENCIES_MAX_BLOCKERS_PER_ISSUE}) {
            totalCount
            nodes {
              number
              title
              state
              repository {
                owner {
                  login
                }
                name
              }
            }
          }
        }`
    )
    .join("\n");
  return `
    query IssueDependencies($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        ${fields}
      }
    }
  `;
}

function normalizeIssueDependencyState(
  state: string | null | undefined
): "CLOSED" | "OPEN" {
  return state === "CLOSED" ? "CLOSED" : "OPEN";
}

// Keeps each GraphQL call well within GitHub's query-complexity budget
// (separate from the REST rate limit) -- validated at 20 issues/call while
// designing this feature. A project with more open issues than this in one
// poll cycle makes multiple calls rather than one unbounded query.
const ISSUE_DEPENDENCIES_BATCH_SIZE = 20;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function fetchIssueDependenciesBatch(
  executeGraphql: GraphqlExecutor,
  input: GitHubIssueRepositoryInput & { issueNumbers: number[] }
): Promise<Map<number, RawGitHubIssueDependencies>> {
  const result = new Map<number, RawGitHubIssueDependencies>();

  const response = (await executeGraphql(
    buildIssueDependenciesQuery(input.issueNumbers),
    { owner: input.owner, repo: input.repo }
  )) as GraphqlIssueDependenciesResponse;

  for (const issueNumber of input.issueNumbers) {
    const issue = response.repository?.[issueDependenciesAlias(issueNumber)];
    if (issue === null || issue === undefined) {
      // The issue was deleted/transferred/otherwise unresolvable between the
      // REST listOpenIssues call and this GraphQL fetch -- dependency state
      // is unknown, not confirmed clear, so record the same fail-closed
      // shape as a 25-blocker truncation (ADR 0081) rather than leaving no
      // entry, which every caller's `?? []`/`?? false` would read as clear.
      result.set(issueNumber, { blockedBy: [], truncated: true });
      continue;
    }
    const totalCount = issue.blockedBy?.totalCount ?? 0;
    const nodes = (issue.blockedBy?.nodes ?? []).filter(
      (node): node is GraphqlIssueDependenciesBlocker => node !== null
    );
    result.set(issue.number ?? issueNumber, {
      blockedBy: nodes.map((node) => ({
        number: node.number ?? 0,
        owner: node.repository?.owner?.login ?? "",
        repo: node.repository?.name ?? "",
        state: normalizeIssueDependencyState(node.state),
        title: node.title ?? ""
      })),
      truncated: totalCount > nodes.length
    });
  }

  return result;
}

export async function fetchIssueDependencies(
  executeGraphql: GraphqlExecutor,
  input: GitHubIssueRepositoryInput & { issueNumbers: number[] }
): Promise<Map<number, RawGitHubIssueDependencies>> {
  const result = new Map<number, RawGitHubIssueDependencies>();
  const batches = chunk(input.issueNumbers, ISSUE_DEPENDENCIES_BATCH_SIZE);
  for (const batch of batches) {
    const batchResult = await fetchIssueDependenciesBatch(executeGraphql, {
      ...input,
      issueNumbers: batch
    });
    for (const [issueNumber, dependencies] of batchResult) {
      result.set(issueNumber, dependencies);
    }
  }
  return result;
}

function collectReviewThreads(
  connection: GraphqlReviewThreadConnection | null | undefined
): GraphqlReviewThread[] {
  return (connection?.nodes ?? []).filter(
    (thread): thread is GraphqlReviewThread => thread !== null
  );
}

// Invoke optional GitHubIssuesApi methods through the property accessor so the
// implementation's `this` binding is preserved. Extracting `api.method` into a
// local variable strips `this` and breaks class-based implementations like
// OctokitGitHubIssuesApi (see issue-polling.ts:148).

export async function tryAddLabelsToIssue(
  api: GitHubIssuesApi,
  input: GitHubIssueLabelInput
): Promise<boolean> {
  if (api.addLabelsToIssue === undefined) {
    return false;
  }
  await api.addLabelsToIssue(input);
  return true;
}

export async function tryRemoveLabelsFromIssue(
  api: GitHubIssuesApi,
  input: GitHubIssueLabelInput
): Promise<boolean> {
  if (api.removeLabelsFromIssue === undefined) {
    return false;
  }
  await api.removeLabelsFromIssue(input);
  return true;
}

export async function tryGetIssue(
  api: GitHubIssuesApi,
  input: GitHubIssueRepositoryInput & { issueNumber: number }
): Promise<RawGitHubIssue | null | undefined> {
  if (api.getIssue === undefined) {
    return undefined;
  }
  return api.getIssue(input);
}

export async function tryGetIssueDependencies(
  api: GitHubIssuesApi,
  input: GitHubIssueRepositoryInput & { issueNumbers: number[] }
): Promise<Map<number, RawGitHubIssueDependencies> | undefined> {
  if (api.getIssueDependencies === undefined) {
    return undefined;
  }
  return api.getIssueDependencies(input);
}

export async function tryListBranchCommits(
  api: GitHubIssuesApi,
  input: GitHubBranchCommitsInput
): Promise<RawGitHubCommit[] | null | undefined> {
  if (api.listBranchCommits === undefined) {
    return undefined;
  }
  return api.listBranchCommits(input);
}

export async function tryListIssues(
  api: GitHubIssuesApi,
  input: GitHubIssuesListInput
): Promise<RawGitHubIssue[] | undefined> {
  if (api.listIssues === undefined) {
    return undefined;
  }
  return api.listIssues(input);
}

export async function tryListPullRequests(
  api: GitHubIssuesApi,
  input: GitHubIssueRepositoryInput
): Promise<RawGitHubPullRequest[] | undefined> {
  if (api.listPullRequests === undefined) {
    return undefined;
  }
  return api.listPullRequests(input);
}

export async function tryListPullRequestsForBranch(
  api: GitHubIssuesApi,
  input: GitHubBranchPullRequestsInput
): Promise<RawGitHubPullRequest[] | undefined> {
  if (api.listPullRequestsForBranch === undefined) {
    return undefined;
  }
  return api.listPullRequestsForBranch(input);
}

export async function tryListPullRequestFiles(
  api: GitHubIssuesApi,
  input: GitHubPullRequestInput
): Promise<RawGitHubPullRequestFile[] | undefined> {
  if (api.listPullRequestFiles === undefined) {
    return undefined;
  }
  return api.listPullRequestFiles(input);
}

export async function tryGetPullRequestFollowupState(
  api: GitHubIssuesApi,
  input: GitHubPullRequestInput
): Promise<RawGitHubPullRequestFollowupState | null | undefined> {
  if (api.getPullRequestFollowupState === undefined) {
    return undefined;
  }
  return api.getPullRequestFollowupState(input);
}

export async function tryMergePullRequest(
  api: GitHubIssuesApi,
  input: GitHubPullRequestMergeInput
): Promise<boolean> {
  if (api.mergePullRequest === undefined) {
    return false;
  }
  await api.mergePullRequest(input);
  return true;
}

export function emptyIssuePollStatus(): IssuePollStatus {
  return {
    candidateIssues: [],
    errors: [],
    filteredIssues: [],
    projects: []
  };
}

// Looks one (project, repository, issue) up in a poll snapshot across both
// bands. The candidate band alone is not enough for the reconciliation passes:
// an Issue carrying an operational label (`sym:claimed` above all) is filtered
// rather than a candidate, yet those passes are exactly the ones that need its
// current state and labels.
//
// `repository` is part of the key, not decoration. Duplicate Project
// declarations sharing a name are not rejected at load — `projectsByName`
// resolves them to the last match — while the poll loop walks the config
// array and so records an entry per declaration. Keyed on the name alone this
// would hand a caller the shadowed repository's labels while its writes went
// to the surviving declaration's tracker, which is exactly the provenance ADR
// 0077 requires be preserved under duplicate names.
export function findPolledIssueSnapshot(
  pollStatus: IssuePollStatus,
  projectName: string,
  repository: { owner: string; repo: string },
  issueNumber: number
): IssueSnapshot | undefined {
  for (const candidate of pollStatus.candidateIssues) {
    if (
      candidate.project === projectName &&
      candidate.issue.number === issueNumber &&
      sameIssueRepository(candidate.repository, repository)
    ) {
      return candidate.issue;
    }
  }
  for (const filtered of pollStatus.filteredIssues) {
    if (
      filtered.project === projectName &&
      filtered.issue.number === issueNumber &&
      sameIssueRepository(filtered.repository, repository)
    ) {
      return filtered.issue;
    }
  }
  return undefined;
}

// GitHub owners and repository names are case-insensitive, so a tracker
// written with different casing than the Run's stored origin is the same
// repository.
export function sameIssueRepository(
  left: { owner: string; repo: string },
  right: { owner: string; repo: string }
): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  );
}

export function replaceIssuePollStatus(
  target: IssuePollStatus,
  source: IssuePollStatus
): void {
  target.candidateIssues = source.candidateIssues;
  target.errors = source.errors;
  target.filteredIssues = source.filteredIssues;
  target.projects = source.projects;
}

// Like replaceIssuePollStatus, but for a tick that only polled a subset of
// configured projects (credential-scoped backoff excludes any project whose
// resolved token is currently backing off, see daemon.ts). Entries for a
// polled project come from `fresh`; entries for every other Project that is
// *currently enabled and configured* are carried over from `prior` untouched,
// mirroring pollProject's own "leave prior snapshot untouched" contract for a
// single failed project, just applied per-project across a partial poll
// instead of an all-or-nothing one. `configuredProjectKeys` is deliberately
// the full enabled configured set, not just the pollable/backed-off ones -- a
// project a config reload disabled, removed, or renamed is absent from both
// `polledProjectKeys` and `configuredProjectKeys`, so it's dropped here too
// instead of being carried over indefinitely. Candidate issues are narrower:
// only the last declaration selected for a Project name may reach dispatch,
// while repository-specific reports and filtered diagnostics remain visible.
export function mergeIssuePollStatus(
  prior: IssuePollStatus,
  fresh: IssuePollStatus,
  polledProjectKeys: ReadonlySet<string>,
  configuredProjectKeys: ReadonlySet<string>,
  selectedProjectKeysByName: ReadonlyMap<string, string>
): IssuePollStatus {
  const carryOver = (
    name: string,
    repository: GitHubRepositoryIdentity
  ): boolean => {
    const key = projectPollIdentityKey(name, repository);
    return !polledProjectKeys.has(key) && configuredProjectKeys.has(key);
  };

  const carriedOverProjects = prior.projects.filter((project) =>
    carryOver(project.name, project.repository)
  );
  // A carried-over project's own rate-limit error must survive the merge --
  // otherwise the first clean poll of any OTHER project on the same tick
  // wipes it from `errors` via a bare `fresh.errors` replace, even though
  // the backed-off project itself never got a chance to recover. See
  // ADR 0083.
  const carriedOverErrors = carriedOverProjects
    .map((project) => project.error)
    .filter((error): error is string => error !== undefined);
  const selectedCandidate = (candidate: ProjectIssueSnapshot): boolean =>
    selectedProjectKeysByName.get(candidate.project) ===
    projectPollIdentityKey(candidate.project, candidate.repository);

  return {
    candidateIssues: [
      ...prior.candidateIssues.filter((candidate) =>
        carryOver(candidate.project, candidate.repository)
      ),
      ...fresh.candidateIssues
    ].filter(selectedCandidate),
    errors: [...carriedOverErrors, ...fresh.errors],
    filteredIssues: [
      ...prior.filteredIssues.filter((filtered) =>
        carryOver(filtered.project, filtered.repository)
      ),
      ...fresh.filteredIssues
    ],
    projects: [...carriedOverProjects, ...fresh.projects]
  };
}

export function projectPollIdentityKey(
  name: string,
  repository: GitHubRepositoryIdentity
): string {
  return JSON.stringify([
    name,
    repository.owner.toLowerCase(),
    repository.repo.toLowerCase()
  ]);
}

export async function readConfiguredPollingIntervalMs(
  configPath: string
): Promise<number> {
  const config = await readPollingConfig(configPath, []);
  return config?.polling?.interval_ms ?? DEFAULT_POLLING_INTERVAL_MS;
}

export async function pollConfiguredGitHubIssues(
  options: PollConfiguredGitHubIssuesOptions
): Promise<IssuePollStatus> {
  const status = emptyIssuePollStatus();
  const config = await readPollingConfig(options.configPath, status.errors);

  if (config === undefined) {
    return status;
  }

  return pollConfiguredGitHubIssuesFromConfig({
    config,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.githubIssuesApi === undefined
      ? {}
      : { githubIssuesApi: options.githubIssuesApi }),
    initialErrors: status.errors
  });
}

export async function pollConfiguredGitHubIssuesFromConfig(options: {
  config: PollingServiceConfig;
  env?: NodeJS.ProcessEnv;
  githubIssuesApi?: GitHubIssuesApi;
  initialErrors?: string[];
}): Promise<IssuePollStatus> {
  const env = options.env ?? process.env;
  const githubIssuesApi = options.githubIssuesApi ?? DEFAULT_GITHUB_ISSUES_API;
  const status = emptyIssuePollStatus();
  status.errors.push(...(options.initialErrors ?? []));
  const tickRateLimitedTokens = new Set<string>();

  for (const project of options.config.projects) {
    if (project.disabled === true) {
      continue;
    }

    const token = resolveEnvBackedValue(project.tracker.token, env);
    if (token !== undefined && tickRateLimitedTokens.has(token)) {
      continue;
    }

    await pollProject(project, token, githubIssuesApi, status);
    const report = status.projects.at(-1);
    if (
      token !== undefined &&
      report?.error !== undefined &&
      isRateLimitError(report.error)
    ) {
      tickRateLimitedTokens.add(token);
    }
  }

  status.candidateIssues.sort(compareProjectIssues);
  status.filteredIssues.sort(compareProjectIssues);

  return status;
}

async function pollProject(
  project: PollingProjectConfig,
  token: string | undefined,
  githubIssuesApi: GitHubIssuesApi,
  status: IssuePollStatus
): Promise<void> {
  const lastPolledAt = new Date().toISOString();
  const repository: GitHubRepositoryIdentity = {
    owner: project.tracker.owner,
    repo: project.tracker.repo
  };
  const weight = project.weight ?? 1;
  if (token === undefined) {
    const variableName = envReferenceName(project.tracker.token);
    const error =
      variableName === undefined
        ? `projects.${project.name}.tracker.token must reference an environment variable like $GITHUB_TOKEN`
        : `projects.${project.name}.tracker.token references unset environment variable $${variableName}`;
    status.errors.push(error);
    status.projects.push({
      candidateIssues: 0,
      error,
      fetchedIssues: 0,
      filteredIssues: 0,
      lastPolledAt,
      name: project.name,
      ok: false,
      repository,
      weight
    });
    return;
  }

  let rawIssues: RawGitHubIssue[];
  try {
    rawIssues = await githubIssuesApi.listOpenIssues({
      owner: project.tracker.owner,
      repo: project.tracker.repo,
      token
    });
  } catch (error) {
    const message = `projects.${project.name}.tracker.repository ${project.tracker.owner}/${project.tracker.repo} issues could not be listed: ${errorMessage(error)}`;
    status.errors.push(message);
    status.projects.push({
      candidateIssues: 0,
      error: message,
      fetchedIssues: 0,
      filteredIssues: 0,
      lastPolledAt,
      name: project.name,
      ok: false,
      repository,
      weight
    });
    return;
  }

  const issues = rawIssues
    .filter((rawIssue) => rawIssue.pull_request === undefined)
    .map((rawIssue) => normalizeIssueSnapshot(rawIssue, project));

  let dependencies: Map<number, RawGitHubIssueDependencies> | undefined;
  try {
    dependencies = await tryGetIssueDependencies(githubIssuesApi, {
      issueNumbers: issues.map((issue) => issue.number),
      owner: project.tracker.owner,
      repo: project.tracker.repo,
      token
    });
  } catch (error) {
    // Fails the whole project poll rather than proceeding with a partial
    // eligibility picture -- same "leave prior snapshot untouched" handling
    // as a failed listOpenIssues call above, and consistent with treating
    // a truncated dependency fetch as unresolved rather than silently
    // ignoring the gap.
    const message = `projects.${project.name}.tracker.repository ${project.tracker.owner}/${project.tracker.repo} issue dependencies could not be checked: ${errorMessage(error)}`;
    status.errors.push(message);
    status.projects.push({
      candidateIssues: 0,
      error: message,
      fetchedIssues: 0,
      filteredIssues: 0,
      lastPolledAt,
      name: project.name,
      ok: false,
      repository,
      weight
    });
    return;
  }

  let fetchedIssues = 0;
  let candidateIssues = 0;
  let filteredIssues = 0;
  for (const issue of issues) {
    fetchedIssues += 1;
    const issueDependencies = dependencies?.get(issue.number);
    if (issueDependencies !== undefined) {
      issue.blockedBy = issueDependencies.blockedBy;
      issue.blockedByTruncated = issueDependencies.truncated;
    }
    const reasons = issueFilterReasons(issue, project);

    if (reasons.length === 0) {
      candidateIssues += 1;
      status.candidateIssues.push({
        issue,
        project: project.name,
        repository
      });
      continue;
    }

    filteredIssues += 1;
    status.filteredIssues.push({
      issue,
      project: project.name,
      reasons,
      repository
    });
  }

  status.projects.push({
    candidateIssues,
    fetchedIssues,
    filteredIssues,
    lastPolledAt,
    name: project.name,
    ok: true,
    repository,
    weight
  });
}

async function readPollingConfig(
  configPath: string,
  errors: string[]
): Promise<PollingServiceConfig | undefined> {
  let contents: string;

  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    errors.push(
      `service config not found at ${configPath}: ${errorMessage(error)}`
    );
    return undefined;
  }

  let rawConfig: unknown;
  try {
    rawConfig = parse(contents) ?? {};
  } catch (error) {
    errors.push(`service config could not be parsed: ${errorMessage(error)}`);
    return undefined;
  }

  const parsed = pollingServiceConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    errors.push(...parsed.error.issues.map(formatZodIssue));
    return undefined;
  }

  const projects: PollingProjectConfig[] = [];
  parsed.data.projects.forEach((rawProject, index) => {
    // Routine Hosts are never polled for issues (ADR 0062) and lack the
    // dispatch-only fields pollingProjectSchema requires — skip them here
    // rather than surfacing a spurious "tracker required" error, mirroring
    // reload.ts's own exclusion of hosts from `snapshot.polling.projects`.
    if (isRoutineHostProject(rawProject)) {
      return;
    }

    const parsedProject = pollingProjectSchema.safeParse(rawProject);
    if (parsedProject.success) {
      projects.push(parsedProject.data);
      return;
    }

    errors.push(
      ...parsedProject.error.issues.map((issue) =>
        formatZodIssueWithPrefix(issue, ["projects", String(index)])
      )
    );
  });

  const config: PollingServiceConfig = {
    projects
  };
  if (parsed.data.polling !== undefined) {
    config.polling = parsed.data.polling;
  }

  return config;
}

// Best-effort, display-only signal for the dependency graph's epic
// clustering (see docs/adr, issue dependency gating) -- never used for
// gating, unlike blockedBy. An issue with no parseable heading (or none
// at all) just renders ungrouped in the graph; that's expected, not an
// error. Matches the real "## Parent\n\n#N" convention already in use
// across this repo's issues, including trailing parenthetical text after
// the number (e.g. "#199 (planning parent, kept open)").
const PARENT_HEADING_REASON = /^##\s*Parent\s*\n+\s*#(\d+)/im;

export function parseParentIssueNumber(body: string): number | undefined {
  const match = PARENT_HEADING_REASON.exec(body);
  if (match?.[1] === undefined) {
    return undefined;
  }
  return Number.parseInt(match[1], 10);
}

function normalizeIssueSnapshot(
  rawIssue: RawGitHubIssue,
  project: PollingProjectConfig
): IssueSnapshot {
  const labels = normalizeLabels(rawIssue.labels ?? []);
  const body = rawIssue.body ?? "";
  const parentIssueNumber = parseParentIssueNumber(body);

  return {
    // Populated by a separate fetchIssueDependencies GraphQL call and
    // merged in by the poll loop, not derived here -- normalizeIssueSnapshot
    // only ever sees the REST issue payload, which has no blockedBy field.
    blockedBy: [],
    blockedByTruncated: false,
    body,
    created_at: rawIssue.created_at ?? "",
    id: rawIssue.id ?? 0,
    labels,
    number: rawIssue.number ?? 0,
    ...(parentIssueNumber === undefined ? {} : { parentIssueNumber }),
    priority: priorityForLabels(labels, project.priority),
    state: rawIssue.state ?? "open",
    title: rawIssue.title ?? "",
    updated_at: rawIssue.updated_at ?? "",
    url: rawIssue.html_url ?? rawIssue.url ?? ""
  };
}

function issueFilterReasons(
  issue: IssueSnapshot,
  project: PollingProjectConfig
): string[] {
  return evaluateProjectEligibility(issue, project).reasons;
}

export function issueStateReasons(
  issue: IssueSnapshot,
  project: PollingProjectConfig
): string[] {
  return !project.issue_filters.states.includes("open") ||
    issue.state !== "open"
    ? [`state ${issue.state} is not eligible`]
    : [];
}

export function evaluateProjectEligibility(
  issue: IssueSnapshot,
  project: PollingProjectConfig,
  options: { ignoreOperationalLabels?: boolean } = {}
): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [...issueStateReasons(issue, project)];
  const labels = new Set(issue.labels);

  for (const requiredLabel of project.issue_filters.labels_all) {
    if (!labels.has(requiredLabel)) {
      reasons.push(`missing required label ${requiredLabel}`);
    }
  }

  for (const excludedLabel of project.issue_filters.labels_none) {
    if (labels.has(excludedLabel)) {
      reasons.push(`has excluded label ${excludedLabel}`);
    }
  }

  if (options.ignoreOperationalLabels !== true) {
    for (const operationalLabel of REQUIRED_OPERATIONAL_LABELS) {
      if (labels.has(operationalLabel)) {
        reasons.push(`has operational label ${operationalLabel}`);
      }
    }
  }

  // Native GitHub blockedBy links, not free-text-parsed -- see docs/adr
  // (issue dependency gating). Unconditional (not gated behind
  // ignoreOperationalLabels): an unresolved dependency isn't an
  // orchestrator-owned operational label, it's the same kind of hard
  // ineligibility as a missing required label.
  for (const blocker of issue.blockedBy ?? []) {
    if (blocker.state !== "CLOSED") {
      reasons.push(
        `blocked by open dependency ${issueDependencyRef(blocker, project)}`
      );
    }
  }
  if (issue.blockedByTruncated === true) {
    reasons.push(
      "has more dependency links than could be checked - treat as unresolved until reviewed"
    );
  }

  return {
    eligible: reasons.length === 0,
    reasons
  };
}

// A same-repo blocker reads as a bare `#N` (matches how every other
// in-repo issue reference already reads across this codebase's UI and
// logs); a cross-repo blocker is disambiguated as `owner/repo#N` so it
// can't be confused with a local issue number.
function issueDependencyRef(
  blocker: RawGitHubIssueDependencyRef,
  project: PollingProjectConfig
): string {
  const sameRepo =
    project.tracker.kind === "github" &&
    blocker.owner === project.tracker.owner &&
    blocker.repo === project.tracker.repo;
  return sameRepo
    ? `#${blocker.number}`
    : `${blocker.owner}/${blocker.repo}#${blocker.number}`;
}

export async function loadPollingProjectsByName(
  configPath: string
): Promise<Map<string, PollingProjectConfig>> {
  const errors: string[] = [];
  const config = await readPollingConfig(configPath, errors);
  if (config === undefined) {
    throw new Error(
      errors.length === 0
        ? `failed to load polling config at ${configPath}`
        : errors.join("\n")
    );
  }

  return pollingProjectsByName(config.projects);
}

// Duplicate project names resolve to the *last* match, matching
// RuntimeConfigReloader.projectsByName() (src/reload.ts): `Map#set` keeps
// overwriting as later entries are visited, so the final value wins.
function pollingProjectsByName(
  projects: PollingProjectConfig[]
): Map<string, PollingProjectConfig> {
  const map = new Map<string, PollingProjectConfig>();
  for (const project of projects) {
    map.set(project.name, project);
  }
  return map;
}

function compareProjectIssues(
  left: ProjectIssueSnapshot,
  right: ProjectIssueSnapshot
): number {
  return (
    left.issue.priority - right.issue.priority ||
    left.issue.created_at.localeCompare(right.issue.created_at) ||
    left.issue.number - right.issue.number
  );
}

export function envReferenceName(input: string): string | undefined {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(input);
  return match?.[1];
}

export function resolveEnvBackedValue(
  input: string,
  env: NodeJS.ProcessEnv
): string | undefined {
  const variableName = envReferenceName(input);
  if (variableName === undefined) {
    return undefined;
  }

  const value = env[variableName];
  return value === undefined || value.length === 0 ? undefined : value;
}

function normalizeMergeable(
  value: string | null | undefined
): RawGitHubPullRequestFollowupState["mergeable"] {
  switch (value) {
    case "CONFLICTING":
    case "MERGEABLE":
    case "UNKNOWN":
      return value;
    default:
      return null;
  }
}

function normalizeReviewDecision(
  value: string | null | undefined
): RawGitHubPullRequestFollowupState["reviewDecision"] {
  switch (value) {
    case "APPROVED":
    case "CHANGES_REQUESTED":
    case "REVIEW_REQUIRED":
      return value;
    default:
      return null;
  }
}

function normalizeStatusCheckRollupState(
  value: string | null | undefined
): RawGitHubPullRequestFollowupState["statusCheckRollupState"] {
  switch (value) {
    case "ERROR":
    case "EXPECTED":
    case "FAILURE":
    case "PENDING":
    case "SUCCESS":
      return value;
    default:
      return null;
  }
}

function normalizePullRequestState(
  value: string | null | undefined
): RawGitHubPullRequestFollowupState["state"] {
  switch (value) {
    case "CLOSED":
    case "MERGED":
    case "OPEN":
      return value;
    default:
      return "UNKNOWN";
  }
}

function formatZodIssue(issue: z.ZodIssue): string {
  const location =
    issue.path.length === 0 ? "service config" : issue.path.join(".");
  return `${location}: ${issue.message}`;
}

function formatZodIssueWithPrefix(issue: z.ZodIssue, prefix: string[]): string {
  const location = [...prefix, ...issue.path].join(".");
  return `${location}: ${issue.message}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOctokitNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 404
  );
}

// Matches both GitHub's primary hourly rate limit ("API rate limit ...
// exceeded") and its secondary/abuse-detection limit (rapid repeated
// requests) -- REST and GraphQL errors surface these as message text rather
// than a shared status/type field, so callers that only see the rendered
// poll-failure string (e.g. daemon.ts's IssuePollStatus.errors) need a
// message-based check rather than an error-shape check like
// isOctokitNotFound above.
const RATE_LIMIT_MESSAGE_PATTERN = /rate limit|abuse detection/i;

export function isRateLimitError(message: string): boolean {
  return RATE_LIMIT_MESSAGE_PATTERN.test(message);
}

// A fixed window rather than exponential backoff: GitHub's primary rate
// limit resets on a fixed hourly clock that doubling can't influence either
// way. The window exists to stop the poller from flailing against an
// already-exhausted budget (and tripping the secondary/abuse limit in the
// process), not to time the primary reset.
export const GITHUB_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

export function backoffUntil(nowMs: number): number {
  return nowMs + GITHUB_RATE_LIMIT_BACKOFF_MS;
}

// Maps each rate-limited project's poll report back to the resolved GitHub
// tokens declared for its Project name and repository identity, so a caller
// (daemon.ts) can back off polling
// scoped to that credential instead of every configured project -- SPEC.md
// §6 permits each tracker to reference an independent $VAR_NAME, and GitHub
// tracks rate-limit budgets per token, not per Symphonika deployment.
// Defensive reload can retain indistinguishable duplicate declarations that
// reference different tokens. Reports carry no declaration provenance, so
// every matching resolved token is conservatively included.
// Structurally typed over `reports` so the same function serves both
// IssuePollStatus.projects and PullRequestPollStatus.projects. Deliberately
// does not gate on `report.ok`: a PR-poll report can be `ok: true` (the PR
// list itself was fetched fine) while still carrying a rate-limit error from
// a single PR's enrichment call (see pull-request-polling.ts's buildSnapshot
// / ADR 0083) -- that case must still engage backoff.
export function rateLimitedTokens(
  reports: ReadonlyArray<{
    error?: string;
    name: string;
    ok: boolean;
    repository: GitHubRepositoryIdentity;
  }>,
  projects: readonly PollingProjectConfig[],
  env: NodeJS.ProcessEnv
): Set<string> {
  const projectsByIdentity = new Map<string, PollingProjectConfig[]>();
  for (const project of projects) {
    const key = projectPollIdentityKey(project.name, project.tracker);
    const declarations = projectsByIdentity.get(key) ?? [];
    declarations.push(project);
    projectsByIdentity.set(key, declarations);
  }
  const tokens = new Set<string>();
  for (const report of reports) {
    if (report.error === undefined) {
      continue;
    }
    if (!isRateLimitError(report.error)) {
      continue;
    }
    const matchingProjects = projectsByIdentity.get(
      projectPollIdentityKey(report.name, report.repository)
    );
    if (matchingProjects === undefined) {
      continue;
    }
    for (const project of matchingProjects) {
      const token = resolveEnvBackedValue(project.tracker.token, env);
      if (token !== undefined) {
        tokens.add(token);
      }
    }
  }
  return tokens;
}

// Swallows a 404 from a single label-removal attempt as success --
// idempotent by design: if the label is already absent, that isn't a
// failure worth surfacing. GitHub's remove-label endpoint also 404s when
// the issue or repo itself is missing/inaccessible, which is a real
// failure and must propagate -- so this only swallows the 404 whose
// message identifies an absent label ("Label does not exist"), not a
// generic "Not Found". Exported so a caller can wrap each iteration of a
// multi-step operation individually (see
// OctokitGitHubIssuesApi.removeLabelsFromIssue): catching around a whole
// loop instead would abort on the first 404 and never attempt the rest.
export async function swallowLabelNotFound(
  attempt: () => Promise<unknown>
): Promise<void> {
  try {
    await attempt();
  } catch (error) {
    if (
      !isOctokitNotFound(error) ||
      !errorMessage(error).toLowerCase().includes("label does not exist")
    ) {
      throw error;
    }
  }
}
