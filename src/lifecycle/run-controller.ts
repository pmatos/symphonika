import { randomUUID } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";

import type {
  GitHubIssueLabelInput,
  GitHubIssueRepositoryInput,
  GitHubIssuesApi,
  IssuePollStatus,
  IssueSnapshot,
  PollingProjectConfig,
  RawGitHubPullRequestReviewThread
} from "../issue-polling.js";
import {
  evaluateProjectEligibility,
  tryGetIssue,
  tryGetPullRequestFollowupState,
  tryMergePullRequest
} from "../issue-polling.js";
import {
  DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY,
  pullRequestReadyToMerge,
  type PullRequestFollowupPolicy
} from "../pull-request-followup.js";
import { interpretPullRequest } from "../pull-request-state.js";
import { projectPullRequestSignals } from "./pr-signal-projection.js";
import type {
  AgentProvider,
  AgentProviderName,
  AgentProviderRegistry,
  NormalizedProviderEvent,
  ProviderEvent
} from "../provider.js";
import type { CancelReason, RunState, RunStore } from "../run-store.js";
import type {
  PreparedIssueWorkspace,
  PrepareIssueWorkspaceInput
} from "../workspace.js";
import { prepareIssueWorkspace as defaultPrepareIssueWorkspace } from "../workspace.js";
import { readFile } from "node:fs/promises";

import type { WorkflowReference } from "../config-schemas.js";
import {
  expandWorkflowDefinition,
  parseWorkflowContract,
  persistRunEvidence,
  renderAutonomousPrompt
} from "../workflow.js";
import type {
  ExpandedWorkflow,
  ExpandedWorkflowState,
  WorkflowAction,
  WorkflowPredicateMap
} from "../workflow.js";

import {
  ActiveRunRegistry,
  CANCEL_REASONS,
  computeRetryDelayMs,
  LIFECYCLE_POLICY,
  type LifecyclePolicy
} from "./active-runs.js";
import { classifyCapReachedOutcome } from "./cap-reached-context.js";
import { classifyFailure, type ClassifiedTerminal } from "./classify-failure.js";
import {
  decideNextStep,
  findWorkflowState
} from "./state-machine-dispatch.js";
import { buildCapReachedReason } from "./terminal-reason.js";

export type WorkflowSnapshot = {
  body: string;
  contentHash: string;
  expandedWorkflow: ExpandedWorkflow;
  format: WorkflowReference["format"];
  path: string;
};

type LoadedWorkflow = {
  body: string;
  contentHash: string;
  errors: string[];
  expandedWorkflow: ExpandedWorkflow;
  format: WorkflowReference["format"];
  path: string;
};

export type RunControllerProjectConfig = PollingProjectConfig & {
  workflow: WorkflowReference | WorkflowSnapshot;
  workspace: {
    git: {
      base_branch: string;
      remote: string;
    };
    root: string;
  };
};

export type RunControllerProvidersConfig = {
  codex: { command: string };
  claude: { command: string };
};

export type ScheduleHandler = (input: {
  delayMs: number;
  fire: () => Promise<void>;
  issueNumber: number;
  kind: "retry" | "continuation" | "state_advance" | "wait_park";
  projectName: string;
  runId: string;
}) => void;

export type RunControllerOptions = {
  activeRuns: ActiveRunRegistry;
  agentProviders: AgentProviderRegistry;
  configDir: string;
  createRunId?: () => string;
  env?: NodeJS.ProcessEnv;
  githubIssuesApi: GitHubIssuesApi;
  lifecyclePolicy?: LifecyclePolicy;
  logger?: Logger;
  prepareIssueWorkspace?: (
    input: PrepareIssueWorkspaceInput
  ) => Promise<PreparedIssueWorkspace>;
  projectsLoader: () => Promise<Map<string, RunControllerProjectConfig>>;
  providersLoader: () => Promise<RunControllerProvidersConfig>;
  pullRequestPolicyLoader?: () => Promise<PullRequestFollowupPolicy>;
  runStore: RunStore;
  schedule: ScheduleHandler;
  stateRoot: string;
};

export type DispatchOneFreshResult =
  | { dispatched: false; reason: string }
  | { dispatched: true; runId: string };

export type ReviewFollowupContext = {
  headSha: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  reviewDecision: string | null;
  statusCheckRollupState: string | null;
  unresolvedThreads: RawGitHubPullRequestReviewThread[];
};

type DispatchTarget = {
  candidate: { issue: IssueSnapshot; project: string };
  project: RunControllerProjectConfig;
  provider: AgentProvider;
  schedulerWeights: Array<{
    currentWeight: number;
    projectName: string;
    weight: number;
  }>;
};

type LabelWritingGitHubIssuesApi = GitHubIssuesApi & {
  addLabelsToIssue: (input: GitHubIssueLabelInput) => Promise<void>;
  removeLabelsFromIssue: (input: GitHubIssueLabelInput) => Promise<void>;
};

type RunRuntime = {
  attemptId: string;
  attemptNumber: number;
  events: NormalizedProviderEvent[];
};

type StartedAttempt = {
  evidence: AttemptEvidence;
  prepared: PreparedIssueWorkspace;
  prompt: string;
  promptPath: string;
};

type AttemptEvidence = {
  branchName: string;
  branchRef: string;
  issueSnapshotPath: string;
  metadataPath: string;
  normalizedLogPath: string;
  promptPath: string;
  rawLogPath: string;
  workflowGraphPath: string;
  workspacePath: string;
};

type ApplyLabelsInput = {
  cancelReason?: CancelReason;
  issueNumber: number;
  outcome: ClassifiedTerminal;
  repository: GitHubIssueRepositoryInput;
  willRetry: boolean;
};

type RetryPayload = {
  attemptNumber: number;
  extraInstructions?: string;
  issue: IssueSnapshot;
  projectName: string;
  // Carry the provider chosen for this run (which may be a per-state override
  // from a raw FSM action.provider) so the retry executes the same provider
  // and command, not the project default. Without this, a state declaring
  // action.provider: claude in a project whose default is codex would retry
  // on codex and produce inconsistent prompts/evidence.
  providerCommand: string;
  providerName: AgentProviderName;
  // When false (raw FSM mid-walk runs), executeRetry skips the labels_all /
  // labels_none re-check so a transient provider failure stays recoverable
  // even when labels drift during the FSM walk. CLOSED_ISSUE still cancels.
  // See ADR 0046.
  respectsIssueLabels?: boolean;
  runId: string;
};

type ContinuationPayload = {
  issue: IssueSnapshot;
  parentRunId: string;
  projectName: string;
};

type StateAdvancePayload = {
  issue: IssueSnapshot;
  parentRunId: string;
  projectName: string;
  toStateId: string;
};

type WorkflowOutcomeResult = {
  advancedToState: string | null;
  advancedToTerminal: boolean;
  blocked: boolean;
  parkAsWait?: boolean;
  terminalLabel?: "success" | "failure" | "blocked";
  waitingRunId?: string;
};

type WaitParkPayload = {
  waitingRunId: string;
};

export class RunController {
  private readonly activeRuns: ActiveRunRegistry;
  private readonly agentProviders: AgentProviderRegistry;
  private readonly configDir: string;
  private readonly createRunId: () => string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly githubIssuesApi: GitHubIssuesApi;
  private readonly lifecyclePolicy: LifecyclePolicy;
  private readonly logger?: Logger;
  private readonly prepareIssueWorkspace: (
    input: PrepareIssueWorkspaceInput
  ) => Promise<PreparedIssueWorkspace>;
  private readonly projectsLoader: () => Promise<
    Map<string, RunControllerProjectConfig>
  >;
  private readonly providersLoader: () => Promise<RunControllerProvidersConfig>;
  private readonly pullRequestPolicyLoader: () => Promise<PullRequestFollowupPolicy>;
  private readonly runStore: RunStore;
  private readonly schedule: ScheduleHandler;
  private readonly stateRoot: string;

  constructor(options: RunControllerOptions) {
    this.activeRuns = options.activeRuns;
    this.agentProviders = options.agentProviders;
    this.configDir = options.configDir;
    this.createRunId = options.createRunId ?? randomUUID;
    this.env = options.env ?? process.env;
    this.githubIssuesApi = options.githubIssuesApi;
    this.lifecyclePolicy = options.lifecyclePolicy ?? LIFECYCLE_POLICY;
    if (options.logger !== undefined) {
      this.logger = options.logger;
    }
    this.prepareIssueWorkspace =
      options.prepareIssueWorkspace ?? defaultPrepareIssueWorkspace;
    this.projectsLoader = options.projectsLoader;
    this.providersLoader = options.providersLoader;
    this.pullRequestPolicyLoader =
      options.pullRequestPolicyLoader ??
      ((): Promise<PullRequestFollowupPolicy> =>
        Promise.resolve(DEFAULT_PULL_REQUEST_FOLLOWUP_POLICY));
    this.runStore = options.runStore;
    this.schedule = options.schedule;
    this.stateRoot = options.stateRoot;
  }

