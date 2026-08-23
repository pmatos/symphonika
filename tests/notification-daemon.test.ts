import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDaemon } from "../src/daemon.js";
import type { NotificationMessage } from "../src/notifications/types.js";
import type { AgentProvider, ProviderEvent } from "../src/provider.js";
import { openRunStore } from "../src/run-store.js";
import type { PrepareRoutineWorkspaceInput } from "../src/routines/workspace.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("daemon notifications", () => {
  it("delivers a pending terminal issue Run through the daemon digest", async () => {
    const root = await makeTempRoot();
    await writeRoutineHostConfig(root, {
      emailLines: [
        "  digest_window_seconds: 1",
        "  sources:",
        "    routine_firings: false",
        "    issue_runs: true",
        "    daemon_health: false"
      ]
    });
    const store = openRunStore({ stateRoot: path.join(root, ".symphonika") });
    store.createRun({
      id: "run-terminal",
      issue: issueFixture(42),
      projectName: "alpha",
      providerCommand: "codex app-server",
      providerName: "codex"
    });
    store.recordTerminalReason(
      "run-terminal",
      "process_exit_1",
      "deterministic"
    );
    store.updateRunState("run-terminal", "failed");
    store.close();
    const deliver = vi.fn().mockResolvedValue(undefined);

    const daemon = await startDaemon({
      agentProviders: {},
      cwd: root,
      logger: pino({ enabled: false }),
      notificationSink: { deliver },
      port: 0
    });
    try {
      await waitFor(() => deliver.mock.calls.length === 1);
      expect(deliver.mock.calls[0]?.[0]).toMatchObject({
        subject: "[Symphonika] 1 terminal issue Run"
      });
    } finally {
      await daemon.stop();
    }
  });

  it("waits for in-flight Routine notifications before closing the Run Store", async () => {
    const root = await makeTempRoot();
    await writeFile(
      path.join(root, "daily-report.md"),
      [
        "---",
        "name: daily-report",
        "schedule:",
        "  at: 2026-08-20T10:00:00.000Z",
        "kind: report",
        "---",
        "Report.",
        ""
      ].join("\n")
    );
    await writeRoutineHostConfig(root, {
      emailLines: [
        "  sources:",
        "    routine_firings: true",
        "    routine_fanouts: false",
        "    issue_runs: false",
        "    daemon_health: false"
      ],
      serviceTailLines: [
        "routines:",
        "  - path: ./daily-report.md",
        "    projects: [alpha]"
      ]
    });
    let finishDelivery: (() => void) | undefined;
    const delivery = new Promise<void>((resolve) => {
      finishDelivery = resolve;
    });
    let markDeliveryStarted: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const provider = {
      cancel: vi.fn().mockResolvedValue(undefined),
      name: "codex",
      runAttempt: vi.fn(async function* (): AsyncGenerator<ProviderEvent> {
        await Promise.resolve();
        yield {
          normalized: { exitCode: 0, type: "process_exit" },
          raw: { code: 0, kind: "exit" }
        };
      }),
      validate: vi.fn().mockResolvedValue(undefined)
    } satisfies AgentProvider;
    const daemon = await startDaemon({
      agentProviders: { codex: provider },
      createRoutineFanoutId: () => "fanout-shutdown-drain",
      createRoutineFiringId: () => "fire-shutdown-drain",
      cwd: root,
      logger: pino({ enabled: false }),
      notificationSink: {
        async deliver() {
          markDeliveryStarted?.();
          await delivery;
        }
      },
      port: 0,
      prepareRoutineWorkspace: (input: PrepareRoutineWorkspaceInput) =>
        Promise.resolve({
          branchName: "main",
          branchRef: "refs/remotes/origin/main",
          cachePath: path.join(root, ".cache", "repo.git"),
          reused: false,
          workspacePath: path.join(root, input.firingId)
        })
    });
    let stopPromise: Promise<void> | undefined;

    try {
      await deliveryStarted;
      let stopped = false;
      stopPromise = daemon.stop().then(() => {
        stopped = true;
      });
      const stopState = await Promise.race([
        stopPromise.then(() => "settled" as const),
        new Promise<"pending">((resolve) => {
          setTimeout(() => resolve("pending"), 250);
        })
      ]);
      expect({ stopState, stopped }).toEqual({
        stopped: false,
        stopState: "pending"
      });

      finishDelivery?.();
      await stopPromise;
      const store = openRunStore({
        stateRoot: path.join(root, ".symphonika")
      });
      try {
        expect(store.getRoutineFiring("fire-shutdown-drain")).toMatchObject({
          notificationError: null,
          notificationState: "sent",
          state: "succeeded"
        });
      } finally {
        store.close();
      }
    } finally {
      finishDelivery?.();
      await (stopPromise ?? daemon.stop());
    }
  });

  it("sends one reload failure across ten broken ticks and one recovery", async () => {
    const root = await makeTempRoot();
    const emailLines = [
      "  sources:",
      "    routine_firings: false",
      "    issue_runs: false",
      "    daemon_health: true"
    ];
    await writeRoutineHostConfig(root, { emailLines });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const daemon = await startDaemon({
      agentProviders: {},
      cwd: root,
      logger: pino({ enabled: false }),
      notificationSink: { deliver },
      port: 0
    });
    try {
      await waitFor(() => deliver.mock.calls.length === 1);

      await writeFile(path.join(root, "symphonika.yml"), "projects:\n  - [\n");
      for (let tick = 0; tick < 10; tick += 1) {
        const response = await fetch(`${daemon.url}/api/poll-now`, {
          method: "POST"
        });
        expect(response.status).toBe(200);
      }
      await waitFor(() => deliver.mock.calls.length === 2);
      expect((deliver.mock.calls[1]?.[0] as NotificationMessage).subject).toBe(
        "[Symphonika] Service Config reload failed"
      );

      await writeRoutineHostConfig(root, { emailLines });
      const response = await fetch(`${daemon.url}/api/poll-now`, {
        method: "POST"
      });
      expect(response.status).toBe(200);
      await waitFor(() => deliver.mock.calls.length === 3);
      expect((deliver.mock.calls[2]?.[0] as NotificationMessage).subject).toBe(
        "[Symphonika] Service Config reload recovered"
      );
    } finally {
      await daemon.stop();
    }
  });

  it("sends one invalid Routine alert across ten ticks and one recovery", async () => {
    const root = await makeTempRoot();
    const emailLines = [
      "  sources:",
      "    routine_firings: false",
      "    issue_runs: false",
      "    daemon_health: true"
    ];
    await writeRoutineHostConfig(root, { emailLines });
    const deliver = vi.fn().mockResolvedValue(undefined);
    const daemon = await startDaemon({
      agentProviders: {},
      cwd: root,
      logger: pino({ enabled: false }),
      notificationSink: { deliver },
      port: 0
    });
    const routineLines = [
      "routines:",
      "  - path: ./daily-report.md",
      "    projects: [alpha]"
    ];
    try {
      await waitFor(() => deliver.mock.calls.length === 1);
      await writeFile(
        path.join(root, "daily-report.md"),
        [
          "---",
          "name: daily-report",
          "schedule: {}",
          "kind: report",
          "---",
          "Report.",
          ""
        ].join("\n")
      );
      await writeRoutineHostConfig(root, {
        emailLines,
        serviceTailLines: routineLines
      });
      for (let tick = 0; tick < 10; tick += 1) {
        await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
      }
      await waitFor(() => deliver.mock.calls.length === 2);
      expect((deliver.mock.calls[1]?.[0] as NotificationMessage).subject).toBe(
        "[Symphonika] Routine declarations became invalid"
      );

      await writeFile(
        path.join(root, "daily-report.md"),
        [
          "---",
          "name: daily-report",
          "schedule:",
          "  at: 2027-07-31T08:00:00.000Z",
          "kind: report",
          "---",
          "Report.",
          ""
        ].join("\n")
      );
      await fetch(`${daemon.url}/api/poll-now`, { method: "POST" });
      await waitFor(() => deliver.mock.calls.length === 3);
      expect((deliver.mock.calls[2]?.[0] as NotificationMessage).subject).toBe(
        "[Symphonika] Routine declarations recovered"
      );
    } finally {
      await daemon.stop();
    }
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "notification-daemon-test-"));
  tempRoots.push(root);
  return root;
}

