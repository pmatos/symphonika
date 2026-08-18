import { readFile } from "node:fs/promises";
import { Octokit } from "@octokit/rest";
import { parse } from "yaml";
import { z } from "zod";

import { REQUIRED_OPERATIONAL_LABELS } from "./operational-labels.js";

export type GitHubIssueRepositoryInput = {
  owner: string;
  repo: string;
  token: string;
};

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
  weight?: number;
  error?: string;
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
      repo: input.repo
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
    for (const label of input.labels) {
      // Idempotent per label, inside the loop -- catching a 404 around
      // the whole multi-label call instead would abort on the first
      // absent label and never attempt the rest.
      await swallowLabelNotFound(() =>
        octokit.rest.issues.removeLabel({
          issue_number: input.issueNumber,
          name: label,
          owner: input.owner,
          repo: input.repo
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
    headSha: pullRequest.headRefOid ?? "",
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

async function tryGetIssueDependencies(
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

export function replaceIssuePollStatus(
  target: IssuePollStatus,
  source: IssuePollStatus
): void {
  target.candidateIssues = source.candidateIssues;
  target.errors = source.errors;
  target.filteredIssues = source.filteredIssues;
  target.projects = source.projects;
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

  for (const project of options.config.projects) {
    if (project.disabled === true) {
      continue;
    }

    await pollProject(project, env, githubIssuesApi, status);
  }

  status.candidateIssues.sort(compareProjectIssues);
  status.filteredIssues.sort(compareProjectIssues);

  return status;
}

async function pollProject(
  project: PollingProjectConfig,
  env: NodeJS.ProcessEnv,
  githubIssuesApi: GitHubIssuesApi,
  status: IssuePollStatus
): Promise<void> {
  const lastPolledAt = new Date().toISOString();
  const weight = project.weight ?? 1;
  const token = resolveEnvBackedValue(project.tracker.token, env);
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
        project: project.name
      });
      continue;
    }

    filteredIssues += 1;
    status.filteredIssues.push({
      issue,
      project: project.name,
      reasons
    });
  }

  status.projects.push({
    candidateIssues,
    fetchedIssues,
    filteredIssues,
    lastPolledAt,
    name: project.name,
    ok: true,
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
    priority: priorityForLabels(labels, project),
    state: rawIssue.state ?? "open",
    title: rawIssue.title ?? "",
    updated_at: rawIssue.updated_at ?? "",
    url: rawIssue.html_url ?? rawIssue.url ?? ""
  };
}

export function normalizeLabels(labels: unknown[]): string[] {
  const normalized: string[] = [];

  for (const label of labels) {
    if (typeof label === "string") {
      normalized.push(label);
      continue;
    }

    if (isRecord(label) && typeof label.name === "string") {
      normalized.push(label.name);
    }
  }

  return normalized;
}

function priorityForLabels(
  labels: string[],
  project: PollingProjectConfig
): number {
  const priorities = labels.flatMap((label) => {
    const priority = project.priority.labels[label];
    return priority === undefined ? [] : [priority];
  });

  return priorities.length === 0
    ? project.priority.default
    : Math.min(...priorities);
}

function issueFilterReasons(
  issue: IssueSnapshot,
  project: PollingProjectConfig
): string[] {
  return evaluateProjectEligibility(issue, project).reasons;
}

export function evaluateProjectEligibility(
  issue: IssueSnapshot,
  project: PollingProjectConfig,
  options: { ignoreOperationalLabels?: boolean } = {}
): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const labels = new Set(issue.labels);

  if (
    !project.issue_filters.states.includes("open") ||
    issue.state !== "open"
  ) {
    reasons.push(`state ${issue.state} is not eligible`);
  }

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

  const map = new Map<string, PollingProjectConfig>();
  for (const project of config.projects) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOctokitNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 404
  );
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
