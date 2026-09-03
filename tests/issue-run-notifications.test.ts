import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IssueRunNotificationCoordinator,
  shouldNotifyIssueRun
} from "../src/notifications/issue-run.js";
import type { NotificationMessage } from "../src/notifications/types.js";
import { openRunStore, type RunStatus } from "../src/run-store.js";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("terminal issue Run notifications", () => {
  it("classifies failures from terminal reason instead of RunState", () => {
    expect(
      shouldNotifyIssueRun(
        runFixture({
          state: "failed",
          terminalReason: "no_workspace_changes"
        }),
        "failures"
      )
    ).toBe(false);
    expect(
      shouldNotifyIssueRun(
        runFixture({
          state: "blocked",
          terminalReason: "workflow_terminal_blocked"
        }),
        "failures"
      )
    ).toBe(false);
    expect(
      shouldNotifyIssueRun(
        runFixture({
          state: "blocked",
          terminalReason:
            "merge_pr_refused: PR #99: Protected branch update failed"
        }),
        "failures"
      )
    ).toBe(false);
    expect(
      shouldNotifyIssueRun(
        runFixture({ state: "stale", terminalReason: "no_progress" }),
        "failures"
      )
    ).toBe(true);
    expect(
      shouldNotifyIssueRun(
        runFixture({
          state: "failed",
          terminalReason: "cap_reached:no_commits"
        }),
        "failures"
      )
    ).toBe(true);
  });

  it("uses successful committed Runs as the changes policy signal", () => {
    expect(
      shouldNotifyIssueRun(
        runFixture({ state: "succeeded", terminalReason: null }),
        "changes"
      )
    ).toBe(true);
    expect(
      shouldNotifyIssueRun(
        runFixture({ state: "failed", terminalReason: "process_exit_1" }),
        "changes"
      )
    ).toBe(false);
  });

  it("persists only genuinely terminal Runs as pending delivery", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "run-notification-test-"));
    tempRoots.push(root);
    const store = openRunStore({ stateRoot: root });
    try {
      store.createRun({
        id: "run-retrying",
        issue: issueFixture(42),
        projectName: "alpha",
        providerCommand: "codex app-server",
        providerName: "codex"
      });
      store.recordTerminalReason(
        "run-retrying",
        "provider_connection_lost",
        "transient"
      );
      store.updateRunState("run-retrying", "failed");

      expect(store.listPendingRunNotifications()).toEqual([]);

      store.markRunNotificationPending("run-retrying");

      expect(store.listPendingRunNotifications().map((run) => run.id)).toEqual([
        "run-retrying"
      ]);
    } finally {
      store.close();
    }
  });

  it("delivers a burst as one bounded digest per window", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(tmpdir(), "run-notification-test-"));
    tempRoots.push(root);
    const store = openRunStore({ stateRoot: root });
    const deliver = vi.fn().mockResolvedValue(undefined);
    try {
      for (let index = 1; index <= 100; index += 1) {
        const id = `run-${String(index).padStart(3, "0")}`;
        store.createRun({
          id,
          issue: issueFixture(index),
          projectName: "alpha",
          providerCommand: "codex app-server",
          providerName: "codex"
        });
        store.updateRunState(id, "succeeded");
      }
      const coordinator = new IssueRunNotificationCoordinator({
        createSink: () => ({ deliver }),
        resolveConfig: () => ({
          digestWindowMs: 60_000,
          from: "symphonika@example.com",
          on: "always",
          smtpHost: "smtp.example.com",
          smtpPasswordEnv: "SMTP_TEST_PASSWORD",
          smtpPort: 587,
          smtpSecurity: "starttls",
          to: "operator@example.com"
        }),
        runStore: store
      });

      coordinator.schedulePending();
      expect(deliver).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0]?.[0]).toMatchObject({
        subject: "[Symphonika] 100 terminal issue Runs"
      });
      expect(
        (deliver.mock.calls[0]?.[0] as NotificationMessage).text
      ).toContain("50 additional Runs omitted");
      expect(store.listPendingRunNotifications()).toEqual([]);

      coordinator.schedulePending();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deliver).toHaveBeenCalledOnce();
    } finally {
      store.close();
    }
  });

  it("contains delivery failure outside the Run and retries once", async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(tmpdir(), "run-notification-test-"));
    tempRoots.push(root);
    const store = openRunStore({ stateRoot: root });
    const deliver = vi.fn().mockRejectedValue(new Error("relay unavailable"));
    try {
      store.createRun({
        id: "run-failed",
        issue: issueFixture(42),
        projectName: "alpha",
        providerCommand: "codex app-server",
        providerName: "codex"
      });
      store.recordTerminalReason(
        "run-failed",
        "process_exit_1",
        "deterministic"
      );
      store.updateRunState("run-failed", "failed");
      const coordinator = new IssueRunNotificationCoordinator({
        createSink: () => ({ deliver }),
        resolveConfig: () => ({
          digestWindowMs: 1,
          from: "symphonika@example.com",
          on: "failures",
          smtpHost: "smtp.example.com",
          smtpPasswordEnv: "SMTP_TEST_PASSWORD",
          smtpPort: 587,
          smtpSecurity: "starttls",
          to: "operator@example.com"
        }),
        runStore: store
      });

      coordinator.schedulePending();
      await vi.advanceTimersByTimeAsync(1);

      expect(deliver).toHaveBeenCalledTimes(2);
      expect(store.getRun("run-failed")).toMatchObject({
        state: "failed",
        terminalReason: "process_exit_1"
      });
      expect(store.listPendingRunNotifications()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("releases an interrupted digest claim after daemon restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "run-notification-test-"));
    tempRoots.push(root);
    const first = openRunStore({ stateRoot: root });
    first.createRun({
      id: "run-interrupted",
      issue: issueFixture(42),
      projectName: "alpha",
      providerCommand: "codex app-server",
      providerName: "codex"
    });
    first.updateRunState("run-interrupted", "succeeded");
    expect(first.claimRunNotifications(["run-interrupted"])).toBe(true);
    first.close();

    const reopened = openRunStore({ stateRoot: root });
    try {
      expect(reopened.releaseInterruptedRunNotifications()).toBe(1);
      expect(
        reopened.listPendingRunNotifications().map((run) => run.id)
      ).toEqual(["run-interrupted"]);
    } finally {
      reopened.close();
    }
  });
});

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

function runFixture(overrides: Partial<RunStatus> = {}): RunStatus {
  return {
    branchName: "sym/alpha/42-example",
    cancelReason: null,
    cancelRequested: false,
    continuationParentRunId: null,
    createdAt: "2026-07-31T08:00:00.000Z",
    currentStateId: null,
    failureClassification: "deterministic",
    id: "run-42",
    isContinuation: false,
    issueNumber: 42,
    issueTitle: "Example issue",
    project: "alpha",
    provider: "codex",
    providerScopeCleanupPending: false,
    retryCount: 0,
    state: "failed",
    stateTransitionReason: null,
    terminalReason: "process_exit_1",
    terminalStateId: null,
    updatedAt: "2026-07-31T08:01:00.000Z",
    workspacePath: "/tmp/alpha/issues/42-example",
    ...overrides
  };
}