  async dispatchOneFresh(
    pollStatus: IssuePollStatus
  ): Promise<DispatchOneFreshResult> {
    // Snapshot candidates before any await so a concurrent poll cannot wipe them.
    const candidates = pollStatus.candidateIssues.slice();
    const projects = await this.projectsLoader();
    const providersConfig = await this.providersLoader();
    const target = this.pickTargetFromCandidates(candidates, projects);
    if (target === undefined) {
      return {
        dispatched: false,
        reason: "no eligible issue has a registered provider"
      };
    }

    if (!isLabelWritingGitHubIssuesApi(this.githubIssuesApi)) {
      return {
        dispatched: false,
        reason: "GitHub tracker does not support operational label writes"
      };
    }

    const token = resolveTokenFromEnv(target.project.tracker.token, this.env);
    if (token === undefined) {
      return {
        dispatched: false,
        reason: `projects.${target.project.name}.tracker.token is not available`
      };
    }

    const runId = this.createRunId();
    const repository = {
      owner: target.project.tracker.owner,
      repo: target.project.tracker.repo,
      token
    };

    // Honor action.provider on the initial raw-FSM state, matching the
    // per-state routing executeStateAdvance applies to subsequent advances.
    // runAttemptLifecycle reloads the workflow downstream regardless, so
    // loading it once here pays only on actually-selected dispatches. Falls
    // back to the project default for contract workflows or when the
    // initial agent action declares no provider.
    let initialAction: WorkflowAction | undefined;
    try {
      const loaded = await this.loadWorkflow(target.project.workflow);
      if (
        loaded.errors.length === 0 &&
        loaded.expandedWorkflow.source.kind === "raw_fsm"
      ) {
        const initialState = findWorkflowState(
          loaded.expandedWorkflow,
          loaded.expandedWorkflow.initial
        );
        if (initialState?.action !== undefined) {
          initialAction = initialState.action;
        }
      }
    } catch {
      // Workflow load failure falls back to the project default; the same
      // error surfaces from runAttemptLifecycle's reload during the attempt.
    }

    const providerName =
      initialAction?.kind === "agent" && initialAction.provider !== undefined
        ? initialAction.provider
        : target.project.agent.provider;
    const providerCommand = (
      providersConfig as Partial<RunControllerProvidersConfig>
    )[providerName]?.command;

    if (providerCommand === undefined || providerCommand.trim().length === 0) {
      await this.failFreshDispatchBeforeProvider({
        issue: target.candidate.issue,
        project: target.project,
        providerCommand: providerCommand ?? "",
        providerName,
        reason: `provider_command_missing: ${providerName}`,
        repository,
        runId
      });
      return { dispatched: true, runId };
    }

    const provider = this.agentProviders[providerName];
    if (provider === undefined) {
      await this.failFreshDispatchBeforeProvider({
        issue: target.candidate.issue,
        project: target.project,
        providerCommand,
        providerName,
        reason: `provider_not_registered: ${providerName}`,
        repository,
        runId
      });
      return { dispatched: true, runId };
    }

    await this.runFreshLifecycle({
      attemptNumber: 1,
      isContinuation: false,
      issue: target.candidate.issue,
      parentRunId: null,
      project: target.project,
      provider,
      providerCommand,
      providerName,
      repository,
      runId,
      schedulerWeights: target.schedulerWeights
    });

    return { dispatched: true, runId };
  }

  private async failFreshDispatchBeforeProvider(input: {
    issue: IssueSnapshot;
    project: RunControllerProjectConfig;
    providerCommand: string;
    providerName: AgentProviderName;
    reason: string;
    repository: GitHubIssueRepositoryInput;
    runId: string;
  }): Promise<void> {
    await this.bestEffort(
      () =>
        (this.githubIssuesApi as LabelWritingGitHubIssuesApi).addLabelsToIssue({
          ...input.repository,
          issueNumber: input.issue.number,
          labels: ["sym:claimed"]
        }),
      {
        issueNumber: input.issue.number,
        label: "sym:claimed",
        operation: "addLabel",
        phase: "fresh-dispatch-provider-resolution",
        project: input.project.name,
        runId: input.runId
      }
    );
    this.runStore.createRun({
      id: input.runId,
      issue: input.issue,
      projectName: input.project.name,
      providerCommand: input.providerCommand,
      providerName: input.providerName
    });
    this.runStore.recordTerminalReason(
      input.runId,
      input.reason,
      "deterministic"
    );
    this.runStore.updateRunState(input.runId, "failed");
    this.logger?.warn(
      {
        issueNumber: input.issue.number,
        project: input.project.name,
        provider: input.providerName,
        reason: input.reason,
        runId: input.runId
      },
      "symphonika fresh dispatch failed before provider launch"
    );
    await this.applyTerminalLabels({
      issueNumber: input.issue.number,
      outcome: {
        classification: "deterministic",
        kind: "failed",
        reason: input.reason
      },
      repository: input.repository,
      willRetry: false
    });
  }

  async executeRetry(payload: RetryPayload): Promise<void> {
    const projects = await this.projectsLoader();
    const project = projects.get(payload.projectName);
    if (project === undefined || project.disabled === true) {
      this.logger?.warn(
        { projectName: payload.projectName, runId: payload.runId },
        "symphonika retry dropped: project disabled or removed"
      );
      return;
    }

    const provider = this.agentProviders[payload.providerName];
    if (provider === undefined) {
      this.logger?.warn(
        {
          projectName: payload.projectName,
          providerName: payload.providerName,
          runId: payload.runId
        },
        "symphonika retry dropped: provider missing"
      );
      return;
    }

    const providerCommand = payload.providerCommand;

    if (!isLabelWritingGitHubIssuesApi(this.githubIssuesApi)) {
      this.logger?.warn(
        { runId: payload.runId },
        "symphonika retry dropped: github tracker missing label writes"
      );
      return;
    }

    const token = resolveTokenFromEnv(project.tracker.token, this.env);
    if (token === undefined) {
      this.logger?.warn(
        { runId: payload.runId },
        "symphonika retry dropped: token not available"
      );
      return;
    }
    const repository = {
      owner: project.tracker.owner,
      repo: project.tracker.repo,
      token
    };

    // Re-validate eligibility before re-asserting sym:claimed and starting the
    // attempt. During the [10s, 30s, 2m] retry backoff the issue may have been
    // closed or lost required labels; reconcile cannot help here because a
    // scheduled retry is not present in activeRuns.list() during the window.
    const refreshed = await this.refreshIssue({
      project,
      issueNumber: payload.issue.number,
      repository
    });
    if (refreshed === undefined) {
      this.logger?.warn(
        { runId: payload.runId, projectName: payload.projectName },
        "symphonika retry dropped: issue refresh unavailable"
      );
      return;
    }
    if (refreshed === null || refreshed.state !== "open") {
      await this.cancelScheduledLifecycleWork({
        issueNumber: payload.issue.number,
        reason: CANCEL_REASONS.CLOSED_ISSUE,
        repository,
        runId: payload.runId
      });
      return;
    }
    // Raw FSM mid-walk runs: the FSM, not the issue labels, decides whether
    // the agent keeps running. A transient retry of such a run must not be
    // cancelled by label drift during the retry backoff. CLOSED_ISSUE above is
    // still honored. See ADR 0046.
    if (payload.respectsIssueLabels !== false) {
      const eligibility = evaluateProjectEligibility(refreshed, project, {
        ignoreOperationalLabels: true
      });
      if (!eligibility.eligible) {
        await this.cancelScheduledLifecycleWork({
          issueNumber: payload.issue.number,
          reason: CANCEL_REASONS.ELIGIBILITY_LOSS,
          repository,
          runId: payload.runId
        });
        return;
      }
    }

    // Re-assert sym:claimed best-effort in case operator clear-stale ran between attempts.
    await this.bestEffort(
      () =>
        this.githubIssuesApi.addLabelsToIssue!({
          ...repository,
          issueNumber: refreshed.number,
          labels: ["sym:claimed"]
        }),
      {
        issueNumber: refreshed.number,
        label: "sym:claimed",
        operation: "addLabel",
        project: project.name,
        runId: payload.runId
      }
    );

    await this.runAttemptLifecycle({
      attemptNumber: payload.attemptNumber,
      ...(payload.extraInstructions === undefined
        ? {}
        : { extraInstructions: payload.extraInstructions }),
      isContinuation: this.runStore.isContinuationRun(payload.runId),
      issue: refreshed,
      project,
      provider,
      providerCommand,
      providerName: payload.providerName,
      repository,
      runId: payload.runId
    });
  }

  private async cancelScheduledLifecycleWork(input: {
    issueNumber: number;
    reason: CancelReason;
    repository: GitHubIssueRepositoryInput;
    runId: string;
  }): Promise<void> {
    this.runStore.markCancelRequested(input.runId, input.reason);
    this.runStore.recordTerminalReason(input.runId, input.reason);
    this.runStore.updateRunState(input.runId, "cancelled");
    await this.applyTerminalLabels({
      cancelReason: input.reason,
      issueNumber: input.issueNumber,
      outcome: { kind: "cancelled", reason: input.reason },
      repository: input.repository,
      willRetry: false
    });
  }

  async executeWaitPark(payload: WaitParkPayload): Promise<void> {
    await this.reEvaluateWaitingRun(payload.waitingRunId);
  }

  // Tells the global PR follow-up loop whether a tracked PR's merge belongs
  // to a workflow-controlled merge_pr state. When true, the global loop
  // must skip the auto-merge so the next reEvaluateWaitingRun tick can
  // apply the workflow's method override and record merge_pr evidence —
  // otherwise discovery and global merge happen in the same tick before
  // the merge_pr state's re-evaluation sees the tracked PR. See ADR 0048.
  async isIssueParkedInMergePrState(input: {
    issueNumber: number;
    projectName: string;
  }): Promise<boolean> {
    const waiting = this.runStore.findWaitingRunByIssue(input);
    if (waiting === undefined || waiting.currentStateId === null) {
      return false;
    }
    const projects = await this.projectsLoader();
    const project = projects.get(input.projectName);
    if (project === undefined) {
      return false;
    }
    let loaded;
    try {
      loaded = await this.loadWorkflow(project.workflow);
    } catch {
      return false;
    }
    if (loaded.errors.length > 0) {
      return false;
    }
    const state = findWorkflowState(
      loaded.expandedWorkflow,
      waiting.currentStateId
    );
    return state?.action?.kind === "merge_pr";
  }