async function writeRoutineHostConfig(
  root: string,
  options: { emailLines?: string[]; serviceTailLines?: string[] } = {}
): Promise<void> {
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      "  interval_ms: 25",
      "email:",
      '  from: "symphonika@example.com"',
      '  to: "operator@example.com"',
      "  on: always",
      '  smtp_host: "smtp.example.com"',
      ...(options.emailLines ?? []),
      "providers:",
      "  codex:",
      '    command: "codex app-server"',
      "  claude:",
      '    command: "claude -p --input-format stream-json --output-format stream-json"',
      "projects:",
      "  - name: alpha",
      "    mode: routine_host",
      "    workspace:",
      "      root: ./.symphonika/workspaces/alpha",
      "      git:",
      "        remote: git@github.com:example/alpha.git",
      "        base_branch: main",
      "    agent:",
      "      provider: codex",
      ...(options.serviceTailLines ?? []),
      ""
    ].join("\n")
  );
}

function issueFixture(number: number) {
  return {
    body: "Body",
    created_at: "2026-07-31T07:00:00.000Z",
    id: number,
    labels: ["agent-ready"],
    number,
    priority: 1,
    state: "open" as const,
    title: "Example issue",
    updated_at: "2026-07-31T07:30:00.000Z",
    url: `https://github.com/example/alpha/issues/${number}`
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met before timeout");
}
