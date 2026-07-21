import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { stringify } from "yaml";

import { defaultUserConfigPath, defaultUserStateRoot } from "./config-paths.js";

export type InitProvider = "codex" | "claude";

type InitPromptInput = {
  defaultValue: string;
  key:
    | "claudeCommand"
    | "codexCommand"
    | "mergeEnabled"
    | "mergeMethod"
    | "pollingIntervalMs"
    | "requireReviewDecision"
    | "requireStatusSuccess"
    | "stateRoot";
  message: string;
};

type InitPrompt = (input: InitPromptInput) => Promise<string>;

export type InitOptions = {
  env?: NodeJS.ProcessEnv;
  force?: boolean;
  homeDir?: string;
  prompt?: InitPrompt;
  yes?: boolean;
};

export type InitReport = {
  configPath: string;
  createdConfig: boolean;
  errors: string[];
  ok: boolean;
  stateRoot: string;
};

type GitHubRemote = {
  owner: string;
  repo: string;
};

export type GitHubProjectMetadata = GitHubRemote & {
  baseBranch: string;
  projectName: string;
  projectRoot: string;
  remote: string;
};

const execFile = promisify(execFileCallback);

const DEFAULT_CODEX_COMMAND =
  "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server";
const DEFAULT_CLAUDE_COMMAND =
  "claude -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json";

type GlobalInitSettings = {
  claudeCommand: string;
  codexCommand: string;
  mergeEnabled: boolean;
  mergeMethod: "merge" | "rebase" | "squash";
  pollingIntervalMs: number;
  requireReviewDecision: boolean;
  requireStatusSuccess: boolean;
  stateRoot: string;
};

export async function runInit(options: InitOptions = {}): Promise<InitReport> {
  const env = options.env ?? process.env;
  const userPathOptions = {
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    env
  };
  const configPath = defaultUserConfigPath(userPathOptions);
  const defaultStateRoot = defaultUserStateRoot(userPathOptions);
  let stateRoot = defaultStateRoot;
  const errors: string[] = [];
  const baseReport = (overrides: Partial<InitReport> = {}): InitReport => ({
    configPath,
    createdConfig: false,
    errors,
    ok: false,
    stateRoot,
    ...overrides
  });

  if (options.force !== true && (await fileExists(configPath))) {
    errors.push(
      `user service config already exists at ${configPath}; pass --force to overwrite it`
    );
    return baseReport();
  }

  let settings: GlobalInitSettings;
  try {
    settings = await collectGlobalSettings({
      defaultStateRoot,
      ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
      yes: options.yes === true
    });
  } catch (error) {
    errors.push(errorMessage(error));
    return baseReport();
  }
  stateRoot = settings.stateRoot;
  const config = buildServiceConfig(settings);

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, stringify(config), "utf8");

  return baseReport({
    createdConfig: true,
    ok: true
  });
}

function buildServiceConfig(settings: GlobalInitSettings): unknown {
  return {
    state: {
      root: settings.stateRoot
    },
    polling: {
      interval_ms: settings.pollingIntervalMs
    },
    pull_requests: {
      enabled: true,
      review_followup: {
        max_dispatches_per_pr: 3
      },
      merge: {
        enabled: settings.mergeEnabled,
        method: settings.mergeMethod,
        require_review_decision: settings.requireReviewDecision,
        require_status_success: settings.requireStatusSuccess
      }
    },
    providers: {
      codex: {
        command: settings.codexCommand
      },
      claude: {
        command: settings.claudeCommand
      }
    },
    projects: []
  };
}