  async reEvaluateWaitingRun(runId: string): Promise<void> {
    const row = this.runStore.getRun(runId);
    if (row === undefined || row.state !== "waiting") {
      return;
    }
    if (row.cancelRequested) {
      const reason: CancelReason = row.cancelReason ?? "operator";
      this.runStore.markCancelRequested(runId, reason);
      this.runStore.updateRunState(runId, "cancelled");
      return;
    }
    if (row.currentStateId === null) {
      return;
    }

    const projects = await this.projectsLoader();
    const project = projects.get(row.project);
    if (project === undefined || project.disabled === true) {
      return;
    }

    const token = resolveTokenFromEnv(project.tracker.token, this.env);
    if (token === undefined) {
      return;
    }
    const repository: GitHubIssueRepositoryInput = {
      owner: project.tracker.owner,
      repo: project.tracker.repo,
      token
    };

    const refreshed = await this.refreshIssue({
      project,
      issueNumber: row.issueNumber,
      repository
    });
    if (refreshed === undefined) {
      return;
    }
    if (refreshed === null || refreshed.state !== "open") {
      this.runStore.markCancelRequested(runId, "closed_issue");
      this.runStore.updateRunState(runId, "cancelled");
      return;
    }

    const loaded = await this.loadWorkflow(project.workflow);
    const waitState = findWorkflowState(
      loaded.expandedWorkflow,
      row.currentStateId
    );
    if (waitState === undefined) {
      this.logger?.warn(
        { runId, stateId: row.currentStateId },
        "symphonika wait re-eval skipped: workflow state not found"
      );
      return;
    }

    const isMergePr = waitState.action?.kind === "merge_pr";

    // Use the all-states lookup: a wait state targeting `pr_merged: true` must
    // still see the tracked row after PR follow-up has marked it "merged"; an
    // open-only listing would strand the wait. The dispatcher's own open-only
    // loop is unaffected — only wait re-evaluation widens the lookup.
    const tracked = this.runStore.findTrackedPullRequestByIssue({
      issueNumber: row.issueNumber,
      projectName: row.project
    });
    if (tracked === undefined) {
      if (isMergePr) {
        this.runStore.recordWaitingActivity(
          runId,
          `merge_pr awaiting Symphonika-tracked pull request for issue #${row.issueNumber}`
        );
      }
      this.logger?.debug(
        { runId, issueNumber: row.issueNumber },
        "symphonika wait re-eval skipped: no PR tracked yet"
      );
      return;
    }

    let prState;
    try {
      prState = await tryGetPullRequestFollowupState(this.githubIssuesApi, {
        owner: repository.owner,
        pullNumber: tracked.prNumber,
        repo: repository.repo,
        token: repository.token
      });
    } catch (error) {
      this.logger?.warn(
        { err: error, runId },
        "symphonika wait re-eval skipped: PR state fetch failed"
      );
      return;
    }
    if (prState === undefined || prState === null) {
      return;
    }

    const pullRequestState = interpretPullRequest(prState);
    const signals: WorkflowPredicateMap = {
      provider_success: true,
      ...projectPullRequestSignals(pullRequestState)
    };

    if (isMergePr) {
      const policy = await this.pullRequestPolicyLoader();
      const method =
        coerceMergeMethod(waitState.action?.method) ?? policy.merge.method;
      if (!policy.merge.enabled) {
        this.runStore.recordWaitingActivity(
          runId,
          "merge_pr deferred: pull_requests.merge.enabled is false"
        );
        this.logger?.debug(
          { runId },
          "symphonika merge_pr re-eval: merge disabled by policy"
        );
      } else if (pullRequestReadyToMerge(pullRequestState, policy)) {
        try {
          const merged = await tryMergePullRequest(this.githubIssuesApi, {
            expectedHeadSha: pullRequestState.headSha,
            method,
            owner: repository.owner,
            pullNumber: tracked.prNumber,
            repo: repository.repo,
            token: repository.token
          });
          if (merged) {
            // Reproject signals against the post-merge state so workflow
            // transitions written in the natural shape (e.g.
            // `when: { pr_merged: true, pr_open: false }`) match — without
            // this, signals would still carry `pr_open: true` from the
            // pre-merge fetch and a refetch-style transition would silently
            // stay parked even though the merge succeeded.
            const mergedSignals = projectPullRequestSignals({
              ...pullRequestState,
              merged: true,
              open: false
            });
            for (const key of Object.keys(mergedSignals)) {
              signals[key] = mergedSignals[key]!;
            }
            this.runStore.recordPullRequestObservation({
              headSha: pullRequestState.headSha,
              id: tracked.id,
              prUrl: pullRequestState.url,
              state: "merged"
            });
            this.runStore.recordWaitingActivity(
              runId,
              `merge_pr merged PR #${tracked.prNumber} via ${method}`
            );
            this.logger?.info(
              { method, prNumber: tracked.prNumber, runId },
              "symphonika merge_pr merged PR"
            );
          } else {
            this.runStore.recordWaitingActivity(
              runId,
              `merge_pr unavailable: GitHub tracker does not expose mergePullRequest`
            );
            this.logger?.warn(
              { runId },
              "symphonika merge_pr: tracker has no mergePullRequest support"
            );
            return;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.runStore.recordWaitingActivity(
            runId,
            `merge_pr attempt failed for PR #${tracked.prNumber}: ${message}`
          );
          this.logger?.warn(
            { err: error, prNumber: tracked.prNumber, runId },
            "symphonika merge_pr attempt failed"
          );
          return;
        }
      } else {
        this.runStore.recordWaitingActivity(
          runId,
          `merge_pr deferred: PR #${tracked.prNumber} not yet ready under policy`
        );
        this.logger?.debug(
          { runId },
          "symphonika merge_pr re-eval: PR not yet ready to merge"
        );
      }
    }

    const decision = decideNextStep({
      actionExecuted: true,
      signals,
      state: waitState
    });

    if (decision.kind === "stay_waiting") {
      this.logger?.debug(
        { reason: decision.reason, runId },
        "symphonika wait re-eval: still waiting"
      );
      return;
    }

    if (decision.kind === "advance") {
      const next = findWorkflowState(loaded.expandedWorkflow, decision.to);
      if (next?.terminal !== undefined) {
        this.runStore.recordWorkflowTerminal(runId, {
          terminalStateId: next.id,
          transitionReason: decision.reason
        });
        this.runStore.updateRunState(runId, "succeeded");
        return;
      }
      this.runStore.recordWorkflowStateAdvance(runId, {
        nextStateId: decision.to,
        transitionReason: decision.reason
      });
      this.runStore.updateRunState(runId, "succeeded");

      if (isParkedAction(next?.action?.kind)) {
        const nextWaitingRunId = this.createRunId();
        this.runStore.createWaitingRun({
          currentStateId: decision.to,
          id: nextWaitingRunId,
          issue: refreshed,
          parentRunId: runId,
          projectName: project.name
        });
        this.schedule({
          delayMs: this.lifecyclePolicy.continuation.delayMs,
          fire: () =>
            this.executeWaitPark({ waitingRunId: nextWaitingRunId }),
          issueNumber: refreshed.number,
          kind: "wait_park",
          projectName: project.name,
          runId
        });
        return;
      }

      this.schedule({
        delayMs: this.lifecyclePolicy.continuation.delayMs,
        fire: () =>
          this.executeStateAdvance({
            issue: refreshed,
            parentRunId: runId,
            projectName: project.name,
            toStateId: decision.to
          }),
        issueNumber: refreshed.number,
        kind: "state_advance",
        projectName: project.name,
        runId
      });
      return;
    }

    if (decision.kind === "blocked") {
      this.runStore.recordWorkflowBlocked(runId, {
        stateId: waitState.id,
        transitionReason: decision.reason
      });
      this.runStore.updateRunState(runId, "succeeded");
      return;
    }

    if (decision.kind === "terminate") {
      this.runStore.recordWorkflowTerminal(runId, {
        terminalStateId: decision.stateId,
        transitionReason: `entered terminal state ${decision.terminal}`
      });
      this.runStore.updateRunState(runId, "succeeded");
    }
  }

  async executeStateAdvance(payload: StateAdvancePayload): Promise<void> {
    const projects = await this.projectsLoader();
    const project = projects.get(payload.projectName);
    if (project === undefined || project.disabled === true) {
      this.logger?.warn(
        { projectName: payload.projectName, parentRunId: payload.parentRunId },
        "symphonika state advance dropped: project disabled or removed"
      );
      return;
    }

    const providersConfig = await this.providersLoader();

    if (!isLabelWritingGitHubIssuesApi(this.githubIssuesApi)) {
      return;
    }

    const token = resolveTokenFromEnv(project.tracker.token, this.env);
    if (token === undefined) {
      return;
    }
    const repository = {
      owner: project.tracker.owner,
      repo: project.tracker.repo,
      token
    };

    // State advance only re-checks that the issue is still open. The
    // labels_all / labels_none filter is intentionally skipped: the FSM, not
    // the issue label set, decides whether the next state runs. See ADR 0046.
    const refreshed = await this.refreshIssue({
      project,
      issueNumber: payload.issue.number,
      repository
    });
    if (refreshed === undefined) {
      this.logger?.warn(
        { projectName: payload.projectName, parentRunId: payload.parentRunId },
        "symphonika state advance dropped: issue refresh unavailable"
      );
      return;
    }
    if (refreshed === null || refreshed.state !== "open") {
      return;
    }

    const runId = this.createRunId();
    let loadedWorkflow: LoadedWorkflow;
    try {
      loadedWorkflow = await this.loadWorkflow(project.workflow, {
        forceReload: true
      });
    } catch (error) {
      const providerName = project.agent.provider;
      const providerCommand =
        (providersConfig as Partial<RunControllerProvidersConfig>)[providerName]
          ?.command ?? "";
      const message = error instanceof Error ? error.message : String(error);
      await this.failStateAdvanceBeforeProvider({
        issue: refreshed,
        parentRunId: payload.parentRunId,
        project,
        providerCommand,
        providerName,
        reason: `workflow_load_failed: ${message}`,
        repository,
        runId
      });
      return;
    }
    if (loadedWorkflow.errors.length > 0) {
      const providerName = project.agent.provider;
      const providerCommand =
        (providersConfig as Partial<RunControllerProvidersConfig>)[providerName]
          ?.command ?? "";
      await this.failStateAdvanceBeforeProvider({
        issue: refreshed,
        parentRunId: payload.parentRunId,
        project,
        providerCommand,
        providerName,
        reason: `workflow_load_failed: ${loadedWorkflow.errors.join("; ")}`,
        repository,
        runId
      });
      return;
    }

    const targetState = findWorkflowState(
      loadedWorkflow.expandedWorkflow,
      payload.toStateId
    );
    if (targetState === undefined) {
      const providerName = project.agent.provider;
      const providerCommand =
        (providersConfig as Partial<RunControllerProvidersConfig>)[providerName]
          ?.command ?? "";
      await this.failStateAdvanceBeforeProvider({
        issue: refreshed,
        parentRunId: payload.parentRunId,
        project,
        providerCommand,
        providerName,
        reason: `workflow_state_not_found: ${payload.toStateId}`,
        repository,
        runId
      });
      return;
    }

    const providerName =
      targetState.action?.kind === "agent" &&
      targetState.action.provider !== undefined
        ? targetState.action.provider
        : project.agent.provider;
    const providerConfig = (providersConfig as Partial<RunControllerProvidersConfig>)[
      providerName
    ];
    const providerCommand = providerConfig?.command;

    if (providerCommand === undefined || providerCommand.trim().length === 0) {
      await this.failStateAdvanceBeforeProvider({
        issue: refreshed,
        parentRunId: payload.parentRunId,
        project,
        providerCommand: providerCommand ?? "",
        providerName,
        reason: `provider_command_missing: ${providerName}`,
        repository,
        runId
      });
      return;
    }

    const provider = this.agentProviders[providerName];
    if (provider === undefined) {
      await this.failStateAdvanceBeforeProvider({
        issue: refreshed,
        parentRunId: payload.parentRunId,
        project,
        providerCommand,
        providerName,
        reason: `provider_not_registered: ${providerName}`,
        repository,
        runId
      });
      return;
    }

    await this.runFreshLifecycle({
      attemptNumber: 1,
      isContinuation: true,
      issue: refreshed,
      parentRunId: payload.parentRunId,
      project: {
        ...project,
        workflow: {
          body: loadedWorkflow.body,
          contentHash: loadedWorkflow.contentHash,
          expandedWorkflow: loadedWorkflow.expandedWorkflow,
          format: loadedWorkflow.format,
          path: loadedWorkflow.path
        }
      },
      provider,
      providerCommand,
      providerName,
      repository,
      runId
    });
  }

  private async failStateAdvanceBeforeProvider(input: {
    issue: IssueSnapshot;
    parentRunId: string;
    project: RunControllerProjectConfig;
    providerCommand: string;
    providerName: AgentProviderName;
    reason: string;
    repository: GitHubIssueRepositoryInput;
    runId: string;
  }): Promise<void> {
    await this.bestEffort(
      () =>
        (this.githubIssuesApi as LabelWritingGitHubIssuesApi).addLabelsToIssue({
          ...input.repository,
          issueNumber: input.issue.number,
          labels: ["sym:claimed"]
        }),
      {
        issueNumber: input.issue.number,
        label: "sym:claimed",
        operation: "addLabel",
        phase: "state-advance-provider-resolution",
        project: input.project.name,
        runId: input.runId
      }
    );
    this.runStore.createContinuationRun({
      id: input.runId,
      issue: input.issue,
      parentRunId: input.parentRunId,
      projectName: input.project.name,
      providerCommand: input.providerCommand,
      providerName: input.providerName
    });
    this.runStore.recordTerminalReason(
      input.runId,
      input.reason,
      "deterministic"
    );
    this.runStore.updateRunState(input.runId, "failed");
    this.logger?.warn(
      {
        issueNumber: input.issue.number,
        parentRunId: input.parentRunId,
        project: input.project.name,
        provider: input.providerName,
        reason: input.reason,
        runId: input.runId
      },
      "symphonika state advance failed before provider launch"
    );
    await this.applyTerminalLabels({
      issueNumber: input.issue.number,
      outcome: {
        classification: "deterministic",
        kind: "failed",
        reason: input.reason
      },
      repository: input.repository,
      willRetry: false
    });
  }

  async executeContinuation(payload: ContinuationPayload): Promise<void> {
    const projects = await this.projectsLoader();
    const project = projects.get(payload.projectName);
    if (project === undefined || project.disabled === true) {
      this.logger?.warn(
        { projectName: payload.projectName, parentRunId: payload.parentRunId },
        "symphonika continuation dropped: project disabled or removed"
      );
      return;
    }

    const provider = this.agentProviders[project.agent.provider];
    if (provider === undefined) {
      return;
    }

    const providersConfig = await this.providersLoader();
    const providerCommand = providersConfig[project.agent.provider].command;

    if (!isLabelWritingGitHubIssuesApi(this.githubIssuesApi)) {
      return;
    }

    const token = resolveTokenFromEnv(project.tracker.token, this.env);
    if (token === undefined) {
      return;
    }
    const repository = {
      owner: project.tracker.owner,
      repo: project.tracker.repo,
      token
    };

    // Re-check issue state at the moment the continuation fires. The success
    // path already checks before scheduling, but operators may remove
    // agent-ready or add needs-human during the short continuation delay.
    const refreshed = await this.refreshIssue({
      project,
      issueNumber: payload.issue.number,
      repository
    });
    if (refreshed === undefined) {
      this.logger?.warn(
        { projectName: payload.projectName, parentRunId: payload.parentRunId },
        "symphonika continuation dropped: issue refresh unavailable"
      );
      return;
    }
    if (refreshed === null || refreshed.state !== "open") {
      return;
    }
    const eligibility = evaluateProjectEligibility(refreshed, project, {
      ignoreOperationalLabels: true
    });
    if (!eligibility.eligible) {
      return;
    }

    const runId = this.createRunId();
    await this.runFreshLifecycle({
      attemptNumber: 1,
      isContinuation: true,
      issue: refreshed,
      parentRunId: payload.parentRunId,
      project,
      provider,
      providerCommand,
      providerName: project.agent.provider,
      repository,
      runId
    });
  }

  async dispatchReviewFollowup(input: {
    issueNumber: number;
    parentRunId: string;
    projectName: string;
    review: ReviewFollowupContext;
  }): Promise<DispatchOneFreshResult> {
    const projects = await this.projectsLoader();
    const project = projects.get(input.projectName);
    if (project === undefined || project.disabled === true) {
      return {
        dispatched: false,
        reason: "project disabled or removed"
      };
    }

    if (this.activeRuns.isIssueInFlight(input.projectName, input.issueNumber)) {
      return {
        dispatched: false,
        reason: "issue already has an active run"
      };
    }

    // Don't race a scheduled state_advance: a wait→agent transition may have
    // just enqueued an autofix state for this issue in the same tick. The
    // scheduled item is not yet in `activeRuns.entries`, so `isIssueInFlight`
    // misses it. Consult `isIssueScheduled` to avoid dispatching a duplicate
    // review-followup run on the same issue/branch.
    if (this.activeRuns.isIssueScheduled(input.projectName, input.issueNumber)) {
      return {
        dispatched: false,
        reason: "issue has scheduled work pending"
      };
    }

    const provider = this.agentProviders[project.agent.provider];
    if (provider === undefined) {
      return {
        dispatched: false,
        reason: "project provider is not registered"
      };
    }

    const providersConfig = await this.providersLoader();
    const providerCommand = providersConfig[project.agent.provider].command;

    if (!isLabelWritingGitHubIssuesApi(this.githubIssuesApi)) {
      return {
        dispatched: false,
        reason: "GitHub tracker does not support operational label writes"
      };
    }

    const token = resolveTokenFromEnv(project.tracker.token, this.env);
    if (token === undefined) {
      return {
        dispatched: false,
        reason: `projects.${project.name}.tracker.token is not available`
      };
    }
    const repository = {
      owner: project.tracker.owner,
      repo: project.tracker.repo,
      token
    };

    const refreshed = await this.refreshIssue({
      project,
      issueNumber: input.issueNumber,
      repository
    });
    if (refreshed === undefined) {
      return {
        dispatched: false,
        reason: "issue refresh unavailable"
      };
    }
    if (refreshed === null || refreshed.state !== "open") {
      return {
        dispatched: false,
        reason: "issue is closed"
      };
    }

    const runId = this.createRunId();
    await this.runFreshLifecycle({
      attemptNumber: 1,
      extraInstructions: renderReviewFollowupInstructions(input.review),
      isContinuation: true,
      issue: refreshed,
      parentRunId: input.parentRunId,
      project,
      provider,
      providerCommand,
      providerName: project.agent.provider,
      repository,
      runId
    });

    return { dispatched: true, runId };
  }

  private pickTargetFromCandidates(
    candidates: ReadonlyArray<{ issue: IssueSnapshot; project: string }>,
    projects: Map<string, RunControllerProjectConfig>
  ): DispatchTarget | undefined {
    const states = this.runStore.getProjectStatesByName();
    const buckets = new Map<
      string,
      Array<{ issue: IssueSnapshot; project: string }>
    >();
    for (const candidate of candidates) {
      const bucket = buckets.get(candidate.project);
      if (bucket === undefined) {
        buckets.set(candidate.project, [candidate]);
        continue;
      }
      bucket.push(candidate);
    }

    const dispatchable: Array<{
      candidate: { issue: IssueSnapshot; project: string };
      currentWeight: number;
      nextWeight: number;
      project: RunControllerProjectConfig;
      provider: AgentProvider;
      weight: number;
    }> = [];

    for (const [projectName, project] of projects) {
      const bucket = buckets.get(projectName);
      if (bucket === undefined || project.disabled === true) {
        continue;
      }
      const provider = this.agentProviders[project.agent.provider];
      if (provider === undefined) {
        continue;
      }
      const candidate = bucket
        .slice()
        .sort(compareCandidateIssues)
        .find(
          (entry) =>
            !this.activeRuns.isIssueInFlight(entry.project, entry.issue.number)
        );
      if (candidate === undefined) {
        continue;
      }
      const weight = normalizeProjectWeight(
        project.weight ?? states.get(projectName)?.weight
      );
      const currentWeight =
        states.get(projectName)?.schedulerCurrentWeight ?? 0;
      dispatchable.push({
        candidate,
        currentWeight,
        nextWeight: currentWeight + weight,
        project,
        provider,
        weight
      });
    }

    if (dispatchable.length === 0) {
      return undefined;
    }

    const totalWeight = dispatchable.reduce(
      (sum, entry) => sum + entry.weight,
      0
    );
    let selected = dispatchable[0]!;
    for (const entry of dispatchable.slice(1)) {
      if (entry.nextWeight > selected.nextWeight) {
        selected = entry;
      }
    }
    const schedulerWeights = dispatchable.map((entry) => ({
      currentWeight:
        entry === selected ? entry.nextWeight - totalWeight : entry.nextWeight,
      projectName: entry.project.name,
      weight: entry.weight
    }));

    return {
      candidate: selected.candidate,
      project: selected.project,
      provider: selected.provider,
      schedulerWeights
    };
  }

  private async runFreshLifecycle(input: {
    attemptNumber: number;
    extraInstructions?: string;
    isContinuation: boolean;
    issue: IssueSnapshot;
    parentRunId: string | null;
    project: RunControllerProjectConfig;
    provider: AgentProvider;
    providerCommand: string;
    providerName: AgentProviderName;
    repository: GitHubIssueRepositoryInput;
    runId: string;
    schedulerWeights?: Array<{
      currentWeight: number;
      projectName: string;
      weight: number;
    }>;
  }): Promise<void> {
    let claimed = false;
    let runCreated = false;
    try {
      await (this.githubIssuesApi as LabelWritingGitHubIssuesApi).addLabelsToIssue({
        ...input.repository,
        issueNumber: input.issue.number,
        labels: ["sym:claimed"]
      });
      claimed = true;
      this.logger?.info(
        {
          issueNumber: input.issue.number,
          isContinuation: input.isContinuation,
          parentRunId: input.parentRunId,
          project: input.project.name,
          provider: input.providerName,
          runId: input.runId
        },
        "symphonika claimed issue and starting run"
      );
      if (input.schedulerWeights !== undefined) {
        this.runStore.recordProjectDispatchSelection({
          issueNumber: input.issue.number,
          projectName: input.project.name,
          schedulerWeights: input.schedulerWeights
        });
      }
      const createInput = {
        id: input.runId,
        issue: input.issue,
        projectName: input.project.name,
        providerCommand: input.providerCommand,
        providerName: input.providerName
      };
      if (input.isContinuation && input.parentRunId !== null) {
        this.runStore.createContinuationRun({
          ...createInput,
          parentRunId: input.parentRunId
        });
      } else {
        this.runStore.createRun(createInput);
      }
      runCreated = true;
      await this.runAttemptLifecycle({
        attemptNumber: input.attemptNumber,
        ...(input.extraInstructions === undefined
          ? {}
          : { extraInstructions: input.extraInstructions }),
        isContinuation: input.isContinuation,
        issue: input.issue,
        project: input.project,
        provider: input.provider,
        providerCommand: input.providerCommand,
        providerName: input.providerName,
        repository: input.repository,
        runId: input.runId
      });
    } catch (error) {
      if (!runCreated && claimed) {
        // Failure between claim and createRun (rare): still mark sym:failed best-effort.
        await this.markIssueFailed({
          issueNumber: input.issue.number,
          repository: input.repository
        });
      }
      throw error;
    }
  }

  private async runAttemptLifecycle(input: {
    attemptNumber: number;
    extraInstructions?: string;
    isContinuation: boolean;
    issue: IssueSnapshot;
    project: RunControllerProjectConfig;
    provider: AgentProvider;
    providerCommand: string;
    providerName: AgentProviderName;
    repository: GitHubIssueRepositoryInput;
    runId: string;
  }): Promise<void> {
    const attemptId = `${input.runId}-attempt-${input.attemptNumber}`;
    const runtime: RunRuntime = {
      attemptId,
      attemptNumber: input.attemptNumber,
      events: []
    };
    let attemptCreated = false;
    let registered = false;
    let started: StartedAttempt | undefined;
    let caughtError: unknown;

    this.runStore.updateRunState(input.runId, "preparing_workspace");

    const loadedWorkflow = await this.loadWorkflow(input.project.workflow);
    let projectForAttempt = input.project;
    let currentState = undefined as
      | ReturnType<typeof findWorkflowState>
      | undefined;
    if (loadedWorkflow.errors.length === 0) {
      const persistedStateId = this.runStore.getRun(input.runId)?.currentStateId;
      const startStateId =
        persistedStateId ?? loadedWorkflow.expandedWorkflow.initial;
      currentState = findWorkflowState(
        loadedWorkflow.expandedWorkflow,
        startStateId
      );
      if (currentState !== undefined) {
        this.runStore.setRunCurrentState(input.runId, currentState.id);
      }
      projectForAttempt = {
        ...input.project,
        workflow: {
          body: loadedWorkflow.body,
          contentHash: loadedWorkflow.contentHash,
          expandedWorkflow: loadedWorkflow.expandedWorkflow,
          format: loadedWorkflow.format,
          path: loadedWorkflow.path
        }
      };
    }
    // Raw FSM workflows whose entry state is a parked action (wait/merge_pr)
    // must never launch a provider — they have no prompt and must instead be
    // parked into the waiting-row reconciliation path immediately. Without
    // this guard, runAttemptLifecycle would call startAttempt with an empty
    // raw-FSM prompt, terminate, and then fall through `applyWorkflowOutcome`
    // (which has no `stay_waiting` branch) leaving the workflow with no
    // waiting row and no merge attempt scheduled. Returning here keeps the
    // run row durable (state="waiting", current_state_id set) so a daemon
    // restart can resume the reconciliation. See SPEC §12.5 / §12.6.
    if (
      loadedWorkflow.errors.length === 0 &&
      loadedWorkflow.expandedWorkflow.source.kind === "raw_fsm" &&
      currentState !== undefined &&
      isParkedAction(currentState.action?.kind)
    ) {
      this.runStore.updateRunState(input.runId, "waiting");
      this.schedule({
        delayMs: this.lifecyclePolicy.continuation.delayMs,
        fire: () => this.executeWaitPark({ waitingRunId: input.runId }),
        issueNumber: input.issue.number,
        kind: "wait_park",
        projectName: input.project.name,
        runId: input.runId
      });
      return;
    }

    // Raw FSM continuations are state-advance runs: the FSM, not the issue
    // labels, decides whether the agent keeps running. Computed here so both
    // activeRuns.register (in the try block) and scheduleNext (in finally)
    // can carry the same label-immunity guarantee — including into retry
    // scheduling. See ADR 0046.
    const respectsIssueLabels = !(
      input.isContinuation &&
      loadedWorkflow.expandedWorkflow.source.kind === "raw_fsm"
    );

    try {
      // For raw FSM workflows, the agent action's `prompt` field points at the
      // template file to send to the provider for this state. Resolve it here
      // so startAttempt renders the right prompt (rather than the YAML body of
      // the workflow file, which is meaningless input for the agent).
      let promptTemplate: string | undefined;
      if (
        currentState !== undefined &&
        loadedWorkflow.expandedWorkflow.source.kind === "raw_fsm" &&
        currentState.action?.kind === "agent" &&
        currentState.action.prompt !== undefined
      ) {
        const workflowDir = path.dirname(loadedWorkflow.path);
        const promptPath = path.resolve(workflowDir, currentState.action.prompt);
        try {
          promptTemplate = await readFile(promptPath, "utf8");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `workflow state ${currentState.id} prompt not found at ${promptPath}: ${message}`,
            { cause: error }
          );
        }
      }

      started = await this.startAttempt({
        attemptId,
        attemptNumber: input.attemptNumber,
        ...(input.extraInstructions === undefined
          ? {}
          : { extraInstructions: input.extraInstructions }),
        isContinuation: input.isContinuation,
        issue: input.issue,
        project: projectForAttempt,
        providerCommand: input.providerCommand,
        providerName: input.providerName,
        ...(promptTemplate === undefined ? {} : { promptTemplate }),
        runId: input.runId
      });
      await input.provider.validate(input.providerCommand);
      await (this.githubIssuesApi as LabelWritingGitHubIssuesApi).addLabelsToIssue({
        ...input.repository,
        issueNumber: input.issue.number,
        labels: ["sym:running"]
      });
      this.runStore.updateRunState(input.runId, "running");
      this.runStore.createAttempt({
        ...started.evidence,
        attemptNumber: input.attemptNumber,
        id: attemptId,
        providerCommand: input.providerCommand,
        providerName: input.providerName,
        runId: input.runId,
        state: "running"
      });
      attemptCreated = true;
      this.activeRuns.register({
        cancel: () => input.provider.cancel(input.runId),
        issueNumber: input.issue.number,
        projectName: input.project.name,
        provider: input.provider,
        respectsIssueLabels,
        runId: input.runId
      });
      registered = true;

      await this.iterateAttempt({
        attemptId,
        attemptNumber: input.attemptNumber,
        evidence: started.evidence,
        issue: input.issue,
        prompt: started.prompt,
        promptPath: started.promptPath,
        provider: input.provider,
        providerCommand: input.providerCommand,
        providerName: input.providerName,
        runId: input.runId,
        runtime
      });
    } catch (error) {
      caughtError = error;
    } finally {
      let cancelRequested = false;
      let cancelReason: CancelReason | undefined;
      if (registered) {
        const removed = this.activeRuns.unregister(input.runId);
        if (removed !== undefined) {
          cancelRequested = removed.cancelRequested;
          cancelReason = removed.cancelReason;
        }
      }
      const terminal = await classifyFailure({
        cancelRequested,
        ...(caughtError === undefined ? {} : { error: caughtError }),
        events: runtime.events,
        ...(started === undefined
          ? {}
          : {
              successWorkspace: {
                baseBranch: input.project.workspace.git.base_branch,
                workspacePath: started.evidence.workspacePath
              }
            })
      });
      let workflowOutcome: WorkflowOutcomeResult = {
        advancedToState: null,
        advancedToTerminal: false,
        blocked: false
      };
      if (currentState !== undefined) {
        workflowOutcome = this.applyWorkflowOutcome({
          currentState,
          issue: input.issue,
          project: input.project,
          runId: input.runId,
          terminal,
          workflow: loadedWorkflow.expandedWorkflow
        });
      }
      const effectiveOutcome = fuseWorkflowTerminal(
        terminal,
        workflowOutcome.terminalLabel
      );
      const outcomeState = mapOutcomeToRunState(effectiveOutcome);
      if (attemptCreated) {
        this.runStore.updateAttemptState(attemptId, outcomeState);
      }
      this.runStore.recordTerminalReason(
        input.runId,
        effectiveOutcome.reason,
        effectiveOutcome.classification
      );
      const sourceKind = loadedWorkflow.expandedWorkflow.source.kind;
      const isRawFsm = sourceKind === "raw_fsm";
      const suppressContinuation =
        isRawFsm &&
        (workflowOutcome.advancedToTerminal ||
          workflowOutcome.blocked ||
          workflowOutcome.advancedToState !== null);
      this.runStore.updateRunState(input.runId, outcomeState);

      const willRetry =
        effectiveOutcome.kind === "failed" &&
        effectiveOutcome.classification === "transient" &&
        this.runStore.runRetryCount(input.runId) < this.lifecyclePolicy.retry.cap;

      this.logger?.info(
        {
          attemptNumber: input.attemptNumber,
          cancelReason,
          cancelRequested,
          classification: effectiveOutcome.classification,
          isContinuation: input.isContinuation,
          issueNumber: input.issue.number,
          kind: effectiveOutcome.kind,
          project: input.project.name,
          runId: input.runId,
          state: outcomeState,
          terminalReason: effectiveOutcome.reason,
          willRetry,
          workflowTerminalLabel: workflowOutcome.terminalLabel
        },
        "symphonika run terminated"
      );

      const labelInput: ApplyLabelsInput = {
        issueNumber: input.issue.number,
        outcome: effectiveOutcome,
        repository: input.repository,
        willRetry
      };
      if (cancelReason !== undefined) {
        labelInput.cancelReason = cancelReason;
      }
      await this.applyTerminalLabels(labelInput);

      // scheduleNext also handles transient throws (kind=failed/transient with retry budget).
      // It is a no-op for cancelled, deterministic, and input_required outcomes.
      try {
        await this.scheduleNext({
          ...(input.extraInstructions === undefined
            ? {}
            : { extraInstructions: input.extraInstructions }),
          issue: input.issue,
          outcome: effectiveOutcome,
          project: input.project,
          providerCommand: input.providerCommand,
          providerName: input.providerName,
          repository: input.repository,
          respectsIssueLabels,
          runId: input.runId,
          runtimeAttemptNumber: input.attemptNumber,
          stateAdvance:
            isRawFsm &&
            workflowOutcome.advancedToState !== null &&
            workflowOutcome.parkAsWait !== true
              ? {
                  toStateId: workflowOutcome.advancedToState
                }
              : null,
          waitPark:
            isRawFsm &&
            workflowOutcome.parkAsWait === true &&
            workflowOutcome.waitingRunId !== undefined
              ? { waitingRunId: workflowOutcome.waitingRunId }
              : null,
          suppressContinuation
        });
      } catch (scheduleError) {
        this.logger?.error(
          { err: scheduleError, runId: input.runId },
          "symphonika scheduleNext failed"
        );
      }
    }

    if (caughtError !== undefined) {
      throw caughtError instanceof Error
        ? caughtError
        : new Error(typeof caughtError === "string" ? caughtError : "unknown error");
    }
  }

