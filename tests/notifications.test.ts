import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DELIVERY_TIMEOUT_MS,
  deliverRoutineFiringNotification,
  renderRoutineFiringNotification,
  type RoutineFiringNotification
} from "../src/notifications/routine-firing.js";
import { createSmtpNotificationSink } from "../src/notifications/smtp.js";
import { renderRoutineFanoutNotification } from "../src/routines/fanout-summary.js";
import type {
  RoutineFanoutStatus,
  RoutineFanoutTargetStatus
} from "../src/run-store.js";
import type { RoutineFiringStatus } from "../src/run-store.js";

function fakeFiring(
  overrides: Partial<RoutineFiringStatus> = {}
): RoutineFiringStatus {
  return {
    branchName: "sym/alpha/routine/refactor-audit/01J",
    branchRef: "refs/heads/sym/alpha/routine/refactor-audit/01J",
    cancelReason: null,
    cancelRequested: false,
    commitsAhead: true,
    createdAt: "2026-09-03T23:00:00.000Z",
    fanoutId: "fanout-1",
    id: "fire-alpha",
    kind: "git",
    outcome: null,
    projectName: "alpha",
    provider: "codex",
    providerCommand: "codex fake",
    providerScopeCleanupPending: false,
    pullRequests: [],
    routineName: "refactor-audit",
    scheduledAt: "2026-09-03T23:00:00.000Z",
    state: "succeeded",
    terminalReason: null,
    triggerSource: "scheduled",
    updatedAt: "2026-09-03T23:05:00.000Z",
    workspacePath: "/tmp/routines/alpha",
    workspacePrunedAt: null,
    ...overrides
  };
}

function fakeFanoutTarget(
  overrides: Partial<RoutineFanoutTargetStatus> = {}
): RoutineFanoutTargetStatus {
  return {
    deferredAttempts: 0,
    deferredReason: null,
    deferredSince: null,
    disposition: "firing",
    firing: fakeFiring(),
    firingId: "fire-alpha",
    holdReason: null,
    projectName: "alpha",
    skipReason: null,
    ...overrides
  };
}

function fakeFanout(targets: RoutineFanoutTargetStatus[]): RoutineFanoutStatus {
  return {
    createdAt: "2026-09-03T23:00:00.000Z",
    failureCount: 0,
    id: "01M1MR2MZTPPRGX4XFXVR93A6W",
    issueCount: 0,
    notificationError: null,
    notificationState: "sent",
    notifiedAt: "2026-09-03T23:06:00.000Z",
    pullRequestCount: targets.reduce(
      (count, target) => count + (target.firing?.pullRequests.length ?? 0),
      0
    ),
    routineName: "refactor-audit",
    scheduledAt: "2026-09-03T23:00:00.000Z",
    subject: "[ptt] refactor-audit",
    targets,
    updatedAt: "2026-09-03T23:06:00.000Z"
  };
}

