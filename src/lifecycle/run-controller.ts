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
import { evaluateProjectEligibility, tryGetIssue } from "../issue-polling.js";
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
  path: string;
};

type LoadedWorkflow = {
  body: string;
  contentHash: string;
  errors: string[];
  expandedWorkflow: ExpandedWorkflow;
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
  kind: "retry" | "continuation";
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
  runId: string;
};

type ContinuationPayload = {
  issue: IssueSnapshot;
  parentRunId: string;
  projectName: string;
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
    const providerCommand =
      providersConfig[target.project.agent.provider].command;

    await this.runFreshLifecycle({
      attemptNumber: 1,
      isContinuation: false,
      issue: target.candidate.issue,
      parentRunId: null,
      project: target.project,
      provider: target.provider,
      providerCommand,
      providerName: target.project.agent.provider,
      repository,
      runId,
      schedulerWeights: target.schedulerWeights
    });

    return { dispatched: true, runId };
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

    const provider = this.agentProviders[project.agent.provider];
    if (provider === undefined) {
      this.logger?.warn(
        { projectName: payload.projectName, runId: payload.runId },
        "symphonika retry dropped: provider missing"
      );
      return;
    }

    const providersConfig = await this.providersLoader();
    const providerCommand = providersConfig[project.agent.provider].command;

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
      providerName: project.agent.provider,
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
          path: loadedWorkflow.path
        }
      };
    }

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
      const outcomeState = mapOutcomeToRunState(terminal);
      if (attemptCreated) {
        this.runStore.updateAttemptState(attemptId, outcomeState);
      }
      this.runStore.recordTerminalReason(
        input.runId,
        terminal.reason,
        terminal.classification
      );
      let advancedToTerminal = false;
      if (currentState !== undefined) {
        ({ advancedToTerminal } = this.applyWorkflowOutcome({
          currentState,
          runId: input.runId,
          terminal,
          workflow: loadedWorkflow.expandedWorkflow
        }));
      }
      const suppressContinuation =
        advancedToTerminal &&
        loadedWorkflow.expandedWorkflow.source.kind === "raw_fsm";
      this.runStore.updateRunState(input.runId, outcomeState);

      const willRetry =
        terminal.kind === "failed" &&
        terminal.classification === "transient" &&
        this.runStore.runRetryCount(input.runId) < this.lifecyclePolicy.retry.cap;

      this.logger?.info(
        {
          attemptNumber: input.attemptNumber,
          cancelReason,
          cancelRequested,
          classification: terminal.classification,
          isContinuation: input.isContinuation,
          issueNumber: input.issue.number,
          kind: terminal.kind,
          project: input.project.name,
          runId: input.runId,
          state: outcomeState,
          terminalReason: terminal.reason,
          willRetry
        },
        "symphonika run terminated"
      );

      const labelInput: ApplyLabelsInput = {
        issueNumber: input.issue.number,
        outcome: terminal,
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
          outcome: terminal,
          project: input.project,
          repository: input.repository,
          runId: input.runId,
          runtimeAttemptNumber: input.attemptNumber,
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
    runId: string;
    terminal: ClassifiedTerminal;
    workflow: ExpandedWorkflow;
  }): { advancedToTerminal: boolean } {
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
        return { advancedToTerminal: true };
      }
      this.runStore.setRunCurrentState(input.runId, decision.to);
      return { advancedToTerminal: false };
    }

    if (decision.kind === "blocked") {
      this.runStore.recordWorkflowBlocked(input.runId, {
        stateId: input.currentState.id,
        transitionReason: decision.reason
      });
      return { advancedToTerminal: false };
    }

    if (decision.kind === "terminate") {
      this.runStore.recordWorkflowTerminal(input.runId, {
        terminalStateId: decision.stateId,
        transitionReason: `entered terminal state ${decision.terminal}`
      });
      return { advancedToTerminal: true };
    }

    return { advancedToTerminal: false };
  }

  private async loadWorkflow(
    workflow: WorkflowReference | WorkflowSnapshot
  ): Promise<LoadedWorkflow> {
    if (!("expandedWorkflow" in workflow)) {
      const workflowPath = path.resolve(this.configDir, workflow.path);
      const contents = await readFile(workflowPath, "utf8");
      const expanded = expandWorkflowDefinition(
        contents,
        workflowPath,
        workflow.format
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
          path: workflowPath
        };
      }
      const contract = parseWorkflowContract(contents, workflowPath);
      return {
        body: contract.body,
        contentHash: contract.contentHash,
        errors: [...contract.errors, ...expanded.errors],
        expandedWorkflow: expanded.workflow,
        path: workflowPath
      };
    }

    return {
      body: workflow.body,
      contentHash: workflow.contentHash,
      errors: [],
      expandedWorkflow: workflow.expandedWorkflow,
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
    repository: GitHubIssueRepositoryInput;
    runId: string;
    runtimeAttemptNumber: number;
    suppressContinuation?: boolean;
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
            runId: input.runId
          }),
        issueNumber: input.issue.number,
        kind: "retry",
        projectName: input.project.name,
        runId: input.runId
      });
      return;
    }

    // success path: re-check eligibility, schedule continuation, enforce cap.
    // For raw FSM workflows that reached an explicit terminal node, "terminal"
    // means the workflow is done — do not schedule another continuation even
    // if the issue still matches `agent-ready`. Markdown compatibility-graph
    // workflows keep the legacy "loop on agent-ready" behavior.
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
      return "input_required";
    case "failed":
    default:
      return "failed";
  }
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