  private async startAttempt(input: {
    attemptId: string;
    attemptNumber: number;
    extraInstructions?: string;
    isContinuation: boolean;
    issue: IssueSnapshot;
    project: RunControllerProjectConfig;
    promptTemplate?: string;
    providerCommand: string;
    providerName: AgentProviderName;
    runId: string;
  }): Promise<StartedAttempt> {
    const prepared = await this.prepareIssueWorkspace({
      configDir: this.configDir,
      issue: {
        number: input.issue.number,
        title: input.issue.title
      },
      project: input.project
    });

    const workflow = await this.loadWorkflow(input.project.workflow);
    const workflowPath = workflow.path;
    if (workflow.errors.length > 0) {
      throw new Error(workflow.errors.join("\n"));
    }

    const promptInput = {
      branch: {
        name: prepared.branchName,
        ref: prepared.branchRef
      },
      ...(input.extraInstructions === undefined
        ? {}
        : { extraInstructions: input.extraInstructions }),
      issue: input.issue,
      project: { name: input.project.name },
      provider: {
        command: input.providerCommand,
        name: input.providerName
      },
      run: {
        attempt: input.attemptNumber,
        continuation: input.isContinuation,
        id: input.runId
      },
      template: input.promptTemplate ?? workflow.body,
      workflowContentHash: workflow.contentHash,
      workflowPath,
      workspace: {
        path: prepared.workspacePath,
        previous_attempt: prepared.reused,
        root: path.resolve(this.configDir, input.project.workspace.root)
      }
    };
    const renderedPrompt = renderAutonomousPrompt(promptInput);
    const evidence = await persistRunEvidence({
      ...promptInput,
      attemptNumber: input.attemptNumber,
      expandedWorkflow: workflow.expandedWorkflow,
      renderedPrompt,
      stateRoot: this.stateRoot
    });
    const attemptSuffix =
      input.attemptNumber === 1 ? "" : `.attempt-${input.attemptNumber}`;
    const rawLogPath = path.join(
      evidence.runEvidenceDirectory,
      `provider.raw${attemptSuffix}.jsonl`
    );
    const normalizedLogPath = path.join(
      evidence.runEvidenceDirectory,
      `provider.normalized${attemptSuffix}.jsonl`
    );
    await Promise.all([
      writeFile(rawLogPath, "", "utf8"),
      writeFile(normalizedLogPath, "", "utf8")
    ]);
    const attemptEvidence: AttemptEvidence = {
      branchName: prepared.branchName,
      branchRef: prepared.branchRef,
      issueSnapshotPath: evidence.issueSnapshotPath,
      metadataPath: evidence.metadataPath,
      normalizedLogPath,
      promptPath: evidence.promptPath,
      rawLogPath,
      workflowGraphPath: evidence.workflowGraphPath,
      workspacePath: prepared.workspacePath
    };
    this.runStore.updateRunEvidence(input.runId, attemptEvidence);

    return {
      evidence: attemptEvidence,
      prepared,
      prompt: renderedPrompt.prompt,
      promptPath: evidence.promptPath
    };
  }