describe("Routine Fan-out notifications", () => {
  it("links a discovered pull request instead of leaving it as a bare number", () => {
    const fanout = fakeFanout([
      fakeFanoutTarget({
        firing: fakeFiring({
          pullRequests: [
            {
              firingId: "fire-alpha",
              headSha: "abc123",
              prNumber: 701,
              prUrl: "https://github.com/pmatos/symphonika/pull/701",
              projectName: "alpha",
              routineName: "refactor-audit"
            }
          ]
        })
      })
    ]);

    const message = renderRoutineFanoutNotification(fanout);

    expect(message.text).toContain(
      "succeeded — PR #701 (https://github.com/pmatos/symphonika/pull/701)"
    );
    expect(message.html).toContain(
      '<a href="https://github.com/pmatos/symphonika/pull/701">#701</a>'
    );
  });

  it("explains a succeeded firing that opened no PR instead of leaving it unexplained", () => {
    const fanout = fakeFanout([
      fakeFanoutTarget({
        firing: fakeFiring({
          outcome: {
            action: "commit",
            source: "codex",
            status: "no_action",
            summary: "Bailed at pick.",
            title: "pm-deepen bailed — architecture PR #402 still in flight",
            url: null,
            verified: true
          },
          pullRequests: []
        })
      })
    ]);

    const message = renderRoutineFanoutNotification(fanout);

    expect(message.text).toContain(
      "succeeded — pm-deepen bailed — architecture PR #402 still in flight"
    );
    expect(message.html).toContain(
      "succeeded — pm-deepen bailed — architecture PR #402 still in flight"
    );
  });

  it("explains a genuine no-action outcome instead of a bare dash", () => {
    const fanout = fakeFanout([
      fakeFanoutTarget({
        firing: fakeFiring({
          outcome: {
            action: "none",
            source: "gh",
            status: "no_action",
            summary: "GitHub state diff observed no external action.",
            title: "",
            url: null,
            verified: true
          },
          pullRequests: []
        })
      })
    ]);

    const message = renderRoutineFanoutNotification(fanout);

    // reconcileRoutineOutcome leaves `title` empty for action:"none" outcomes
    // (src/routines/outcome.ts), matching formatRoutineOutcomeLine's own
    // "nothing to do" wording rather than an empty explanation.
    expect(message.text).toContain("succeeded — nothing to do");
    expect(message.html).toContain("succeeded — nothing to do");
  });

  it("surfaces an error outcome's summary instead of its unverified title when there is no PR", () => {
    const fanout = fakeFanout([
      fakeFanoutTarget({
        firing: fakeFiring({
          outcome: {
            action: "pr",
            source: "codex",
            status: "error",
            summary: "claimed PR #9 but none was found on the branch",
            title: "Opened PR #9",
            url: null,
            verified: false
          },
          pullRequests: []
        })
      })
    ]);

    const message = renderRoutineFanoutNotification(fanout);

    // A rejected/unverified claim must never read as an explained success:
    // show the reconciled error summary, not the provider's own (unverified)
    // title, which here claims a PR that reconciliation determined does not
    // exist.
    expect(message.text).toContain(
      "succeeded — claimed PR #9 but none was found on the branch (unverified)"
    );
    expect(message.text).not.toContain("Opened PR #9");
  });

  it("escapes an untrusted PR url and title instead of interpolating markup", () => {
    const fanout = fakeFanout([
      fakeFanoutTarget({
        firing: fakeFiring({
          outcome: {
            action: "commit",
            source: "codex",
            status: "no_action",
            summary: "n/a",
            title: "<img src=x onerror=alert(1)>",
            url: null,
            verified: true
          },
          pullRequests: [
            {
              firingId: "fire-alpha",
              headSha: "abc123",
              prNumber: 9,
              prUrl: 'https://example.com/"><script>alert(1)</script>',
              projectName: "alpha",
              routineName: "refactor-audit"
            }
          ]
        })
      })
    ]);

    const message = renderRoutineFanoutNotification(fanout);

    expect(message.html).not.toContain("<script>");
    expect(message.html).not.toContain("<img");
  });
});

