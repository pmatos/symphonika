import { describe, expect, it, vi } from "vitest";

import {
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
    expect(message.html).toContain("<h2>Findings</h2>");
    expect(message.html).toContain("<strong>safe</strong>");
    expect(message.html).toContain(
      "&lt;script&gt;alert(&#39;routine&#39;)&lt;/script&gt;"
    );
    expect(message.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
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
        host: "smtp.example.com",
        port: 587,
        requireTLS: true,
        secure: false
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

  it("bounds a stalled delivery instead of hanging indefinitely", async () => {
    const previousTimeout = process.env.SYMPHONIKA_SMTP_DELIVERY_TIMEOUT_MS;
    process.env.SYMPHONIKA_SMTP_DELIVERY_TIMEOUT_MS = "20";
    try {
      const deliver = vi.fn(() => new Promise<void>(() => {}));

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
        error: "notification delivery timed out after 20ms",
        state: "failed"
      });
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.SYMPHONIKA_SMTP_DELIVERY_TIMEOUT_MS;
      } else {
        process.env.SYMPHONIKA_SMTP_DELIVERY_TIMEOUT_MS = previousTimeout;
      }
    }
  });
});

function routineFiringFixture(): RoutineFiringNotification {
  return {
    branchName: "main",
    durationMs: 1_234,
    firingId: "fire-123",
    kind: "report",
    projectName: "alpha",
    pullRequests: [],
    reportOutput: "",
    routineName: "daily-report",
    state: "succeeded",
    terminalReason: null,
    title: "Daily report"
  };
}