  private applyWorkflowOutcome(input: {
    currentState: ExpandedWorkflowState;
    issue: IssueSnapshot;
    project: RunControllerProjectConfig;
    runId: string;
    terminal: ClassifiedTerminal;
    workflow: ExpandedWorkflow;
  }): WorkflowOutcomeResult {
    const signals = signalsFromTerminal(input.terminal);
    const decision = decideNextStep({
      actionExecuted: true,
      signals,
      state: input.currentState
    });

    if (decision.kind === "advance") {
      const next = findWorkflowState(input.workflow, decision.to);
      if (next?.terminal !== undefined) {
        this.runStore.recordWorkflowTerminal(input.runId, {
          terminalStateId: next.id,
          transitionReason: decision.reason
        });
        const terminalLabel = narrowTerminalLabel(next.terminal);
        return {
          advancedToState: null,
          advancedToTerminal: true,
          blocked: false,
          ...(terminalLabel === undefined ? {} : { terminalLabel })
        };
      }
      this.runStore.recordWorkflowStateAdvance(input.runId, {
        nextStateId: decision.to,
        transitionReason: decision.reason
      });
      if (isParkedAction(next?.action?.kind)) {
        const waitingRunId = this.createRunId();
        this.runStore.createWaitingRun({
          currentStateId: decision.to,
          id: waitingRunId,
          issue: input.issue,
          parentRunId: input.runId,
          projectName: input.project.name
        });
        return {
          advancedToState: decision.to,
          advancedToTerminal: false,
          blocked: false,
          parkAsWait: true,
          waitingRunId
        };
      }
      return {
        advancedToState: decision.to,
        advancedToTerminal: false,
        blocked: false
      };
    }

    if (decision.kind === "blocked") {
      this.runStore.recordWorkflowBlocked(input.runId, {
        stateId: input.currentState.id,
        transitionReason: decision.reason
      });
      return { advancedToState: null, advancedToTerminal: false, blocked: true };
    }

    if (decision.kind === "terminate") {
      this.runStore.recordWorkflowTerminal(input.runId, {
        terminalStateId: decision.stateId,
        transitionReason: `entered terminal state ${decision.terminal}`
      });
      const terminalLabel = narrowTerminalLabel(decision.terminal);
      return {
        advancedToState: null,
        advancedToTerminal: true,
        blocked: false,
        ...(terminalLabel === undefined ? {} : { terminalLabel })
      };
    }

    return { advancedToState: null, advancedToTerminal: false, blocked: false };
  }

