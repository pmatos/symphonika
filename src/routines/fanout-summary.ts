import type {
  RoutineFanoutStatus,
  RoutineFanoutTargetStatus
} from "../run-store.js";

export type RoutineFanoutNotification = {
  fanout: RoutineFanoutStatus;
  html: string;
  subject: string;
  text: string;
};

export function renderRoutineFanoutNotification(
  fanout: RoutineFanoutStatus
): RoutineFanoutNotification {
  const targetLines = fanout.targets.map(
    (target) => `- ${target.projectName}: ${targetSummary(target)}`
  );
  const text = [
    fanout.routineName,
    `Scheduled: ${fanout.scheduledAt}`,
    `Fan-out: ${fanout.id}`,
    "",
    "Projects:",
    ...targetLines
  ].join("\n");
  const html = [
    '<div style="font-family:system-ui,sans-serif;max-width:720px;line-height:1.5">',
    `<h1>${escapeHtml(fanout.routineName)}</h1>`,
    `<p><strong>Scheduled:</strong> ${escapeHtml(fanout.scheduledAt)}<br>`,
    `<strong>Fan-out:</strong> ${escapeHtml(fanout.id)}</p>`,
    "<h2>Projects</h2>",
    "<ul>",
    ...fanout.targets.map(
      (target) =>
        `<li><strong>${escapeHtml(target.projectName)}:</strong> ${escapeHtml(targetSummary(target))}</li>`
    ),
    "</ul>",
    "</div>"
  ].join("\n");
  return {
    fanout,
    html,
    subject: fanout.subject,
    text
  };
}

function targetSummary(target: RoutineFanoutTargetStatus): string {
  if (target.disposition === "skipped") {
    return `skipped (${target.skipReason ?? "unspecified"})`;
  }
  if (target.firing === null) {
    return target.disposition;
  }
  const pullRequests =
    target.firing.pullRequests.length === 0
      ? ""
      : ` — PR ${target.firing.pullRequests
          .map((pullRequest) => `#${pullRequest.prNumber}`)
          .join(", ")}`;
  const terminalReason =
    target.firing.terminalReason === null
      ? ""
      : ` (${target.firing.terminalReason})`;
  return `${target.firing.state}${terminalReason}${pullRequests}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
