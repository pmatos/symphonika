import type {
  RoutineFanoutStatus,
  RoutineFanoutTargetStatus
} from "../run-store.js";
import { escapeHtml, htmlShell } from "../notifications/message.js";

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
  const html = htmlShell([
    `<h1>${escapeHtml(fanout.routineName)}</h1>`,
    `<p><strong>Scheduled:</strong> ${escapeHtml(fanout.scheduledAt)}<br>`,
    `<strong>Fan-out:</strong> ${escapeHtml(fanout.id)}</p>`,
    "<h2>Projects</h2>",
    "<ul>",
    ...fanout.targets.map(
      (target) =>
        `<li><strong>${escapeHtml(target.projectName)}:</strong> ${escapeHtml(targetSummary(target))}</li>`
    ),
    "</ul>"
  ]);
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
  // A missed leg never ran at all, so it reads as the failure it is rather
  // than as one of the deliberate policy drops above (ADR 0093).
  if (target.disposition === "missed") {
    const attempts =
      target.deferredAttempts === 0
        ? ""
        : ` after ${target.deferredAttempts} admission ${
            target.deferredAttempts === 1 ? "attempt" : "attempts"
          }`;
    return `did not run (${target.skipReason ?? "unspecified"})${attempts}`;
  }
  if (target.disposition === "held") {
    return `held (${target.holdReason ?? "provider unavailable"})`;
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
