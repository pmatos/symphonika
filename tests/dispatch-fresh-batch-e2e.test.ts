import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";
import type { AgentProvider, ProviderEvent } from "../src/provider.js";
import type {
  PreparedIssueWorkspace,
  PrepareIssueWorkspaceInput
} from "../src/workspace.js";
import { createDeferred } from "./helpers/deferred.js";
import { createGitWorkspaceAhead } from "./helpers/git-workspace.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-fresh-batch-e2e-")
  );
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

// Per-project max_in_flight defaults to 1 (ADR 0053), so the config must
// raise both the project and global caps above the candidate count or the
// picker itself would refuse the 2nd/3rd claim regardless of this issue's fix.
async function writeProjectWithHigherCap(root: string): Promise<void> {
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      "  interval_ms: 30000",
      "global:",
      "  max_in_flight: 5",
      "providers:",
      "  codex:",
      `    command: "codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server"`,
      "  claude:",
      '    command: "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json"',
      "projects:",
      "  - name: symphonika",
      "    disabled: false",
      "    weight: 1",
      "    max_in_flight: 5",
      "    tracker:",
      "      kind: github",
      "      owner: pmatos",
      "      repo: symphonika",
      '      token: "$GITHUB_TOKEN"',
      "    issue_filters:",
      '      states: ["open"]',
      '      labels_all: ["agent-ready"]',
      '      labels_none: ["blocked", "needs-human"]',
      "    priority:",
      "      labels: {}",
      "      default: 99",
      "    workspace:",
      "      root: ./.symphonika/workspaces/symphonika",
      "      git:",
      "        remote: git@github.com:pmatos/symphonika.git",
      "        base_branch: main",
      "    agent:",
      "      provider: codex",
      "    workflow: ./WORKFLOW.md",
      ""
    ].join("\n")
  );
  await writeFile(
    path.join(root, "WORKFLOW.md"),
    ["Work on #{{issue.number}}: {{issue.title}}.", ""].join("\n")
  );
}

function issueFixture(overrides: { number: number; title: string }): {
  body: string;
  created_at: string;
  html_url: string;
  id: number;
  labels: unknown[];
  number: number;
  state: string;
  title: string;
  updated_at: string;
} {
  return {
    body: `${overrides.title} body.`,
    created_at: "2026-04-20T10:00:00Z",
    html_url: `https://github.com/pmatos/symphonika/issues/${overrides.number}`,
    id: 5000 + overrides.number,
    labels: ["agent-ready"],
    number: overrides.number,
    state: "open",
    title: overrides.title,
    updated_at: "2026-04-21T11:00:00Z"
  };
}

function preparedWorkspaceFor(
  root: string,
  issueNumber: number
): PreparedIssueWorkspace {
  const dirName = `${issueNumber}-fill-slots-issue`;
  return {
    branchName: `sym/symphonika/${dirName}`,
    branchRef: `refs/heads/sym/symphonika/${dirName}`,
    cachePath: path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      ".cache",
      "repo.git"
    ),
    issueDirectoryName: dirName,
    reused: false,
    workspacePath: path.join(
      root,
      ".symphonika",
      "workspaces",
      "symphonika",
      "issues",
      dirName
    )
  };
}

async function waitForCondition(
  url: string,
  predicate: (body: { runs: Array<Record<string, unknown>> }) => boolean,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<void> {
  const intervalMs = options.intervalMs ?? 10;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/status`);
    const body = (await response.json()) as {
      runs?: Array<Record<string, unknown>>;
    };
    if (body.runs !== undefined && predicate({ runs: body.runs })) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("condition not met before timeout");
}

describe("fill all available slots per tick (issue #720)", () => {
  it("claims all eligible candidates from a single poll tick, not one per tick", async () => {
    const root = await makeTempRoot();
    await writeProjectWithHigherCap(root);

    const issueNumbers = [1, 2, 3];
    for (const number of issueNumbers) {
      await createGitWorkspaceAhead(preparedWorkspaceFor(root, number));
    }

    // Gates every provider attempt until the test explicitly releases it, so
    // none of the 3 claimed runs can reach "succeeded" during the assertion
    // window below -- proving all 3 were claimed together within one tick,
    // not serialized one per tick the way dispatchOneFresh alone would.
    const gate = createDeferred<void>();
    const provider: AgentProvider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      async *runAttempt(): AsyncGenerator<ProviderEvent> {
        await gate.promise;
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      },
      validate: vi.fn().mockResolvedValue(undefined)
    };

    const githubIssuesApi = {
      addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
      listOpenIssues: vi
        .fn()
        .mockResolvedValue(
          issueNumbers.map((number) =>
            issueFixture({ number, title: `Fill slots issue ${number}` })
          )
        ),
      listPullRequestsForBranch: vi.fn().mockResolvedValue([]),
      removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined)
    };

    const prepareIssueWorkspace = vi.fn(
      (input: PrepareIssueWorkspaceInput): Promise<PreparedIssueWorkspace> =>
        Promise.resolve(preparedWorkspaceFor(root, input.issue.number))
    );

    let runCounter = 0;
    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRunId: () => `run-fill-slots-${++runCounter}`,
      cwd: root,
      env: { GITHUB_TOKEN: "secret-token" },
      githubIssuesApi,
      logger: pino({ enabled: false }),
      port: 0,
      prepareIssueWorkspace
    });

    try {
      const pollResponse = await fetch(`${daemon.url}/api/poll-now`, {
        method: "POST"
      });
      expect(pollResponse.status).toBe(200);

      // Each claim creates its Run row inside the mutex-guarded claim
      // section, before the (gated) provider ever runs -- so all 3 rows
      // existing is the signal that dispatchFresh's loop has finished
      // claiming, independent of the gated provider's own progress.
      await waitForCondition(daemon.url, ({ runs }) => runs.length >= 3);

      const claimCalls = githubIssuesApi.addLabelsToIssue.mock.calls.filter(
        (call) =>
          (call[0] as { labels: string[] }).labels.includes("sym:claimed")
      );
      const claimedIssueNumbers = new Set(
        claimCalls.map(
          (call) => (call[0] as { issueNumber: number }).issueNumber
        )
      );
      expect(claimedIssueNumbers).toEqual(new Set(issueNumbers));

      const status = (await (
        await fetch(`${daemon.url}/api/status`)
      ).json()) as {
        runs: Array<{ issueNumber: number; state: string }>;
      };
      const ourRuns = status.runs.filter((run) =>
        issueNumbers.includes(run.issueNumber)
      );
      expect(ourRuns).toHaveLength(3);
      // None reached "succeeded" -- they are all still in flight together,
      // which is only possible if this one tick claimed all 3 rather than
      // one per tick.
      expect(ourRuns.every((run) => run.state !== "succeeded")).toBe(true);
    } finally {
      gate.resolve();
      await daemon.stop();
    }
  });
});
