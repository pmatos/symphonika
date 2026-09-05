import { describe, expect, it, vi } from "vitest";

import {
  deliverSourceNotification,
  escapeHtml,
  formatPullRequestReference,
  htmlShell,
  symphonikaSubject,
  type SourceNotificationDeliveryOutcome
} from "../src/notifications/message.js";
import type { EmailNotificationConfig } from "../src/notifications/config.js";
import type { NotificationMessage } from "../src/notifications/types.js";

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters, ampersand first", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("does not double-escape an already-escaped entity's ampersand only once per pass", () => {
    expect(escapeHtml("a & b < c")).toBe("a &amp; b &lt; c");
  });

  it("neutralizes interpolated markup", () => {
    expect(escapeHtml("<script>alert('x')</script>")).toBe(
      "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"
    );
  });
});

describe("formatPullRequestReference", () => {
  it("renders a bare, unlinked number when prUrl is null", () => {
    expect(formatPullRequestReference({ prNumber: 42, prUrl: null })).toEqual({
      html: "#42",
      text: "#42"
    });
  });

  it("treats an empty-string prUrl the same as null instead of a dead link", () => {
    expect(formatPullRequestReference({ prNumber: 42, prUrl: "" })).toEqual({
      html: "#42",
      text: "#42"
    });
  });

  it("links the number and escapes the url when prUrl is set", () => {
    expect(
      formatPullRequestReference({
        prNumber: 7,
        prUrl: "https://github.com/example/alpha/pull/7"
      })
    ).toEqual({
      html: '<a href="https://github.com/example/alpha/pull/7">#7</a>',
      text: "#7 (https://github.com/example/alpha/pull/7)"
    });
  });
});

describe("htmlShell", () => {
  it("wraps inner lines in the standard system-ui message container joined by newlines", () => {
    expect(htmlShell(["<h1>Title</h1>", "<p>Body</p>"])).toBe(
      [
        '<div style="font-family:system-ui,sans-serif;max-width:720px;line-height:1.5">',
        "<h1>Title</h1>",
        "<p>Body</p>",
        "</div>"
      ].join("\n")
    );
  });

  it("emits just the open and close container for no inner lines", () => {
    expect(htmlShell([])).toBe(
      '<div style="font-family:system-ui,sans-serif;max-width:720px;line-height:1.5">\n</div>'
    );
  });
});

describe("symphonikaSubject", () => {
  it("prefixes the subject with the Symphonika tag", () => {
    expect(symphonikaSubject("Daemon started")).toBe(
      "[Symphonika] Daemon started"
    );
  });
});

describe("deliverSourceNotification", () => {
  const config: EmailNotificationConfig = {
    from: "symphonika@example.com",
    on: "always",
    smtpHost: "smtp.example.com",
    smtpPasswordEnv: "SMTP_TEST_PASSWORD",
    smtpPort: 587,
    smtpSecurity: "starttls",
    to: "operator@example.com"
  };
  const message: NotificationMessage = {
    html: "<p>hi</p>",
    subject: "hi",
    text: "hi"
  };

  it("skips as disabled when notifications are switched off, without rendering", async () => {
    const render = vi.fn(() => message);
    const deliver = vi.fn().mockResolvedValue(undefined);

    const outcome: SourceNotificationDeliveryOutcome =
      await deliverSourceNotification({
        config,
        message: render,
        notifyEnabled: false,
        shouldNotify: true,
        sink: { deliver },
        source: "routine_firings"
      });

    expect(outcome).toEqual({ reason: "disabled", state: "skipped" });
    expect(render).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("skips as disabled when the per-source toggle is off", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);

    const outcome = await deliverSourceNotification({
      config: {
        ...config,
        sources: {
          daemonHealth: true,
          issueRuns: true,
          routineFanouts: true,
          routineFirings: false
        }
      },
      message: () => message,
      notifyEnabled: true,
      shouldNotify: true,
      sink: { deliver },
      source: "routine_firings"
    });

    expect(outcome).toEqual({ reason: "disabled", state: "skipped" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("skips as policy when shouldNotify is false, without rendering", async () => {
    const render = vi.fn(() => message);
    const deliver = vi.fn().mockResolvedValue(undefined);

    const outcome = await deliverSourceNotification({
      config,
      message: render,
      notifyEnabled: true,
      shouldNotify: false,
      sink: { deliver },
      source: "routine_firings"
    });

    expect(outcome).toEqual({ reason: "policy", state: "skipped" });
    expect(render).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("delivers the rendered message and reports sent when the gates pass", async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);

    const outcome = await deliverSourceNotification({
      config,
      message: () => message,
      notifyEnabled: true,
      shouldNotify: true,
      sink: { deliver },
      source: "routine_fanouts"
    });

    expect(deliver).toHaveBeenCalledWith(message);
    expect(outcome).toEqual({ state: "sent" });
  });

  it("propagates the best-effort delivery failure, honoring the timeout override", async () => {
    const outcome = await deliverSourceNotification({
      config,
      message: () => message,
      notifyEnabled: true,
      shouldNotify: true,
      sink: { deliver: () => new Promise<void>(() => undefined) },
      source: "routine_firings",
      timeoutMs: 5
    });

    expect(outcome).toEqual({
      error: "notification delivery timed out after 5ms",
      state: "failed"
    });
  });
});