async function collectGlobalSettings(input: {
  defaultStateRoot: string;
  prompt?: InitPrompt;
  yes: boolean;
}): Promise<GlobalInitSettings> {
  const defaults = {
    claudeCommand: DEFAULT_CLAUDE_COMMAND,
    codexCommand: DEFAULT_CODEX_COMMAND,
    mergeEnabled: "no",
    mergeMethod: "squash",
    pollingIntervalMs: "30000",
    requireReviewDecision: "no",
    requireStatusSuccess: "yes",
    stateRoot: input.defaultStateRoot
  } as const;
  const promptController = createPromptController(input.prompt, input.yes);

  try {
    const stateRoot = await promptController.ask({
      defaultValue: defaults.stateRoot,
      key: "stateRoot",
      message: "State root"
    });
    const pollingIntervalMs = positiveInteger(
      await promptController.ask({
        defaultValue: defaults.pollingIntervalMs,
        key: "pollingIntervalMs",
        message: "Polling interval (ms)"
      }),
      "polling interval"
    );
    const mergeEnabled = parseBooleanAnswer(
      await promptController.ask({
        defaultValue: defaults.mergeEnabled,
        key: "mergeEnabled",
        message: "Enable automatic pull-request merging"
      }),
      "automatic pull-request merging"
    );
    const mergeMethod = parseMergeMethod(
      await promptController.ask({
        defaultValue: defaults.mergeMethod,
        key: "mergeMethod",
        message: "Pull-request merge method (squash, merge, or rebase)"
      })
    );
    const requireStatusSuccess = parseBooleanAnswer(
      await promptController.ask({
        defaultValue: defaults.requireStatusSuccess,
        key: "requireStatusSuccess",
        message: "Require successful status checks before merge"
      }),
      "status-check requirement"
    );
    const requireReviewDecision = parseBooleanAnswer(
      await promptController.ask({
        defaultValue: defaults.requireReviewDecision,
        key: "requireReviewDecision",
        message: "Require an approving review before merge"
      }),
      "review requirement"
    );
    const codexCommand = await promptController.ask({
      defaultValue: defaults.codexCommand,
      key: "codexCommand",
      message: "Codex command"
    });
    const claudeCommand = await promptController.ask({
      defaultValue: defaults.claudeCommand,
      key: "claudeCommand",
      message: "Claude command"
    });

    for (const [label, value] of [
      ["state root", stateRoot],
      ["Codex command", codexCommand],
      ["Claude command", claudeCommand]
    ] as const) {
      if (value.trim().length === 0) {
        throw new Error(`${label} must not be empty`);
      }
    }

    return {
      claudeCommand,
      codexCommand,
      mergeEnabled,
      mergeMethod,
      pollingIntervalMs,
      requireReviewDecision,
      requireStatusSuccess,
      stateRoot
    };
  } finally {
    promptController.close();
  }
}

function createPromptController(
  injectedPrompt: InitPrompt | undefined,
  yes: boolean
): { ask: InitPrompt; close: () => void } {
  if (yes) {
    return {
      ask: (input) => Promise.resolve(input.defaultValue),
      close: () => undefined
    };
  }

  if (injectedPrompt !== undefined) {
    return {
      ask: async (input) => {
        const answer = await injectedPrompt(input);
        return answer.trim().length === 0 ? input.defaultValue : answer.trim();
      },
      close: () => undefined
    };
  }

  const readline = createInterface({ input: stdin, output: stdout });
  return {
    ask: async (input) => {
      const answer = await readline.question(
        `${input.message} [${input.defaultValue}]: `
      );
      return answer.trim().length === 0 ? input.defaultValue : answer.trim();
    },
    close: () => readline.close()
  };
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseBooleanAnswer(value: string, label: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["y", "yes", "true"].includes(normalized)) {
    return true;
  }
  if (["n", "no", "false"].includes(normalized)) {
    return false;
  }
  throw new Error(`${label} must be yes or no`);
}

function parseMergeMethod(value: string): GlobalInitSettings["mergeMethod"] {
  if (value === "squash" || value === "merge" || value === "rebase") {
    return value;
  }
  throw new Error("merge method must be one of squash, merge, rebase");
}

