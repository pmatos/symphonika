import type { RoutineFiringState, RoutineKind } from "../routines/types.js";
import {
  formatRoutineOutcomeLine,
  type RoutineOutcome
} from "../routines/outcome.js";
import type { EmailDeliveryPolicy, EmailNotificationConfig } from "./config.js";
import type { NotificationMessage } from "./types.js";
import type { NotificationSink } from "./types.js";

export type RoutineFiringNotification = {
  branchName: string;
  durationMs: number;
  firingId: string;
  kind: RoutineKind;
  outcome: RoutineOutcome | null;
  projectName: string;
  pullRequests: Array<{ prNumber: number }>;
  reportOutput: string;
  routineName: string;
  state: Extract<RoutineFiringState, "succeeded" | "failed" | "cancelled">;
  terminalReason: string | null;
  title: string;
};

export type RoutineNotificationDeliveryOutcome =
  | { state: "sent" }
  | { state: "skipped"; reason: "disabled" | "policy" }
  | { state: "failed"; error: string };

export async function deliverRoutineFiringNotification(input: {
  config: EmailNotificationConfig;
  firing: RoutineFiringNotification;
  notifyEnabled: boolean;
  sink: NotificationSink;
}): Promise<RoutineNotificationDeliveryOutcome> {
  if (!input.notifyEnabled) {
    return { reason: "disabled", state: "skipped" };
  }
  if (!shouldNotifyRoutineFiring(input.firing, input.config.on)) {
    return { reason: "policy", state: "skipped" };
  }
  const message = renderRoutineFiringNotification(input.firing);
  let lastError = "notification delivery failed";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await input.sink.deliver(message);
      return { state: "sent" };
    } catch (error) {
      lastError = errorMessage(error);
    }
  }
  return { error: lastError, state: "failed" };
}

export function renderRoutineFiringNotification(
  firing: RoutineFiringNotification
): NotificationMessage {
  const pullRequests =
    firing.pullRequests.length === 0
      ? "none"
      : firing.pullRequests
          .map((pullRequest) => `#${pullRequest.prNumber}`)
          .join(", ");
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
    `Pull requests: ${pullRequests}`,
    "",
    "Report output:",
    reportOutput
  ].join("\n");
  const html = [
    '<div style="font-family:system-ui,sans-serif;max-width:720px;line-height:1.5">',
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
    detail("Pull requests", pullRequests),
    "</dl>",
    "<h2>Report output</h2>",
    renderMinimalMarkdown(reportOutput),
    "</div>"
  ].join("\n");

  return {
    html,
    subject: `[Symphonika] ${firing.title} — ${firing.state}`,
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${Math.max(0, Math.round(durationMs))}ms`;
  }
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
