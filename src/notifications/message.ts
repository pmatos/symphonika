import {
  emailNotificationSourceEnabled,
  type EmailNotificationConfig,
  type EmailNotificationSource
} from "./config.js";
import {
  deliverNotificationBestEffort,
  type NotificationDeliveryResult
} from "./delivery.js";
import type { NotificationMessage, NotificationSink } from "./types.js";

const HTML_SHELL_OPEN =
  '<div style="font-family:system-ui,sans-serif;max-width:720px;line-height:1.5">';
const HTML_SHELL_CLOSE = "</div>";

// Escape order is load-bearing: the ampersand pass must run first so it does
// not re-escape the ampersands introduced by the later replacements.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Wrap pre-rendered HTML fragments in the shared operator-mail container so
// every notification source presents the same width, font, and line height.
export function htmlShell(innerLines: readonly string[]): string {
  return [HTML_SHELL_OPEN, ...innerLines, HTML_SHELL_CLOSE].join("\n");
}

export type PullRequestReference = {
  prNumber: number;
  prUrl: string | null;
};

// Shared by every email renderer that mentions a discovered PR (fan-out
// summaries and single-firing notifications alike) so a fix to escaping or
// linking never has to be re-applied by hand in more than one place. An
// empty-string prUrl is treated the same as null rather than as a real link.
export function formatPullRequestReference(pullRequest: PullRequestReference): {
  html: string;
  text: string;
} {
  const label = `#${pullRequest.prNumber}`;
  if (pullRequest.prUrl === null || pullRequest.prUrl === "") {
    return { html: escapeHtml(label), text: label };
  }
  return {
    html: `<a href="${escapeHtml(pullRequest.prUrl)}">${escapeHtml(label)}</a>`,
    text: `${label} (${pullRequest.prUrl})`
  };
}

// Joins a list of references for display, falling back to "none" when
// empty — the one thing every caller with a whole-list (rather than a
// single-reference) rendering needs, kept here so the fallback text can't
// drift between the text and HTML halves, or between callers.
export function formatPullRequestReferences(
  pullRequests: readonly PullRequestReference[]
): { html: string; text: string } {
  if (pullRequests.length === 0) {
    return { html: "none", text: "none" };
  }
  const items = pullRequests.map((pullRequest) =>
    formatPullRequestReference(pullRequest)
  );
  return {
    html: items.map((item) => item.html).join(", "),
    text: items.map((item) => item.text).join(", ")
  };
}

export function symphonikaSubject(subject: string): string {
  return `[Symphonika] ${subject}`;
}

export type SourceNotificationDeliveryOutcome =
  | NotificationDeliveryResult
  | { reason: "disabled" | "policy"; state: "skipped" };

// The enable/policy/deliver gate every per-source notifier shares: honor the
// global switch and the per-source toggle, then the source's own policy
// decision, and only then render and best-effort deliver. `message` is a thunk
// so a skipped notification never pays for rendering it will not send.
export async function deliverSourceNotification(input: {
  config: EmailNotificationConfig;
  message: () => NotificationMessage;
  notifyEnabled: boolean;
  shouldNotify: boolean;
  sink: NotificationSink;
  source: EmailNotificationSource;
  timeoutMs?: number;
}): Promise<SourceNotificationDeliveryOutcome> {
  if (
    !input.notifyEnabled ||
    !emailNotificationSourceEnabled(input.config, input.source)
  ) {
    return { reason: "disabled", state: "skipped" };
  }
  if (!input.shouldNotify) {
    return { reason: "policy", state: "skipped" };
  }
  return deliverNotificationBestEffort({
    message: input.message(),
    sink: input.sink,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
  });
}