  private async loadWorkflow(
    workflow: WorkflowReference | WorkflowSnapshot,
    options: { forceReload?: boolean } = {}
  ): Promise<LoadedWorkflow> {
    if (!("expandedWorkflow" in workflow) || options.forceReload === true) {
      const workflowPath = path.resolve(this.configDir, workflow.path);
      const contents = await readFile(workflowPath, "utf8");
      const format = workflow.format;
      const expanded = await expandWorkflowDefinition(
        contents,
        workflowPath,
        format
      );
      // Raw FSM YAML files commonly open with the `---` document marker; the
      // markdown contract parser would reject those as missing a closing
      // delimiter. Skip it entirely for raw FSM — per-state `action.prompt`
      // files supply the actual prompt at dispatch time.
      if (expanded.workflow.source.kind === "raw_fsm") {
        return {
          body: "",
          contentHash: expanded.workflow.contentHash,
          errors: expanded.errors,
          expandedWorkflow: expanded.workflow,
          format,
          path: workflowPath
        };
      }
      const contract = parseWorkflowContract(contents, workflowPath);
      return {
        body: contract.body,
        contentHash: contract.contentHash,
        errors: [...contract.errors, ...expanded.errors],
        expandedWorkflow: expanded.workflow,
        format,
        path: workflowPath
      };
    }

    return {
      body: workflow.body,
      contentHash: workflow.contentHash,
      errors: [],
      expandedWorkflow: workflow.expandedWorkflow,
      format: workflow.format,
      path: workflow.path
    };
  }