describe("Routine Firing notifications", () => {
  it("renders plain text and an HTML alternative without allowing interpolated markup", () => {
    const message = renderRoutineFiringNotification({
      branchName: "main",
      durationMs: 1_234,
      firingId: "fire-123",
      kind: "report",
      outcome: {
        action: "pr",
        source: "codex",
        status: "success",
        summary: "Opened the pull request.",
        title: "Extract <retry> policy",
        url: "https://github.com/pmatos/alpha/pull/42",
        verified: false
      },
      projectName: "alpha",
      pullRequests: [],
      reportOutput:
        "## Findings\n\n- **safe** result\n- <img src=x onerror=alert(1)>",
      routineName: "daily-report",
      state: "succeeded",
      terminalReason: null,
      title: "<script>alert('routine')</script>"
    });

    expect(message.subject).toContain("<script>alert('routine')</script>");
    expect(message.text).toContain("## Findings");
    expect(message.text).toContain("<img src=x onerror=alert(1)>");
    expect(message.text).toContain(
      '✅ alpha — pr: "Extract <retry> policy" https://github.com/pmatos/alpha/pull/42 (unverified)'
    );
    expect(message.html).toContain("<h2>Findings</h2>");
    expect(message.html).toContain("<strong>safe</strong>");
    expect(message.html).toContain(
      "&lt;script&gt;alert(&#39;routine&#39;)&lt;/script&gt;"
    );
    expect(message.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(message.html).toContain(
      "✅ alpha — pr: &quot;Extract &lt;retry&gt; policy&quot; https://github.com/pmatos/alpha/pull/42 (unverified)"
    );
    expect(message.html).not.toContain("<script>");
    expect(message.html).not.toContain("<img");
  });

  it("links a discovered pull request the same way the fan-out summary does", () => {
    const message = renderRoutineFiringNotification({
      branchName: "main",
      durationMs: 1_234,
      firingId: "fire-123",
      kind: "git",
      outcome: null,
      projectName: "alpha",
      pullRequests: [
        {
          prNumber: 55,
          prUrl: 'https://example.com/"><script>alert(1)</script>'
        }
      ],
      reportOutput: "",
      routineName: "refactor-audit",
      state: "succeeded",
      terminalReason: null,
      title: "refactor-audit"
    });

    expect(message.text).toContain(
      'Pull requests: #55 (https://example.com/"><script>alert(1)</script>)'
    );
    expect(message.html).toContain(
      '<a href="https://example.com/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">#55</a>'
    );
    expect(message.html).not.toContain("<script>");
  });

  it("reads the SMTP password from its named environment variable and sends a multipart message", async () => {
    const sent: unknown[] = [];
    const transports: unknown[] = [];
    const secret = "smtp-password-that-must-stay-secret";
    const sink = createSmtpNotificationSink(
      {
        from: "symphonika@example.com",
        on: "always",
        smtpHost: "smtp.example.com",
        smtpPasswordEnv: "SMTP_TEST_PASSWORD",
        smtpPort: 587,
        smtpSecurity: "starttls",
        smtpUsername: "server-token",
        to: "operator@example.com"
      },
      {
        env: { SMTP_TEST_PASSWORD: secret },
        createTransport: (options) => {
          transports.push(options);
          return {
            sendMail: vi.fn((message: unknown) => {
              sent.push(message);
              return Promise.resolve();
            })
          };
        }
      }
    );

    await sink.deliver({
      html: "<p>HTML report</p>",
      subject: "Routine report",
      text: "Plain report"
    });

    expect(transports).toEqual([
      {
        auth: { pass: secret, user: "server-token" },
        connectionTimeout: DEFAULT_DELIVERY_TIMEOUT_MS,
        greetingTimeout: DEFAULT_DELIVERY_TIMEOUT_MS,
        host: "smtp.example.com",
        port: 587,
        requireTLS: true,
        secure: false,
        socketTimeout: DEFAULT_DELIVERY_TIMEOUT_MS
      }
    ]);
    expect(sent).toEqual([
      {
        from: "symphonika@example.com",
        html: "<p>HTML report</p>",
        subject: "Routine report",
        text: "Plain report",
        to: "operator@example.com"
      }
    ]);
    expect(JSON.stringify(sent)).not.toContain(secret);
  });

  it("bounds the SMTP transport's own connection/greeting/socket timeouts to the configured delivery timeout", async () => {
    const transports: unknown[] = [];
    const sink = createSmtpNotificationSink(
      {
        from: "symphonika@example.com",
        on: "always",
        smtpHost: "smtp.example.com",
        smtpPasswordEnv: "SMTP_TEST_PASSWORD",
        smtpPort: 587,
        smtpSecurity: "starttls",
        to: "operator@example.com"
      },
      {
        timeoutMs: 5_000,
        createTransport: (options) => {
          transports.push(options);
          return { sendMail: () => Promise.resolve() };
        }
      }
    );

    await sink.deliver({ html: "<p>x</p>", subject: "x", text: "x" });

    expect(transports).toEqual([
      {
        connectionTimeout: 5_000,
        greetingTimeout: 5_000,
        host: "smtp.example.com",
        port: 587,
        requireTLS: true,
        secure: false,
        socketTimeout: 5_000
      }
    ]);
  });

  it.each([
    {
      expected: 1,
      name: "always sends a successful report with no output",
      notifyEnabled: true,
      on: "always",
      reportOutput: "",
      state: "succeeded"
    },
    {
      expected: 0,
      name: "changes skips an empty report",
      notifyEnabled: true,
      on: "changes",
      reportOutput: "",
      state: "succeeded"
    },
    {
      expected: 1,
      name: "changes sends a non-empty report",
      notifyEnabled: true,
      on: "changes",
      reportOutput: "A finding",
      state: "succeeded"
    },
    {
      expected: 1,
      name: "failures sends a failed firing",
      notifyEnabled: true,
      on: "failures",
      reportOutput: "",
      state: "failed"
    },
    {
      expected: 0,
      name: "failures skips an operator cancellation",
      notifyEnabled: true,
      on: "failures",
      reportOutput: "",
      state: "cancelled"
    },
    {
      expected: 0,
      name: "notify false opts out before policy evaluation",
      notifyEnabled: false,
      on: "always",
      reportOutput: "A finding",
      state: "succeeded"
    }
  ] as const)("$name", async (example) => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const outcome = await deliverRoutineFiringNotification({
      config: {
        from: "symphonika@example.com",
        on: example.on,
        smtpHost: "smtp.example.com",
        smtpPasswordEnv: "SMTP_TEST_PASSWORD",
        smtpPort: 587,
        smtpSecurity: "starttls",
        to: "operator@example.com"
      },
      firing: {
        ...routineFiringFixture(),
        reportOutput: example.reportOutput,
        state: example.state
      },
      notifyEnabled: example.notifyEnabled,
      sink: { deliver }
    });

    expect(deliver).toHaveBeenCalledTimes(example.expected);
    expect(outcome.state).toBe(example.expected === 1 ? "sent" : "skipped");
  });

  it("retries one failed delivery and returns the final exact error", async () => {
    const deliver = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary SMTP failure"))
      .mockRejectedValueOnce(new Error("relay rejected recipient"));

    const outcome = await deliverRoutineFiringNotification({
      config: {
        from: "symphonika@example.com",
        on: "always",
        smtpHost: "smtp.example.com",
        smtpPasswordEnv: "SMTP_TEST_PASSWORD",
        smtpPort: 587,
        smtpSecurity: "starttls",
        to: "operator@example.com"
      },
      firing: routineFiringFixture(),
      notifyEnabled: true,
      sink: { deliver }
    });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      error: "relay rejected recipient",
      state: "failed"
    });
  });

  it("can mute Routine Firing mail independently of other email sources", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);

    const outcome = await deliverRoutineFiringNotification({
      config: {
        from: "symphonika@example.com",
        on: "always",
        sources: {
          daemonHealth: true,
          issueRuns: true,
          routineFanouts: true,
          routineFirings: false
        },
        smtpHost: "smtp.example.com",
        smtpPasswordEnv: "SMTP_TEST_PASSWORD",
        smtpPort: 587,
        smtpSecurity: "starttls",
        to: "operator@example.com"
      },
      firing: routineFiringFixture(),
      notifyEnabled: true,
      sink: { deliver }
    });

    expect(outcome).toEqual({ reason: "disabled", state: "skipped" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("bounds the complete best-effort delivery attempt", async () => {
    const outcome = await deliverRoutineFiringNotification({
      config: {
        from: "symphonika@example.com",
        on: "always",
        smtpHost: "smtp.example.com",
        smtpPasswordEnv: "SMTP_TEST_PASSWORD",
        smtpPort: 587,
        smtpSecurity: "starttls",
        to: "operator@example.com"
      },
      firing: routineFiringFixture(),
      notifyEnabled: true,
      sink: {
        deliver: () => new Promise<void>(() => undefined)
      },
      timeoutMs: 5
    });

    expect(outcome).toEqual({
      error: "notification delivery timed out after 5ms",
      state: "failed"
    });
  });

  it("does not start a second attempt while the first is still hung past the deadline", async () => {
    const deliver = vi.fn(() => new Promise<void>(() => undefined));

    const outcome = await deliverRoutineFiringNotification({
      config: {
        from: "symphonika@example.com",
        on: "always",
        smtpHost: "smtp.example.com",
        smtpPasswordEnv: "SMTP_TEST_PASSWORD",
        smtpPort: 587,
        smtpSecurity: "starttls",
        to: "operator@example.com"
      },
      firing: routineFiringFixture(),
      notifyEnabled: true,
      sink: { deliver },
      timeoutMs: 5
    });

    expect(outcome).toEqual({
      error: "notification delivery timed out after 5ms",
      state: "failed"
    });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("does not retry once the first attempt rejects after the deadline has already passed", async () => {
    const deliver = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error("relay reset after deadline")), 20);
        })
    );

    const outcome = await deliverRoutineFiringNotification({
      config: {
        from: "symphonika@example.com",
        on: "always",
        smtpHost: "smtp.example.com",
        smtpPasswordEnv: "SMTP_TEST_PASSWORD",
        smtpPort: 587,
        smtpSecurity: "starttls",
        to: "operator@example.com"
      },
      firing: routineFiringFixture(),
      notifyEnabled: true,
      sink: { deliver },
      timeoutMs: 5
    });

    expect(outcome).toEqual({
      error: "notification delivery timed out after 5ms",
      state: "failed"
    });

    // Let the delayed rejection settle in the background and confirm it
    // did not trigger a second, concurrent delivery attempt.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

function routineFiringFixture(): RoutineFiringNotification {
  return {
    branchName: "main",
    durationMs: 1_234,
    firingId: "fire-123",
    kind: "report",
    outcome: null,
    projectName: "alpha",
    pullRequests: [],
    reportOutput: "",
    routineName: "daily-report",
    state: "succeeded",
    terminalReason: null,
    title: "Daily report"
  };
}
