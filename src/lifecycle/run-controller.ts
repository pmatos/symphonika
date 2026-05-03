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
  PollingProjectConfig
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
import {
  loadWorkflowContract,
  persistRunEvidence,
  renderAutonomousPrompt
} from "../workflow.js";

import {
  ActiveRunRegistry,
  CANCEL_REASONS,
  computeRetryDelayMs,
  LIFECYCLE_POLICY,
  type LifecyclePolicy
} from "./active-runs.js";
import { classifyFailure, type ClassifiedTerminal } from "./classify-failure.js";

export type RunControllerProjectConfig = PollingProjectConfig & {
  workflow: string;
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

type DispatchTarget = {
  candidate: { issue: IssueSnapshot; project: string };
  project: RunControllerProjectConfig;
  provider: AgentProvider;
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
      runId
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
    await this.bestEffort(() =>
      this.githubIssuesApi.addLabelsToIssue!({
        ...repository,
        issueNumber: refreshed.number,
        labels: ["sym:claimed"]
      })
    );

    await this.runAttemptLifecycle({
      attemptNumber: payload.attemptNumber,
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

  private pickTargetFromCandidates(
    candidates: ReadonlyArray<{ issue: IssueSnapshot; project: string }>,
    projects: Map<string, RunControllerProjectConfig>
  ): DispatchTarget | undefined {
    for (const candidate of candidates) {
      const project = projects.get(candidate.project);
      if (project === undefined || project.disabled === true) {
        continue;
      }
      if (
        this.activeRuns.isIssueInFlight(candidate.project, candidate.issue.number)
      ) {
        continue;
      }
      const provider = this.agentProviders[project.agent.provider];
      if (provider === undefined) {
        continue;
      }
      return { candidate, project, provider };
    }
    return undefined;
  }

  private async runFreshLifecycle(input: {
    attemptNumber: number;
    isContinuation: boolean;
    issue: IssueSnapshot;
    parentRunId: string | null;
    project: RunControllerProjectConfig;
    provider: AgentProvider;
    providerCommand: string;
    providerName: AgentProviderName;
    repository: GitHubIssueRepositoryInput;
    runId: string;
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

    try {
      started = await this.startAttempt({
        attemptId,
        attemptNumber: input.attemptNumber,
        isContinuation: input.isContinuation,
        issue: input.issue,
        project: input.project,
        providerCommand: input.providerCommand,
        providerName: input.providerName,
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
      const terminal = classifyFailure({
        cancelRequested,
        ...(caughtError === undefined ? {} : { error: caughtError }),
        events: runtime.events
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
      this.runStore.updateRunState(input.runId, outcomeState);

      const willRetry =
        terminal.kind === "failed" &&
        terminal.classification === "transient" &&
        this.runStore.runRetryCount(input.runId) < this.lifecyclePolicy.retry.cap;

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
          issue: input.issue,
          outcome: terminal,
          project: input.project,
          repository: input.repository,
          runId: input.runId,
          runtimeAttemptNumber: input.attemptNumber
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
    isContinuation: boolean;
    attemptNumber: number;
    issue: IssueSnapshot;
    project: RunControllerProjectConfig;
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

    const workflowPath = path.resolve(this.configDir, input.project.workflow);
    const workflow = await loadWorkflowContract(workflowPath);
    if (workflow.errors.length > 0) {
      throw new Error(workflow.errors.join("\n"));
    }

    const promptInput = {
      branch: {
        name: prepared.branchName,
        ref: prepared.branchRef
      },
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
      template: workflow.body,
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
    // Add sym:failed; only on success remove sym:claimed. If either write
    // fails, the issue retains sym:claimed and stays out of dispatch —
    // matching pre-#59 safe-on-partial-failure behavior. Full success leaves
    // the issue with sym:failed alone, so the next reconcile sweep cannot
    // layer sym:stale on top.
    try {
      await api.addLabelsToIssue({
        ...input.repository,
        issueNumber: input.issueNumber,
        labels: ["sym:failed"]
      });
    } catch {
      return;
    }
    await this.bestEffort(() =>
      api.removeLabelsFromIssue({
        ...input.repository,
        issueNumber: input.issueNumber,
        labels: ["sym:claimed"]
      })
    );
  }

  private async applyTerminalLabels(input: ApplyLabelsInput): Promise<void> {
    const api = this.githubIssuesApi as LabelWritingGitHubIssuesApi;
    if (input.outcome.kind === "cancelled") {
      const reason = input.cancelReason;
      await this.bestEffort(() =>
        api.removeLabelsFromIssue({
          ...input.repository,
          issueNumber: input.issueNumber,
          labels: ["sym:running"]
        })
      );
      if (reason === CANCEL_REASONS.CLOSED_ISSUE) {
        await this.bestEffort(() =>
          api.removeLabelsFromIssue({
            ...input.repository,
            issueNumber: input.issueNumber,
            labels: ["sym:claimed"]
          })
        );
        await this.bestEffort(() =>
          api.removeLabelsFromIssue({
            ...input.repository,
            issueNumber: input.issueNumber,
            labels: ["sym:failed"]
          })
        );
      }
      return;
    }

    await this.bestEffort(() =>
      api.removeLabelsFromIssue({
        ...input.repository,
        issueNumber: input.issueNumber,
        labels: ["sym:running"]
      })
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
    issue: IssueSnapshot;
    outcome: ClassifiedTerminal;
    project: RunControllerProjectConfig;
    repository: GitHubIssueRepositoryInput;
    runId: string;
    runtimeAttemptNumber: number;
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
      const capId = this.createRunId();
      this.runStore.createCapReachedFailureRun({
        id: capId,
        issue: refreshed,
        parentRunId: input.runId,
        projectName: input.project.name,
        reason: "continuation cap reached"
      });
      await this.markIssueFailed({
        issueNumber: input.issue.number,
        repository: input.repository
      });
      return;
    }

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

  private async bestEffort(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch {
      // best-effort: swallow.
    }
  }
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
