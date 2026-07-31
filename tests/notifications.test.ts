import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DELIVERY_TIMEOUT_MS,
  deliverRoutineFiringNotification,
  renderRoutineFiringNotification,
  type RoutineFiringNotification
} from "../src/notifications/routine-firing.js";
import { createSmtpNotificationSink } from "../src/notifications/smtp.js";

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