  private async iterateAttempt(input: {
    attemptId: string;
    attemptNumber: number;
    evidence: AttemptEvidence;
    issue: IssueSnapshot;
    prompt: string;
    promptPath: string;
    provider: AgentProvider;
    providerCommand: string;
    providerName: AgentProviderName;
    runId: string;
    runtime: RunRuntime;
  }): Promise<void> {
    let sequence = 0;
    for await (const event of input.provider.runAttempt({
      branchName: input.evidence.branchName,
      issue: input.issue,
      prompt: input.prompt,
      promptPath: input.promptPath,
      provider: {
        command: input.providerCommand,
        name: input.providerName
      },
      run: {
        attempt: input.attemptNumber,
        id: input.runId
      },
      workspacePath: input.evidence.workspacePath
    })) {
      sequence += 1;
      await this.persistProviderEvent({
        attemptId: input.attemptId,
        event,
        normalizedLogPath: input.evidence.normalizedLogPath,
        rawLogPath: input.evidence.rawLogPath,
        runId: input.runId,
        sequence
      });
      if (event.normalized !== undefined) {
        input.runtime.events.push(event.normalized);
      }
    }
  }

  private async persistProviderEvent(input: {
    attemptId: string;
    event: ProviderEvent;
    normalizedLogPath: string;
    rawLogPath: string;
    runId: string;
    sequence: number;
  }): Promise<void> {
    await Promise.all([
      appendJsonl(input.rawLogPath, input.event.raw),
      ...(input.event.normalized === undefined
        ? []
        : [appendJsonl(input.normalizedLogPath, input.event.normalized)])
    ]);
    if (input.event.normalized === undefined) {
      return;
    }
    this.runStore.recordProviderEvent({
      attemptId: input.attemptId,
      normalized: input.event.normalized,
      raw: input.event.raw,
      runId: input.runId,
      sequence: input.sequence
    });
  }

  private async markIssueFailed(input: {
    issueNumber: number;
    repository: GitHubIssueRepositoryInput;
  }): Promise<void> {
    const api = this.githubIssuesApi as LabelWritingGitHubIssuesApi;
    try {
      await api.addLabelsToIssue({
        ...input.repository,
        issueNumber: input.issueNumber,
        labels: ["sym:failed"]
      });
    } catch (err) {
      this.logger?.warn(
        { err, issueNumber: input.issueNumber },
        "symphonika failed to add sym:failed label; sym:claimed left in place"
      );
      return;
    }
    this.logger?.info(
      { issueNumber: input.issueNumber },
      "symphonika marked issue sym:failed"
    );
  }

  private async applyTerminalLabels(input: ApplyLabelsInput): Promise<void> {
    const api = this.githubIssuesApi as LabelWritingGitHubIssuesApi;
    if (input.outcome.kind === "cancelled") {
      const reason = input.cancelReason;
      await this.bestEffort(
        () =>
          api.removeLabelsFromIssue({
            ...input.repository,
            issueNumber: input.issueNumber,
            labels: ["sym:running"]
          }),
        {
          issueNumber: input.issueNumber,
          label: "sym:running",
          operation: "removeLabel",
          phase: "cancelled"
        }
      );
      if (reason === CANCEL_REASONS.CLOSED_ISSUE) {
        await this.bestEffort(
          () =>
            api.removeLabelsFromIssue({
              ...input.repository,
              issueNumber: input.issueNumber,
              labels: ["sym:claimed"]
            }),
          {
            issueNumber: input.issueNumber,
            label: "sym:claimed",
            operation: "removeLabel",
            phase: "closed-issue-cleanup"
          }
        );
        await this.bestEffort(
          () =>
            api.removeLabelsFromIssue({
              ...input.repository,
              issueNumber: input.issueNumber,
              labels: ["sym:failed"]
            }),
          {
            issueNumber: input.issueNumber,
            label: "sym:failed",
            operation: "removeLabel",
            phase: "closed-issue-cleanup"
          }
        );
      }
      return;
    }

    await this.bestEffort(
      () =>
        api.removeLabelsFromIssue({
          ...input.repository,
          issueNumber: input.issueNumber,
          labels: ["sym:running"]
        }),
      {
        issueNumber: input.issueNumber,
        label: "sym:running",
        operation: "removeLabel",
        phase: "terminal"
      }
    );

    if (
      input.outcome.kind === "input_required" ||
      (input.outcome.kind === "failed" && !input.willRetry)
    ) {
      await this.markIssueFailed({
        issueNumber: input.issueNumber,
        repository: input.repository
      });
    }
  }

  private async scheduleNext(input: {
    extraInstructions?: string;
    issue: IssueSnapshot;
    outcome: ClassifiedTerminal;
    project: RunControllerProjectConfig;
    providerCommand: string;
    providerName: AgentProviderName;
    repository: GitHubIssueRepositoryInput;
    respectsIssueLabels?: boolean;
    runId: string;
    runtimeAttemptNumber: number;
    stateAdvance?: { toStateId: string } | null;
    suppressContinuation?: boolean;
    waitPark?: { waitingRunId: string } | null;
  }): Promise<void> {
    if (input.outcome.kind === "cancelled" || input.outcome.kind === "input_required") {
      return;
    }

    if (input.outcome.kind === "failed") {
      if (input.outcome.classification !== "transient") {
        return;
      }
      const currentRetries = this.runStore.runRetryCount(input.runId);
      if (currentRetries >= this.lifecyclePolicy.retry.cap) {
        return;
      }
      const next = this.runStore.incrementRetryCount(input.runId);
      const delayMs = computeRetryDelayMs(next, this.lifecyclePolicy);
      this.schedule({
        delayMs,
        fire: () =>
          this.executeRetry({
            attemptNumber: input.runtimeAttemptNumber + 1,
            ...(input.extraInstructions === undefined
              ? {}
              : { extraInstructions: input.extraInstructions }),
            issue: input.issue,
            projectName: input.project.name,
            providerCommand: input.providerCommand,
            providerName: input.providerName,
            // Carry the FSM mid-walk label-immunity bit into the retry. Without
            // this a transient provider failure during a raw FSM walk would be
            // cancelled with ELIGIBILITY_LOSS the moment labels drift, even
            // though the in-flight attempt and the success-to-next-state path
            // are both label-immune. See ADR 0046.
            ...(input.respectsIssueLabels === false
              ? { respectsIssueLabels: false }
              : {}),
            runId: input.runId
          }),
        issueNumber: input.issue.number,
        kind: "retry",
        projectName: input.project.name,
        runId: input.runId
      });
      return;
    }

    // Raw FSM mid-walk: the state machine — not the issue label set — decides
    // what runs next. Dispatch a state advance that skips the continuation cap
    // and skips the labels_all / labels_none re-check; only require that the
    // issue is still open. See ADR 0046.
    if (input.stateAdvance != null) {
      const stateAdvance = input.stateAdvance;
      const refreshedForAdvance = await this.refreshIssue({
        project: input.project,
        issueNumber: input.issue.number,
        repository: input.repository
      });
      if (refreshedForAdvance === undefined) {
        return;
      }
      if (refreshedForAdvance === null || refreshedForAdvance.state !== "open") {
        return;
      }
      this.logger?.info(
        {
          delayMs: this.lifecyclePolicy.continuation.delayMs,
          issueNumber: refreshedForAdvance.number,
          parentRunId: input.runId,
          project: input.project.name,
          toStateId: stateAdvance.toStateId
        },
        "symphonika scheduling state advance"
      );
      this.schedule({
        delayMs: this.lifecyclePolicy.continuation.delayMs,
        fire: () =>
          this.executeStateAdvance({
            issue: refreshedForAdvance,
            parentRunId: input.runId,
            projectName: input.project.name,
            toStateId: stateAdvance.toStateId
          }),
        issueNumber: refreshedForAdvance.number,
        kind: "state_advance",
        projectName: input.project.name,
        runId: input.runId
      });
      return;
    }

    // Raw FSM advanced into a wait state: the waiting row was already created
    // synchronously by applyWorkflowOutcome (so a daemon restart can recover
    // it). Schedule a one-shot re-evaluation; subsequent re-evaluations come
    // from the daemon tick's reconcileWaitingRuns pass.
    if (input.waitPark != null) {
      this.logger?.info(
        {
          delayMs: this.lifecyclePolicy.continuation.delayMs,
          issueNumber: input.issue.number,
          parentRunId: input.runId,
          project: input.project.name,
          waitingRunId: input.waitPark.waitingRunId
        },
        "symphonika scheduling wait re-evaluation"
      );
      const waitingRunId = input.waitPark.waitingRunId;
      this.schedule({
        delayMs: this.lifecyclePolicy.continuation.delayMs,
        fire: () => this.executeWaitPark({ waitingRunId }),
        issueNumber: input.issue.number,
        kind: "wait_park",
        projectName: input.project.name,
        runId: input.runId
      });
      return;
    }

    // success path: re-check eligibility, schedule continuation, enforce cap.
    // For raw FSM workflows that reached an explicit terminal node or blocked
    // on a missing transition, the FSM owns the decision to stop — do not
    // schedule another continuation even if the issue still matches
    // `agent-ready`. Markdown compatibility-graph workflows keep the legacy
    // "loop on agent-ready" behavior.
    if (input.suppressContinuation === true) {
      return;
    }

    const refreshed = await this.refreshIssue({
      project: input.project,
      issueNumber: input.issue.number,
      repository: input.repository
    });
    if (refreshed === undefined) {
      return;
    }
    if (refreshed === null || refreshed.state !== "open") {
      return;
    }
    const eligibility = evaluateProjectEligibility(refreshed, input.project, {
      ignoreOperationalLabels: true
    });
    if (!eligibility.eligible) {
      return;
    }

    if (this.lifecyclePolicy.continuation.cap <= 0) {
      // Continuations disabled; nothing to schedule and nothing to surface as cap-reached.
      return;
    }

    const succeededContinuations = this.runStore.countSucceededContinuations(
      input.project.name,
      input.issue.number
    );
    if (succeededContinuations >= this.lifecyclePolicy.continuation.cap) {
      const parent = this.runStore.getRun(input.runId);
      const kind = await classifyCapReachedOutcome({
        api: this.githubIssuesApi,
        branch: parent?.branchName ?? "",
        logger: this.logger,
        repository: input.repository
      });
      const capId = this.createRunId();
      this.logger?.info(
        {
          cap: this.lifecyclePolicy.continuation.cap,
          capRunId: capId,
          issueNumber: input.issue.number,
          kind,
          parentRunId: input.runId,
          project: input.project.name,
          succeededContinuations
        },
        "symphonika continuation cap reached; marking issue failed"
      );
      this.runStore.createCapReachedFailureRun({
        id: capId,
        issue: refreshed,
        parentRunId: input.runId,
        projectName: input.project.name,
        reason: buildCapReachedReason(kind)
      });
      await this.markIssueFailed({
        issueNumber: input.issue.number,
        repository: input.repository
      });
      return;
    }

    this.logger?.info(
      {
        delayMs: this.lifecyclePolicy.continuation.delayMs,
        issueNumber: refreshed.number,
        parentRunId: input.runId,
        project: input.project.name,
        succeededContinuations
      },
      "symphonika scheduling continuation"
    );

    this.schedule({
      delayMs: this.lifecyclePolicy.continuation.delayMs,
      fire: () =>
        this.executeContinuation({
          issue: refreshed,
          parentRunId: input.runId,
          projectName: input.project.name
        }),
      issueNumber: refreshed.number,
      kind: "continuation",
      projectName: input.project.name,
      runId: input.runId
    });
  }

