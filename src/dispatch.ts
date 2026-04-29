import { randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

import type {
  GitHubIssueLabelInput,
  GitHubIssueRepositoryInput,
  GitHubIssuesApi,
  IssuePollStatus,
  IssueSnapshot,
  ProjectIssueSnapshot
} from "./issue-polling.js";
import type {
  AgentProvider,
  AgentProviderName,
  AgentProviderRegistry,
  NormalizedProviderEvent,
  ProviderEvent
} from "./provider.js";
import type { RunState, RunStore } from "./run-store.js";
import type {
  PreparedIssueWorkspace,
  PrepareIssueWorkspaceInput
} from "./workspace.js";
import { prepareIssueWorkspace as prepareRealIssueWorkspace } from "./workspace.js";
import {
  loadWorkflowContract,
  persistRunEvidence,
  renderAutonomousPrompt
} from "./workflow.js";

export type LabelWritingGitHubIssuesApi = GitHubIssuesApi & {
  addLabelsToIssue: (input: GitHubIssueLabelInput) => Promise<void>;
  removeLabelsFromIssue: (input: GitHubIssueLabelInput) => Promise<void>;
};

export type DispatchIssueOptions = {
  agentProviders: AgentProviderRegistry;
  configDir: string;
  configPath: string;
  createRunId?: () => string;
  env?: NodeJS.ProcessEnv;
  githubIssuesApi: GitHubIssuesApi;
  issuePollStatus: IssuePollStatus;
  prepareIssueWorkspace?: (
    input: PrepareIssueWorkspaceInput
  ) => Promise<PreparedIssueWorkspace>;
  runStore: RunStore;
  stateRoot: string;
};

export type DispatchIssueResult =
  | {
      dispatched: false;
      reason: string;
    }
  | {
      dispatched: true;
      runId: string;
    };

type DispatchServiceConfig = z.infer<typeof dispatchServiceConfigSchema>;
type DispatchProjectConfig = z.infer<typeof dispatchProjectSchema>;

const providerNameSchema = z.enum(["codex", "claude"]);
const providerCommandSchema = z
  .object({
    command: z.string().trim().min(1)
  })
  .passthrough();

const dispatchProjectSchema = z
  .object({
    name: z.string().trim().min(1),
    disabled: z.boolean().optional(),
    tracker: z
      .object({
        kind: z.literal("github"),
        owner: z.string().trim().min(1),
        repo: z.string().trim().min(1),
        token: z.string().trim().min(1)
      })
      .passthrough(),
    workspace: z
      .object({
        root: z.string().trim().min(1),
        git: z
          .object({
            remote: z.string().trim().min(1),
            base_branch: z.string().trim().min(1)
          })
          .passthrough()
      })
      .passthrough(),
    agent: z
      .object({
        provider: providerNameSchema
      })
      .passthrough(),
    workflow: z.string().trim().min(1)
  })
  .passthrough();

const dispatchServiceConfigSchema = z
  .object({
    providers: z
      .object({
        codex: providerCommandSchema,
        claude: providerCommandSchema
      })
      .passthrough(),
    projects: z.array(dispatchProjectSchema).min(1)
  })
  .passthrough();

export async function dispatchOneEligibleIssue(
  options: DispatchIssueOptions
): Promise<DispatchIssueResult> {
  const config = await readDispatchConfig(options.configPath);
  const target = dispatchTarget(config, options.issuePollStatus, options.agentProviders);

  if (target === undefined) {
    return {
      dispatched: false,
      reason: "no eligible issue has a registered provider"
    };
  }

  if (!isLabelWritingGitHubIssuesApi(options.githubIssuesApi)) {
    return {
      dispatched: false,
      reason: "GitHub tracker does not support operational label writes"
    };
  }

  const token = resolveEnvBackedValue(
    target.project.tracker.token,
    options.env ?? process.env
  );
  if (token === undefined) {
    return {
      dispatched: false,
      reason: `projects.${target.project.name}.tracker.token is not available`
    };
  }

  const providerName = target.project.agent.provider;
  const provider = target.provider;
  const providerCommand = config.providers[providerName].command;
  const runId = options.createRunId?.() ?? randomUUID();
  const attemptId = `${runId}-attempt-1`;
  const issue = target.candidate.issue;
  const repository = {
    owner: target.project.tracker.owner,
    repo: target.project.tracker.repo,
    token
  };

  let runCreated = false;
  let attemptCreated = false;
  let claimed = false;
  let running = false;

  try {
    await options.githubIssuesApi.addLabelsToIssue({
      ...repository,
      issueNumber: issue.number,
      labels: ["sym:claimed"]
    });
    claimed = true;
    options.runStore.createRun({
      id: runId,
      issue,
      projectName: target.project.name,
      providerCommand,
      providerName
    });
    runCreated = true;
    options.runStore.updateRunState(runId, "preparing_workspace");
    const prepared = await (options.prepareIssueWorkspace ?? prepareRealIssueWorkspace)({
      configDir: options.configDir,
      issue: {
        number: issue.number,
        title: issue.title
      },
      project: target.project
    });
    const promptInput = await buildPromptInput({
      configDir: options.configDir,
      issue,
      prepared,
      project: target.project,
      providerCommand,
      providerName,
      runId
    });
    const renderedPrompt = renderAutonomousPrompt(promptInput);
    const evidence = await persistRunEvidence({
      ...promptInput,
      renderedPrompt,
      stateRoot: options.stateRoot
    });
    const rawLogPath = path.join(
      evidence.runEvidenceDirectory,
      "provider.raw.jsonl"
    );
    const normalizedLogPath = path.join(
      evidence.runEvidenceDirectory,
      "provider.normalized.jsonl"
    );

    await Promise.all([
      writeFile(rawLogPath, "", "utf8"),
      writeFile(normalizedLogPath, "", "utf8")
    ]);
    const runEvidence = {
      branchName: prepared.branchName,
      branchRef: prepared.branchRef,
      issueSnapshotPath: evidence.issueSnapshotPath,
      metadataPath: evidence.metadataPath,
      normalizedLogPath,
      promptPath: evidence.promptPath,
      rawLogPath,
      workspacePath: prepared.workspacePath
    };
    options.runStore.updateRunEvidence(runId, runEvidence);

    await provider.validate(providerCommand);
    await options.githubIssuesApi.addLabelsToIssue({
      ...repository,
      issueNumber: issue.number,
      labels: ["sym:running"]
    });
    running = true;
    options.runStore.updateRunState(runId, "running");
    options.runStore.createAttempt({
      ...runEvidence,
      attemptNumber: 1,
      id: attemptId,
      providerCommand,
      providerName,
      runId,
      state: "running"
    });
    attemptCreated = true;
    const finalState = await runProviderAttempt({
      attemptId,
      branchName: prepared.branchName,
      issue,
      normalizedLogPath,
      prompt: renderedPrompt.prompt,
      promptPath: evidence.promptPath,
      provider,
      providerCommand,
      providerName,
      rawLogPath,
      runId,
      runStore: options.runStore,
      workspacePath: prepared.workspacePath
    });

    options.runStore.updateAttemptState(attemptId, finalState);
    options.runStore.updateRunState(runId, finalState);
    await options.githubIssuesApi.removeLabelsFromIssue({
      ...repository,
      issueNumber: issue.number,
      labels: ["sym:running"]
    });
    if (finalState === "failed" || finalState === "input_required") {
      await options.githubIssuesApi.addLabelsToIssue({
        ...repository,
        issueNumber: issue.number,
        labels: ["sym:failed"]
      });
    }

    return {
      dispatched: true,
      runId
    };
  } catch (error) {
    if (attemptCreated) {
      options.runStore.updateAttemptState(attemptId, "failed");
    }
    if (runCreated) {
      options.runStore.updateRunState(runId, "failed");
    }
    if (running) {
      await bestEffortRemoveRunningLabel(
        options.githubIssuesApi,
        repository,
        issue.number
      );
    }
    if (claimed) {
      await bestEffortAddFailedLabel(
        options.githubIssuesApi,
        repository,
        issue.number
      );
    }
    throw error;
  }
}

async function buildPromptInput(input: {
  configDir: string;
  issue: IssueSnapshot;
  prepared: PreparedIssueWorkspace;
  project: DispatchProjectConfig;
  providerCommand: string;
  providerName: AgentProviderName;
  runId: string;
}): Promise<Parameters<typeof renderAutonomousPrompt>[0]> {
  const workflowPath = path.resolve(input.configDir, input.project.workflow);
  const workflow = await loadWorkflowContract(workflowPath);
  if (workflow.errors.length > 0) {
    throw new Error(workflow.errors.join("\n"));
  }

  return {
    branch: {
      name: input.prepared.branchName,
      ref: input.prepared.branchRef
    },
    issue: input.issue,
    project: {
      name: input.project.name
    },
    provider: {
      command: input.providerCommand,
      name: input.providerName
    },
    run: {
      attempt: 1,
      continuation: false,
      id: input.runId
    },
    template: workflow.body,
    workflowContentHash: workflow.contentHash,
    workflowPath,
    workspace: {
      path: input.prepared.workspacePath,
      previous_attempt: input.prepared.reused,
      root: path.resolve(input.configDir, input.project.workspace.root)
    }
  };
}

async function runProviderAttempt(input: {
  attemptId: string;
  branchName: string;
  issue: IssueSnapshot;
  normalizedLogPath: string;
  prompt: string;
  promptPath: string;
  provider: AgentProvider;
  providerCommand: string;
  providerName: AgentProviderName;
  rawLogPath: string;
  runId: string;
  runStore: RunStore;
  workspacePath: string;
}): Promise<RunState> {
  let finalState: RunState = "succeeded";
  let sequence = 0;

  for await (const event of input.provider.runAttempt({
    branchName: input.branchName,
    issue: input.issue,
    prompt: input.prompt,
    promptPath: input.promptPath,
    provider: {
      command: input.providerCommand,
      name: input.providerName
    },
    run: {
      attempt: 1,
      id: input.runId
    },
    workspacePath: input.workspacePath
  })) {
    sequence += 1;
    await persistProviderEvent({
      attemptId: input.attemptId,
      event,
      normalizedLogPath: input.normalizedLogPath,
      rawLogPath: input.rawLogPath,
      runId: input.runId,
      runStore: input.runStore,
      sequence
    });
    if (event.normalized !== undefined) {
      finalState = terminalStateAfterEvent(finalState, event.normalized);
    }
  }

  return finalState;
}

async function persistProviderEvent(input: {
  attemptId: string;
  event: ProviderEvent;
  normalizedLogPath: string;
  rawLogPath: string;
  runId: string;
  runStore: RunStore;
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

  input.runStore.recordProviderEvent({
    attemptId: input.attemptId,
    normalized: input.event.normalized,
    raw: input.event.raw,
    runId: input.runId,
    sequence: input.sequence
  });
}

function terminalStateAfterEvent(
  current: RunState,
  event: NormalizedProviderEvent
): RunState {
  if (current === "input_required" || current === "failed") {
    return current;
  }

  if (event.type === "input_required") {
    return "input_required";
  }

  if (event.type === "turn_failed" || event.type === "malformed_event") {
    return "failed";
  }

  if (event.type === "process_exit" && processExitFailed(event)) {
    return "failed";
  }

  return current;
}

function processExitFailed(event: NormalizedProviderEvent): boolean {
  const exitCode = event.exitCode;
  if (typeof exitCode === "number" && exitCode !== 0) {
    return true;
  }

  return typeof event.signal === "string" && event.cancelled !== true;
}

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function dispatchTarget(
  config: DispatchServiceConfig,
  issuePollStatus: IssuePollStatus,
  providers: AgentProviderRegistry
):
  | {
      candidate: ProjectIssueSnapshot;
      project: DispatchProjectConfig;
      provider: AgentProvider;
    }
  | undefined {
  for (const candidate of issuePollStatus.candidateIssues) {
    const project = config.projects.find(
      (entry) => entry.name === candidate.project && entry.disabled !== true
    );
    if (project === undefined) {
      continue;
    }

    const provider = providers[project.agent.provider];
    if (provider !== undefined) {
      return {
        candidate,
        project,
        provider
      };
    }
  }

  return undefined;
}

async function readDispatchConfig(
  configPath: string
): Promise<DispatchServiceConfig> {
  const contents = await readFile(configPath, "utf8");
  const parsed = dispatchServiceConfigSchema.safeParse(parse(contents) ?? {});

  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) =>
          `${issue.path.length === 0 ? "service config" : issue.path.join(".")}: ${issue.message}`
        )
        .join("\n")
    );
  }

  return parsed.data;
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

function resolveEnvBackedValue(
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

function envReferenceName(input: string): string | undefined {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(input);
  return match?.[1];
}

async function bestEffortRemoveRunningLabel(
  api: LabelWritingGitHubIssuesApi,
  repository: GitHubIssueRepositoryInput,
  issueNumber: number
): Promise<void> {
  try {
    await api.removeLabelsFromIssue({
      ...repository,
      issueNumber,
      labels: ["sym:running"]
    });
  } catch {
    // Preserve the original failure; reconciliation will surface stale labels later.
  }
}

async function bestEffortAddFailedLabel(
  api: LabelWritingGitHubIssuesApi,
  repository: GitHubIssueRepositoryInput,
  issueNumber: number
): Promise<void> {
  try {
    await api.addLabelsToIssue({
      ...repository,
      issueNumber,
      labels: ["sym:failed"]
    });
  } catch {
    // Preserve the original failure; the run store remains the durable failure record.
  }
}
