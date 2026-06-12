import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";
import type { AgentProvider, ProviderEvent, ProviderRunInput } from "../src/provider.js";
import type { PreparedRoutineWorkspace } from "../src/routines/workspace.js";

const tempRoots: string[] = [];

type RoutineApiRow = {
  lastFiredAt: string | null;
  name: string;
  nextFireAt: string | null;
  projectName: string;
  state: string;
};

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-routine-daemon-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("daemon routine firing", () => {
  it("fires a one-shot kind: report routine once after the scheduled time", async () => {
    const root = await makeTempRoot();
    const fireAt = new Date(Date.now() + 50).toISOString();
    const workspacePath = path.join(
      root,
      ".symphonika",
      "workspaces",
      "alpha",
      "routines",
      "daily-report",
      "routine-fire-1"
    );
    await writeRoutineProject(root, fireAt);
    const providerInputs: ProviderRunInput[] = [];
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (
        input: ProviderRunInput
      ): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        providerInputs.push(input);
        yield {
          normalized: { sessionId: "routine-session", type: "session_started" },
          raw: { id: "routine-session" }
        };
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const prepareRoutineWorkspace = vi.fn(
      (): Promise<PreparedRoutineWorkspace> =>
        Promise.resolve({
          branchName: "main",
          branchRef: "refs/remotes/origin/main",
          cachePath: path.join(root, ".cache", "repo.git"),
          reused: false,
          workspacePath
        })
    );

    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRoutineFiringId: () => "routine-fire-1",
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi: {
        addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
        listOpenIssues: vi.fn().mockResolvedValue([]),
        removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
      },
      logger: pino({ enabled: false }),
      port: 0,
      prepareRoutineWorkspace
    });

    try {
      const routines = await waitForRoutine(daemon.url, "expired");
      expect(routines).toHaveLength(1);
      const routine = routines[0];
      expect(routine?.lastFiredAt).toEqual(expect.any(String));
      expect(routine).toMatchObject({
        name: "daily-report",
        nextFireAt: null,
        projectName: "alpha",
        state: "expired"
      });
      const status = (await fetch(`${daemon.url}/api/status`).then((response) =>
        response.json()
      )) as { routines?: RoutineApiRow[] };
      expect(status.routines).toEqual(routines);
      await waitForProviderInputs(providerInputs, 1);
      expect(providerInputs).toHaveLength(1);
      expect(providerInputs[0]?.prompt).toContain("Routine daily-report for alpha.");
      await new Promise((resolve) => setTimeout(resolve, 120));
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
      expect(providerInputs).toHaveLength(1);
    } finally {
      await daemon.stop();
    }
  });
});

async function writeRoutineProject(root: string, fireAt: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "WORKFLOW.md"), "Work on {{issue.title}}.\n");
  await writeFile(
    path.join(root, "daily-report.md"),
    [
      "---",
      "name: daily-report",
      "schedule:",
      `  at: ${fireAt}`,
      "kind: report",
      "---",
      "Routine {{routine.name}} for {{project.name}}.",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      "  interval_ms: 25",
      "providers:",
      "  codex:",
      '    command: "codex fake"',
      "  claude:",
      '    command: "claude fake"',
      "projects:",
      "  - name: alpha",
      "    disabled: false",
      "    tracker:",
      "      kind: github",
      "      owner: pmatos",
      "      repo: alpha",
      '      token: "$GITHUB_TOKEN"',
      "    issue_filters:",
      '      states: ["open"]',
      '      labels_all: ["agent-ready"]',
      '      labels_none: ["blocked"]',
      "    priority:",
      "      labels: {}",
      "      default: 99",
      "    workspace:",
      "      root: ./.symphonika/workspaces/alpha",
      "      git:",
      "        remote: git@github.com:pmatos/alpha.git",
      "        base_branch: main",
      "    agent:",
      "      provider: codex",
      "    workflow: ./WORKFLOW.md",
      "    routines:",
      "      - ./daily-report.md",
      ""
    ].join("\n")
  );
}

async function waitForProviderInputs(
  inputs: ProviderRunInput[],
  count: number
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (inputs.length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`provider did not receive ${count} input(s)`);
}

async function waitForRoutine(
  baseUrl: string,
  state: string
): Promise<RoutineApiRow[]> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const body = (await fetch(`${baseUrl}/api/routines`).then((response) =>
      response.json()
    )) as { routines: RoutineApiRow[] };
    if (body.routines.some((routine) => routine.state === state)) {
      return body.routines;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`routine did not reach ${state}`);
}
