import type {
  RoutineFanoutStatus,
  RoutineFanoutTargetStatus
} from "../run-store.js";
import { escapeHtml, htmlShell } from "../notifications/message.js";
import type { RoutinePullRequestStatus } from "./types.js";

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
    (target) => `- ${target.projectName}: ${targetSummary(target).text}`
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
        `<li><strong>${escapeHtml(target.projectName)}:</strong> ${targetSummary(target).html}</li>`
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

// Built together, not as separate text/html renderers, so the skip/missed/
// held/PR-link branches can't drift out of sync with each other (a link
// only the html half remembers to add is worse than no link).
function targetSummary(target: RoutineFanoutTargetStatus): {
  html: string;
  text: string;
} {
  if (target.disposition === "skipped") {
    const text = `skipped (${target.skipReason ?? "unspecified"})`;
    return { html: escapeHtml(text), text };
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
    const text = `did not run (${target.skipReason ?? "unspecified"})${attempts}`;
    return { html: escapeHtml(text), text };
  }
  if (target.disposition === "held") {
    const text = `held (${target.holdReason ?? "provider unavailable"})`;
    return { html: escapeHtml(text), text };
  }
  if (target.firing === null) {
    return { html: escapeHtml(target.disposition), text: target.disposition };
  }
  const { firing } = target;
  const terminalReason =
    firing.terminalReason === null ? "" : ` (${firing.terminalReason})`;
  const pullRequests = firing.pullRequests;
  // A succeeded firing with no discovered PR isn't necessarily a discovery
  // bug — a routine (e.g. pm-deepen) can legitimately commit a report and
  // stop short of opening one. Surface why so "succeeded" with no PR reads
  // as an explained outcome rather than a silent gap.
  if (pullRequests.length === 0) {
    const outcomeDetail =
      firing.outcome === null ? "" : ` — ${firing.outcome.title}`;
    const text = `${firing.state}${terminalReason}${outcomeDetail}`;
    return { html: escapeHtml(text), text };
  }
  const text = `${firing.state}${terminalReason} — PR ${pullRequests
    .map((pullRequest) => pullRequestText(pullRequest))
    .join(", ")}`;
  const html = `${escapeHtml(firing.state)}${escapeHtml(terminalReason)} — PR ${pullRequests
    .map((pullRequest) => pullRequestHtml(pullRequest))
    .join(", ")}`;
  return { html, text };
}

function pullRequestText(pullRequest: RoutinePullRequestStatus): string {
  return pullRequest.prUrl === null
    ? `#${pullRequest.prNumber}`
    : `#${pullRequest.prNumber} (${pullRequest.prUrl})`;
}

function pullRequestHtml(pullRequest: RoutinePullRequestStatus): string {
  const label = `#${pullRequest.prNumber}`;
  return pullRequest.prUrl === null
    ? escapeHtml(label)
    : `<a href="${escapeHtml(pullRequest.prUrl)}">${escapeHtml(label)}</a>`;
}
