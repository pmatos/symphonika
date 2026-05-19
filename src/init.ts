import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";

import {
  defaultUserConfigPath,
  defaultUserStateRoot
} from "./config-paths.js";

export type InitProvider = "codex" | "claude";

export type InitOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  force?: boolean;
  homeDir?: string;
  provider?: InitProvider;
};

export type InitReport = {
  configPath: string;
  createdConfig: boolean;
  createdWorkflow: boolean;
  errors: string[];
  ok: boolean;
  projectName: string | null;
  repository: string | null;
  stateRoot: string;
  workflowPath: string | null;
};

type GitHubRemote = {
  owner: string;
  repo: string;
};

const execFile = promisify(execFileCallback);

const DEFAULT_CODEX_COMMAND =
  "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server";
const DEFAULT_CLAUDE_COMMAND =
  "claude -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json";

export async function runInit(options: InitOptions = {}): Promise<InitReport> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const provider = options.provider ?? "codex";
  const userPathOptions = {
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    env
  };
  const configPath = defaultUserConfigPath(userPathOptions);
  const stateRoot = defaultUserStateRoot(userPathOptions);
  const errors: string[] = [];
  const baseReport = (
    overrides: Partial<InitReport> = {}
  ): InitReport => ({
    configPath,
    createdConfig: false,
    createdWorkflow: false,
    errors,
    ok: false,
    projectName: null,
    repository: null,
    stateRoot,
    workflowPath: null,
    ...overrides
  });

  if (provider !== "codex" && provider !== "claude") {
    errors.push("provider must be one of codex, claude");
    return baseReport();
  }

  if (options.force !== true && (await fileExists(configPath))) {
    errors.push(
      `user service config already exists at ${configPath}; pass --force to overwrite it`
    );
    return baseReport();
  }

  let projectRoot: string;
  let remoteUrl: string;
  let baseBranch: string;
  try {
    projectRoot = await gitOutput(["rev-parse", "--show-toplevel"], cwd);
    remoteUrl = await gitOutput(["remote", "get-url", "origin"], projectRoot);
    baseBranch = await detectBaseBranch(projectRoot);
  } catch (error) {
    errors.push(
      `symphonika init must run inside a Git repository with an origin remote: ${errorMessage(error)}`
    );
    return baseReport();
  }

  const parsedRemote = parseGitHubRemote(remoteUrl);
  if (parsedRemote === null) {
    errors.push(
      `origin remote must point at github.com for automatic init; found ${remoteUrl}`
    );
    return baseReport();
  }

  const projectName = sanitizeProjectName(parsedRemote.repo);
  const workflowPath = path.join(projectRoot, "WORKFLOW.md");
  const config = buildServiceConfig({
    baseBranch,
    projectName,
    provider,
    remote: remoteUrl,
    stateRoot,
    workflowPath,
    ...parsedRemote
  });

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, stringify(config), "utf8");

  let createdWorkflow = false;
  if (!(await fileExists(workflowPath))) {
    await writeFile(workflowPath, defaultWorkflowContract(), "utf8");
    createdWorkflow = true;
  }

  return baseReport({
    createdConfig: true,
    createdWorkflow,
    ok: true,
    projectName,
    repository: `${parsedRemote.owner}/${parsedRemote.repo}`,
    workflowPath
  });
}

function buildServiceConfig(input: {
  baseBranch: string;
  owner: string;
  projectName: string;
  provider: InitProvider;
  remote: string;
  repo: string;
  stateRoot: string;
  workflowPath: string;
}): unknown {
  return {
    state: {
      root: input.stateRoot
    },
    polling: {
      interval_ms: 30000
    },
    pull_requests: {
      enabled: true,
      review_followup: {
        max_dispatches_per_pr: 3
      },
      merge: {
        enabled: false,
        method: "squash",
        require_review_decision: false,
        require_status_success: true
      }
    },
    providers: {
      codex: {
        command: DEFAULT_CODEX_COMMAND
      },
      claude: {
        command: DEFAULT_CLAUDE_COMMAND
      }
    },
    projects: [
      {
        name: input.projectName,
        disabled: false,
        weight: 1,
        tracker: {
          kind: "github",
          owner: input.owner,
          repo: input.repo,
          token: "$GITHUB_TOKEN"
        },
        issue_filters: {
          states: ["open"],
          labels_all: ["agent-ready"],
          labels_none: ["blocked", "needs-human", "sym:stale"]
        },
        priority: {
          labels: {
            "priority:critical": 0,
            "priority:high": 1,
            "priority:medium": 2,
            "priority:low": 3
          },
          default: 99
        },
        workspace: {
          root: path.join(input.stateRoot, "workspaces", input.projectName),
          git: {
            remote: input.remote,
            base_branch: input.baseBranch
          }
        },
        agent: {
          provider: input.provider
        },
        workflow: input.workflowPath
      }
    ]
  };
}

async function detectBaseBranch(projectRoot: string): Promise<string> {
  try {
    const upstreamHead = await gitOutput(
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      projectRoot
    );
    const prefix = "origin/";
    if (upstreamHead.startsWith(prefix) && upstreamHead.length > prefix.length) {
      return upstreamHead.slice(prefix.length);
    }
  } catch {
    // A newly initialized repository often has no origin/HEAD until fetch.
  }

  try {
    const currentBranch = await gitOutput(["branch", "--show-current"], projectRoot);
    if (currentBranch.length > 0) {
      return currentBranch;
    }
  } catch {
    // Fall through to the conventional default.
  }

  return "main";
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
    if (owner === undefined || repo === undefined || owner.length === 0 || repo.length === 0) {
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
  const sanitized = repo.replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]+/g, "-");
  return sanitized.replace(/^-+|-+$/g, "") || "project";
}

function defaultWorkflowContract(): string {
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
