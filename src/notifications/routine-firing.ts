import type { RoutineFiringState, RoutineKind } from "../routines/types.js";
import {
  formatRoutineOutcomeLine,
  type RoutineOutcome
} from "../routines/outcome.js";
import type { EmailDeliveryPolicy, EmailNotificationConfig } from "./config.js";
import type { NotificationMessage } from "./types.js";
import type { NotificationSink } from "./types.js";
import { DEFAULT_DELIVERY_TIMEOUT_MS } from "./delivery.js";
import {
  deliverSourceNotification,
  escapeHtml,
  formatPullRequestReferences,
  htmlShell,
  symphonikaSubject,
  type PullRequestReference,
  type SourceNotificationDeliveryOutcome
} from "./message.js";

export { DEFAULT_DELIVERY_TIMEOUT_MS };

export type RoutineFiringNotification = {
  branchName: string;
  durationMs: number;
  firingId: string;
  kind: RoutineKind;
  outcome: RoutineOutcome | null;
  projectName: string;
  pullRequests: PullRequestReference[];
  reportOutput: string;
  routineName: string;
  state: Extract<RoutineFiringState, "succeeded" | "failed" | "cancelled">;
  terminalReason: string | null;
  title: string;
};

export async function deliverRoutineFiringNotification(input: {
  config: EmailNotificationConfig;
  firing: RoutineFiringNotification;
  notifyEnabled: boolean;
  sink: NotificationSink;
  timeoutMs?: number;
}): Promise<SourceNotificationDeliveryOutcome> {
  return deliverSourceNotification({
    config: input.config,
    message: () => renderRoutineFiringNotification(input.firing),
    notifyEnabled: input.notifyEnabled,
    shouldNotify: shouldNotifyRoutineFiring(input.firing, input.config.on),
    sink: input.sink,
    source: "routine_firings",
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
  });
}

export function renderRoutineFiringNotification(
  firing: RoutineFiringNotification
): NotificationMessage {
  const pullRequests = formatPullRequestReferences(firing.pullRequests);
  const duration = formatDuration(firing.durationMs);
  const terminal = firing.terminalReason ?? "none";
  const reportOutput =
    firing.reportOutput.trim().length === 0
      ? "(no report output)"
      : firing.reportOutput.trim();
  const outcomeLine =
    firing.outcome === null
      ? `⚪ ${firing.projectName} — outcome unavailable`
      : formatRoutineOutcomeLine(firing.projectName, firing.outcome);
  const text = [
    firing.title,
    "",
    outcomeLine,
    "",
    `Project: ${firing.projectName}`,
    `Routine: ${firing.routineName}`,
    `Firing: ${firing.firingId}`,
    `Kind: ${firing.kind}`,
    `State: ${firing.state}`,
    `Terminal reason: ${terminal}`,
    `Duration: ${duration}`,
    `Branch: ${firing.branchName}`,
    `Pull requests: ${pullRequests.text}`,
    "",
    "Report output:",
    reportOutput
  ].join("\n");
  const html = htmlShell([
    `<h1>${escapeHtml(firing.title)}</h1>`,
    `<p><strong>Outcome</strong><br>${escapeHtml(outcomeLine)}</p>`,
    "<dl>",
    detail("Project", firing.projectName),
    detail("Routine", firing.routineName),
    detail("Firing", firing.firingId),
    detail("Kind", firing.kind),
    detail("State", firing.state),
    detail("Terminal reason", terminal),
    detail("Duration", duration),
    detail("Branch", firing.branchName),
    rawDetail("Pull requests", pullRequests.html),
    "</dl>",
    "<h2>Report output</h2>",
    renderMinimalMarkdown(reportOutput)
  ]);

  return {
    html,
    subject: symphonikaSubject(`${firing.title} — ${firing.state}`),
    text
  };
}

function shouldNotifyRoutineFiring(
  firing: RoutineFiringNotification,
  policy: EmailDeliveryPolicy
): boolean {
  if (policy === "always") {
    return true;
  }
  if (policy === "failures") {
    return firing.state === "failed";
  }
  return firing.kind === "git"
    ? firing.state === "succeeded"
    : firing.reportOutput.trim().length > 0;
}

function detail(label: string, value: string): string {
  return `<dt><strong>${escapeHtml(label)}</strong></dt><dd>${escapeHtml(value)}</dd>`;
}

// Like detail(), but for a value that is already safe HTML (e.g. an anchor
// built by formatPullRequestReference) — escaping it again would turn the
// link back into literal text.
function rawDetail(label: string, html: string): string {
  return `<dt><strong>${escapeHtml(label)}</strong></dt><dd>${html}</dd>`;
}

function renderMinimalMarkdown(markdown: string): string {
  const output: string[] = [];
  let listOpen = false;

  const closeList = (): void => {
    if (listOpen) {
      output.push("</ul>");
      listOpen = false;
    }
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("### ")) {
      closeList();
      output.push(`<h3>${renderInline(line.slice(4))}</h3>`);
    } else if (line.startsWith("## ")) {
      closeList();
      output.push(`<h2>${renderInline(line.slice(3))}</h2>`);
    } else if (line.startsWith("# ")) {
      closeList();
      output.push(`<h1>${renderInline(line.slice(2))}</h1>`);
    } else if (line.startsWith("- ")) {
      if (!listOpen) {
        output.push("<ul>");
        listOpen = true;
      }
      output.push(`<li>${renderInline(line.slice(2))}</li>`);
    } else if (line.trim().length === 0) {
      closeList();
    } else {
      closeList();
      output.push(`<p>${renderInline(line)}</p>`);
    }
  }
  closeList();
  return output.join("\n");
}

function renderInline(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(?!\s)(.+?)\*/g, "<em>$1</em>");
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${Math.max(0, Math.round(durationMs))}ms`;
  }
  return `${(durationMs / 1_000).toFixed(1)}s`;
}
