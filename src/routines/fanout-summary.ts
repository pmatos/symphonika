import type {
  RoutineFanoutStatus,
  RoutineFanoutTargetStatus,
  RoutineFiringStatus
} from "../run-store.js";
import {
  escapeHtml,
  formatPullRequestReference,
  htmlShell
} from "../notifications/message.js";
import { unverifiedOutcomeSuffix } from "./outcome.js";

export type RoutineFanoutNotification = {
  fanout: RoutineFanoutStatus;
  html: string;
  subject: string;
  text: string;
};

export function renderRoutineFanoutNotification(
  fanout: RoutineFanoutStatus
): RoutineFanoutNotification {
  const summaries = fanout.targets.map((target) => ({
    summary: targetSummary(target),
    target
  }));
  const text = [
    fanout.routineName,
    `Scheduled: ${fanout.scheduledAt}`,
    `Fan-out: ${fanout.id}`,
    "",
    "Projects:",
    ...summaries.map(
      ({ target, summary }) => `- ${target.projectName}: ${summary.text}`
    )
  ].join("\n");
  const html = htmlShell([
    `<h1>${escapeHtml(fanout.routineName)}</h1>`,
    `<p><strong>Scheduled:</strong> ${escapeHtml(fanout.scheduledAt)}<br>`,
    `<strong>Fan-out:</strong> ${escapeHtml(fanout.id)}</p>`,
    "<h2>Projects</h2>",
    "<ul>",
    ...summaries.map(
      ({ target, summary }) =>
        `<li><strong>${escapeHtml(target.projectName)}:</strong> ${summary.html}</li>`
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

function plain(text: string): { html: string; text: string } {
  return { html: escapeHtml(text), text };
}

// Built together, not as separate text/html renderers, so the skip/missed/
// held/PR-link branches can't drift out of sync with each other (a link
// only the html half remembers to add is worse than no link).
function targetSummary(target: RoutineFanoutTargetStatus): {
  html: string;
  text: string;
} {
  if (target.disposition === "skipped") {
    return plain(`skipped (${target.skipReason ?? "unspecified"})`);
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
    return plain(
      `did not run (${target.skipReason ?? "unspecified"})${attempts}`
    );
  }
  if (target.disposition === "held") {
    return plain(`held (${target.holdReason ?? "provider unavailable"})`);
  }
  if (target.firing === null) {
    return plain(target.disposition);
  }
  const { firing } = target;
  const terminalReason =
    firing.terminalReason === null ? "" : ` (${firing.terminalReason})`;
  const prefix = `${firing.state}${terminalReason}`;
  const pullRequests = firing.pullRequests;
  // A succeeded firing with no discovered PR isn't necessarily a discovery
  // bug — a routine (e.g. pm-deepen) can legitimately commit a report and
  // stop short of opening one. Surface why so "succeeded" with no PR reads
  // as an explained outcome rather than a silent gap. The verified/unverified
  // suffix is shared with formatRoutineOutcomeLine so an error or unverified
  // claim never reads as an explained success here.
  if (pullRequests.length === 0) {
    return plain(`${prefix}${outcomeDetail(firing.outcome)}`);
  }
  const items = pullRequests.map((pullRequest) =>
    formatPullRequestReference(pullRequest)
  );
  return {
    html: `${escapeHtml(prefix)} — PR ${items.map((item) => item.html).join(", ")}`,
    text: `${prefix} — PR ${items.map((item) => item.text).join(", ")}`
  };
}

function outcomeDetail(outcome: RoutineFiringStatus["outcome"]): string {
  if (outcome === null) {
    return "";
  }
  const unverified = unverifiedOutcomeSuffix(outcome);
  if (outcome.status === "error") {
    return ` — ${outcome.summary || "error"}${unverified}`;
  }
  if (outcome.action === "none") {
    return ` — nothing to do${unverified}`;
  }
  return ` — ${outcome.title}${unverified}`;
}
