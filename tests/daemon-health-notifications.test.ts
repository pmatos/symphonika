import { describe, expect, it, vi } from "vitest";

import { DaemonHealthNotifier } from "../src/notifications/daemon-health.js";
import type { NotificationMessage } from "../src/notifications/types.js";

describe("daemon health notifications", () => {
  it("notifies once across repeated broken reloads and once on recovery", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const notifier = new DaemonHealthNotifier({
      createSink: () => ({ deliver }),
      resolveConfig: () => ({
        from: "symphonika@example.com",
        on: "always",
        smtpHost: "smtp.example.com",
        smtpPasswordEnv: "SMTP_TEST_PASSWORD",
        smtpPort: 587,
        smtpSecurity: "starttls",
        to: "operator@example.com"
      })
    });

    for (let tick = 0; tick < 10; tick += 1) {
      notifier.observeReload({
        broken: true,
        errors: ["service config could not be parsed"]
      });
    }
    await notifier.settled();

    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({
      subject: "[Symphonika] Service Config reload failed"
    });

    notifier.observeReload({ broken: false, errors: [] });
    await notifier.settled();

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1]?.[0]).toMatchObject({
      subject: "[Symphonika] Service Config reload recovered"
    });
  });

  it("notifies only on invalid Routine declaration state transitions", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const notifier = new DaemonHealthNotifier({
      createSink: () => ({ deliver }),
      resolveConfig: () => ({
        from: "symphonika@example.com",
        on: "always",
        smtpHost: "smtp.example.com",
        smtpPasswordEnv: "SMTP_TEST_PASSWORD",
        smtpPort: 587,
        smtpSecurity: "starttls",
        to: "operator@example.com"
      })
    });
    const invalid = [
      {
        name: "daily-report",
        path: "/srv/routines/daily-report.md",
        projectName: "alpha"
      }
    ];

    for (let tick = 0; tick < 10; tick += 1) {
      notifier.observeInvalidRoutines(invalid);
    }
    await notifier.settled();
    notifier.observeInvalidRoutines([]);
    await notifier.settled();

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(
      deliver.mock.calls.map((call) => (call[0] as NotificationMessage).subject)
    ).toEqual([
      "[Symphonika] Routine declarations became invalid",
      "[Symphonika] Routine declarations recovered"
    ]);
  });

  it("includes orphan reconciliation in the daemon start event", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const notifier = new DaemonHealthNotifier({
      createSink: () => ({ deliver }),
      resolveConfig: () => ({
        from: "symphonika@example.com",
        on: "always",
        smtpHost: "smtp.example.com",
        smtpPasswordEnv: "SMTP_TEST_PASSWORD",
        smtpPort: 587,
        smtpSecurity: "starttls",
        to: "operator@example.com"
      })
    });

    notifier.notifyDaemonStarted({
      orphanedRoutineFirings: 1,
      orphanedRuns: 2
    });
    await notifier.settled();

    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({
      subject: "[Symphonika] Daemon started"
    });
    expect((deliver.mock.calls[0]?.[0] as NotificationMessage).text).toContain(
      "Orphaned issue Runs reconciled: 2"
    );
    expect((deliver.mock.calls[0]?.[0] as NotificationMessage).text).toContain(
      "Orphaned Routine Firings reconciled: 1"
    );
  });

  it("groups Watchdog terminations from one reconciliation pass", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const notifier = new DaemonHealthNotifier({
      createSink: () => ({ deliver }),
      resolveConfig: () => ({
        from: "symphonika@example.com",
        on: "always",
        smtpHost: "smtp.example.com",
        smtpPasswordEnv: "SMTP_TEST_PASSWORD",
        smtpPort: 587,
        smtpSecurity: "starttls",
        to: "operator@example.com"
      })
    });

    notifier.notifyWatchdogTerminations([
      { issueNumber: 42, projectName: "alpha", runId: "run-42" },
      { issueNumber: 43, projectName: "alpha", runId: "run-43" }
    ]);
    await notifier.settled();

    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({
      subject: "[Symphonika] Watchdog terminated 2 issue Runs"
    });
  });

  it("contains final delivery failure outside daemon control flow", async () => {
    const deliver = vi.fn().mockRejectedValue(new Error("relay unavailable"));
    const notifier = new DaemonHealthNotifier({
      createSink: () => ({ deliver }),
      resolveConfig: () => ({
        from: "symphonika@example.com",
        on: "always",
        smtpHost: "smtp.example.com",
        smtpPasswordEnv: "SMTP_TEST_PASSWORD",
        smtpPort: 587,
        smtpSecurity: "starttls",
        to: "operator@example.com"
      })
    });

    notifier.notifyDaemonStarted({
      orphanedRoutineFirings: 0,
      orphanedRuns: 0
    });

    await expect(notifier.settled()).resolves.toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("notifies once across repeated self-update failures and once on recovery (ADR 0079)", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const notifier = new DaemonHealthNotifier({
      createSink: () => ({ deliver }),
      resolveConfig: () => ({
        from: "symphonika@example.com",
        on: "always",
        smtpHost: "smtp.example.com",
        smtpPasswordEnv: "SMTP_TEST_PASSWORD",
        smtpPort: 587,
        smtpSecurity: "starttls",
        to: "operator@example.com"
      })
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      notifier.observeUpdateFailure({
        broken: true,
        detail: "checksum mismatch"
      });
    }
    await notifier.settled();

    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({
      subject: "[Symphonika] Self-update failed"
    });

    notifier.observeUpdateFailure({ broken: false });
    await notifier.settled();

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1]?.[0]).toMatchObject({
      subject: "[Symphonika] Self-update recovered"
    });
  });

  it("never notifies on a first, successful self-update", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const notifier = new DaemonHealthNotifier({
      createSink: () => ({ deliver }),
      resolveConfig: () => ({
        from: "symphonika@example.com",
        on: "always",
        smtpHost: "smtp.example.com",
        smtpPasswordEnv: "SMTP_TEST_PASSWORD",
        smtpPort: 587,
        smtpSecurity: "starttls",
        to: "operator@example.com"
      })
    });

    notifier.observeUpdateFailure({ broken: false });
    await notifier.settled();

    expect(deliver).not.toHaveBeenCalled();
  });
});