async function detectBaseBranch(projectRoot: string): Promise<string> {
  try {
    const upstreamHead = await gitOutput(
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      projectRoot
    );
    const prefix = "origin/";
    if (
      upstreamHead.startsWith(prefix) &&
      upstreamHead.length > prefix.length
    ) {
      return upstreamHead.slice(prefix.length);
    }
  } catch {
    // A newly initialized repository often has no origin/HEAD until fetch.
  }

  try {
    const currentBranch = await gitOutput(
      ["branch", "--show-current"],
      projectRoot
    );
    if (currentBranch.length > 0) {
      return currentBranch;
    }
  } catch {
    // Fall through to the conventional default.
  }

  return "main";
}

export async function inspectCurrentGitHubProject(
  cwd: string
): Promise<GitHubProjectMetadata> {
  let projectRoot: string;
  let remote: string;
  let baseBranch: string;
  try {
    projectRoot = await gitOutput(["rev-parse", "--show-toplevel"], cwd);
    remote = await gitOutput(["remote", "get-url", "origin"], projectRoot);
    baseBranch = await detectBaseBranch(projectRoot);
  } catch (error) {
    throw new Error(
      `symphonika init-project must run inside a Git repository with an origin remote: ${errorMessage(error)}`,
      { cause: error }
    );
  }

  const parsedRemote = parseGitHubRemote(remote);
  if (parsedRemote === null) {
    throw new Error(
      `origin remote must point at github.com for automatic Project initialization; found ${remote}`
    );
  }

  return {
    ...parsedRemote,
    baseBranch,
    projectName: sanitizeProjectName(parsedRemote.repo),
    projectRoot,
    remote
  };
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout.trim();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseGitHubRemote(remote: string): GitHubRemote | null {
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
  if (ssh !== null) {
    const owner = ssh[1];
    const repo = ssh[2];
    if (owner === undefined || repo === undefined) {
      return null;
    }
    return { owner, repo };
  }

  try {
    const parsed = new URL(remote);
    if (parsed.hostname !== "github.com") {
      return null;
    }
    const parts = parsed.pathname.replace(/^\/+/, "").split("/");
    const owner = parts[0];
    const repo = parts[1];
    if (
      owner === undefined ||
      repo === undefined ||
      owner.length === 0 ||
      repo.length === 0
    ) {
      return null;
    }
    return {
      owner,
      repo: repo.replace(/\.git$/, "")
    };
  } catch {
    return null;
  }
}

function sanitizeProjectName(repo: string): string {
  const sanitized = repo
    .replace(/\.git$/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-");
  return sanitized.replace(/^-+|-+$/g, "") || "project";
}

export function defaultWorkflowContract(): string {
  return [
    "# Implementing issue #{{issue.number}}: {{issue.title}}",
    "",
    "## Issue",
    "",
    "{{issue.body}}",
    "",
    "## Workspace",
    "",
    "Work in {{workspace.path}} on branch {{branch.name}}.",
    "",
    "## What to do",
    "",
    "1. Read the issue and inspect the relevant code before editing.",
    "2. Implement a small, focused change with behavior-focused tests.",
    "3. Run the local quality gate.",
    "4. Commit, push {{branch.name}}, and open a non-draft pull request with the local `gh` CLI.",
    "5. Remove the issue's `agent-ready` label after the PR is open.",
    "6. If the work cannot proceed, leave a `gh issue comment` describing what blocked it and exit cleanly.",
    "",
    "## Constraints",
    "",
    "- **You are running unattended.** No operator will respond to prompts, approve tool calls, or read intermediate output during this run.",
    "- **Use the local `gh` CLI for every GitHub mutation** (`gh issue ...`, `gh pr ...`, `gh issue comment ...`, `gh issue edit ...`). Do not call GitHub MCP connector tools (for example `add_issue_labels`, `create_pull_request`); they elicit operator approval through the provider transport and end the run as `input_required`.",
    "- **Do not self-apply `needs-human` or any other handoff label as an exit strategy.** Use the comment-and-exit path in step 6; the operator owns label triage.",
    ""
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