  private async refreshIssue(input: {
    project: RunControllerProjectConfig;
    issueNumber: number;
    repository: GitHubIssueRepositoryInput;
  }): Promise<IssueSnapshot | null | undefined> {
    let raw;
    try {
      raw = await tryGetIssue(this.githubIssuesApi, {
        issueNumber: input.issueNumber,
        owner: input.repository.owner,
        repo: input.repository.repo,
        token: input.repository.token
      });
    } catch (error) {
      this.logger?.warn(
        { err: error },
        "symphonika continuation refresh failed"
      );
      return undefined;
    }
    if (raw === undefined) {
      return undefined;
    }
    if (raw === null) {
      return null;
    }
    return normalizeRawIssue(raw, input.project);
  }

  private async bestEffort(
    fn: () => Promise<void>,
    context?: Record<string, unknown>
  ): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger?.warn(
        { err, ...context },
        "symphonika best-effort op failed; continuing"
      );
    }
  }
}

function renderReviewFollowupInstructions(
  review: ReviewFollowupContext
): string {
  const lines = [
    "## Pull request review follow-up",
    "",
    "Symphonika detected unaddressed reviewer feedback on an existing pull request for this issue.",
    `PR: #${review.pullRequestNumber} ${review.pullRequestUrl}`,
    `Head SHA: ${review.headSha}`,
    `Review decision: ${review.reviewDecision ?? "none"}`,
    `Status checks: ${review.statusCheckRollupState ?? "unknown"}`,
    "",
    "This is a follow-up run, not a fresh PR creation run. Stay on the existing issue branch, address the review feedback below, push the same branch, and use the local `gh` CLI to reply to the PR review thread when appropriate. Do not open a second pull request.",
    "",
    "### Unaddressed review feedback",
    ""
  ];

  if (review.unresolvedThreads.length === 0) {
    lines.push("- GitHub reported requested changes but did not expose unresolved review threads.");
    return `${lines.join("\n")}\n`;
  }

  for (const thread of review.unresolvedThreads) {
    const location = [thread.path, thread.line].filter(Boolean).join(":");
    lines.push(
      `#### Thread ${thread.id}${location.length === 0 ? "" : ` (${location})`}`
    );
    if (thread.isOutdated === true) {
      lines.push("Outdated: true");
    }
    for (const comment of thread.comments) {
      const author = comment.author ?? "unknown";
      const createdAt = comment.createdAt ?? "unknown time";
      const url = comment.url ?? "";
      lines.push(`- ${author} at ${createdAt}${url.length === 0 ? "" : ` (${url})`}:`);
      lines.push(indentReviewBody(comment.body ?? ""));
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function indentReviewBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return "  (empty comment)";
  }
  return trimmed
    .split(/\r?\n/)
    .slice(0, 80)
    .map((line) => `  ${line}`)
    .join("\n");
}

function mapOutcomeToRunState(outcome: ClassifiedTerminal): RunState {
  switch (outcome.kind) {
    case "success":
      return "succeeded";
    case "cancelled":
      return "cancelled";
    case "input_required":
      return "failed";
    case "failed":
    default:
      return "failed";
  }
}

function narrowTerminalLabel(
  value: string | undefined
): "success" | "failure" | "blocked" | undefined {
  if (value === "success" || value === "failure" || value === "blocked") {
    return value;
  }
  return undefined;
}

// When a raw FSM walks to a `failure` or `blocked` terminal node, the workflow
// author has declared the run is a deterministic failure regardless of the
// provider's exit code. Synthesize that classification so downstream code
// (state write, terminal_reason, sym:failed label, scheduleNext) all observe
// the workflow's verdict. Cancellation and input_required always win — they
// reflect operator/system intent that an FSM terminal label cannot override.
// This intentionally pre-empts the transient-retry policy for workflow-driven
// failures.
function fuseWorkflowTerminal(
  terminal: ClassifiedTerminal,
  terminalLabel: "success" | "failure" | "blocked" | undefined
): ClassifiedTerminal {
  if (terminal.kind === "cancelled" || terminal.kind === "input_required") {
    return terminal;
  }
  if (terminalLabel !== "failure" && terminalLabel !== "blocked") {
    return terminal;
  }
  return {
    classification: "deterministic",
    kind: "failed",
    reason: `workflow_terminal_${terminalLabel}`
  };
}

function isLabelWritingGitHubIssuesApi(
  api: GitHubIssuesApi
): api is LabelWritingGitHubIssuesApi {
  const candidate = api as Partial<LabelWritingGitHubIssuesApi>;
  return (
    typeof candidate.addLabelsToIssue === "function" &&
    typeof candidate.removeLabelsFromIssue === "function"
  );
}

function resolveTokenFromEnv(
  reference: string,
  env: NodeJS.ProcessEnv
): string | undefined {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(reference);
  if (match === null) {
    return undefined;
  }
  const value = env[match[1] ?? ""];
  return value === undefined || value.length === 0 ? undefined : value;
}

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function normalizeRawIssue(
  raw: import("../issue-polling.js").RawGitHubIssue,
  project: RunControllerProjectConfig
): IssueSnapshot {
  const labels = normalizeLabels(raw.labels ?? []);
  return {
    body: raw.body ?? "",
    created_at: raw.created_at ?? "",
    id: raw.id ?? 0,
    labels,
    number: raw.number ?? 0,
    priority: priorityForLabels(labels, project),
    state: raw.state ?? "open",
    title: raw.title ?? "",
    updated_at: raw.updated_at ?? "",
    url: raw.html_url ?? raw.url ?? ""
  };
}

function normalizeLabels(labels: unknown[]): string[] {
  const normalized: string[] = [];
  for (const label of labels) {
    if (typeof label === "string") {
      normalized.push(label);
      continue;
    }
    if (
      typeof label === "object" &&
      label !== null &&
      "name" in label &&
      typeof (label as { name?: unknown }).name === "string"
    ) {
      normalized.push((label as { name: string }).name);
    }
  }
  return normalized;
}

function priorityForLabels(
  labels: string[],
  project: RunControllerProjectConfig
): number {
  const priorities = labels.flatMap((label) => {
    const priority = project.priority.labels[label];
    return priority === undefined ? [] : [priority];
  });
  return priorities.length === 0 ? project.priority.default : Math.min(...priorities);
}

function compareCandidateIssues(
  left: { issue: IssueSnapshot },
  right: { issue: IssueSnapshot }
): number {
  return (
    left.issue.priority - right.issue.priority ||
    left.issue.created_at.localeCompare(right.issue.created_at) ||
    left.issue.number - right.issue.number
  );
}

function normalizeProjectWeight(weight: number | undefined): number {
  if (weight === undefined || !Number.isInteger(weight) || weight <= 0) {
    return 1;
  }
  return weight;
}

function signalsFromTerminal(
  terminal: ClassifiedTerminal
): WorkflowPredicateMap {
  if (terminal.kind === "success") {
    return { branch_ahead_of_base: true, provider_success: true };
  }
  if (terminal.kind === "failed" && terminal.reason === "no_workspace_changes") {
    return { branch_ahead_of_base: false, provider_success: true };
  }
  return { branch_ahead_of_base: false, provider_success: false };
}

function isParkedAction(kind: string | undefined): boolean {
  return kind === "wait" || kind === "merge_pr";
}

function coerceMergeMethod(
  method: string | undefined
): PullRequestFollowupPolicy["merge"]["method"] | undefined {
  if (method === "merge" || method === "rebase" || method === "squash") {
    return method;
  }
  return undefined;
}
