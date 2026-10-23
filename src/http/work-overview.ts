// #856: an all-Projects "actionable daily work overview" for the dashboard.
//
// The classification itself (the four-bucket precedence rules and orderings)
// lives in the shared, HTTP-free src/work-briefing.ts, which Maestro's work
// briefing (#868) reads too; this module only renders it as dashboard HTML.
import { escapeHtml } from "../notifications/message.js";
import {
  classifyWork,
  type ScheduledCallback,
  type WorkBuckets,
  type WorkEntry,
  type WorkGroup,
  type WorkProjectProvenance
} from "../work-briefing.js";
import type { RunStore } from "../run-store.js";
import { formatAge } from "../watchdog-status.js";

type WorkOverviewData = WorkBuckets;

export function buildWorkOverview(input: {
  nowMs: number;
  runStore: RunStore;
  scheduled: readonly ScheduledCallback[];
  startedAtMs: number | undefined;
}): WorkOverviewData {
  return classifyWork({ ...input, order: "overview" });
}

function entryIssueLink(entry: WorkEntry): string {
  const label = `#${entry.issueNumber} ${escapeHtml(entry.title)}`;
  if (!entry.hasSnapshot) {
    return label;
  }
  const href = `/issues/${encodeURIComponent(entry.projectName)}/${entry.issueNumber}`;
  return `<a href="${escapeHtml(href)}">${label}</a>`;
}

function entryProjectLink(entry: WorkEntry): string {
  const href = `/projects/${encodeURIComponent(entry.projectName)}`;
  const repo =
    entry.repository === undefined
      ? ""
      : ` <span class="muted">(${escapeHtml(entry.repository.owner)}/${escapeHtml(entry.repository.repo)})</span>`;
  return `<a href="${escapeHtml(href)}">${escapeHtml(entry.projectName)}</a>${repo}`;
}

function entryEvidenceLinks(entry: WorkEntry): string {
  const links: string[] = [];
  if (entry.runId !== undefined) {
    links.push(
      `<a href="/runs/${encodeURIComponent(entry.runId)}">run ${escapeHtml(entry.runId)}</a>`
    );
  }
  if (entry.prNumber !== undefined) {
    links.push(
      `<a href="/prs/${encodeURIComponent(entry.projectName)}/${entry.prNumber}">PR #${entry.prNumber}</a>`
    );
  }
  return links.length === 0 ? "—" : links.join(" · ");
}

function entryPriorityLabel(entry: WorkEntry): string {
  return entry.priority === undefined ? "—" : `P${entry.priority}`;
}

function entryAgeText(entry: WorkEntry, nowMs: number): string {
  if (entry.runUpdatedAt !== undefined) {
    return `updated ${formatAge(entry.runUpdatedAt, nowMs)}`;
  }
  if (entry.issueCreatedAt !== undefined) {
    return `opened ${formatAge(entry.issueCreatedAt, nowMs)}`;
  }
  return "age unknown";
}

function entryPollText(entry: WorkEntry, nowMs: number): string {
  if (entry.polledAt === undefined) {
    return "—";
  }
  const preRestart = entry.preRestart
    ? ' <span class="muted">(pre-restart)</span>'
    : "";
  return `${escapeHtml(formatAge(entry.polledAt, nowMs))}${preRestart}`;
}

function renderGroupTable(entries: WorkEntry[], nowMs: number): string {
  if (entries.length === 0) {
    return `<div class="empty"><strong>Nothing here</strong>No Issues currently fall into this group.</div>`;
  }
  const rows = entries
    .map(
      (entry) =>
        `<tr><td class="c-title">${entryIssueLink(entry)}</td><td>${entryProjectLink(entry)}</td><td>${entryPriorityLabel(entry)}</td><td class="c-detail">${escapeHtml(entry.reasonText)}</td><td>${escapeHtml(entryAgeText(entry, nowMs))}</td><td>${entryPollText(entry, nowMs)}</td><td>${entryEvidenceLinks(entry)}</td></tr>`
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>Issue</th><th>Project</th><th>Priority</th><th>Reason</th><th>Age</th><th>Last polled</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderProvenanceList(
  projects: WorkProjectProvenance[],
  nowMs: number
): string {
  if (projects.length === 0) {
    return "";
  }
  const rows = projects
    .map((project) => {
      const pollAge = formatAge(project.lastSuccessfulPollAt, nowMs);
      const preRestart = project.preRestart
        ? ' <span class="muted">(pre-restart)</span>'
        : "";
      const status =
        project.lastPollOk === false
          ? `<span class="pill pill--fail"><span class="pill-dot" aria-hidden="true"></span>failing</span>${project.lastPollError === null ? "" : ` <span class="muted">(${escapeHtml(project.lastPollError)})</span>`}`
          : `<span class="pill pill--ok"><span class="pill-dot" aria-hidden="true"></span>ok</span>`;
      return `<tr><td>${escapeHtml(project.projectName)}</td><td>${escapeHtml(pollAge)}${preRestart}</td><td>${status}</td></tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>Project</th><th>Last successful poll</th><th>Polling</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

const GROUP_HEADINGS: ReadonlyArray<{
  anchor: string;
  description: string;
  group: WorkGroup;
  title: string;
}> = [
  {
    anchor: "work-overview-needs-attention",
    description: "Blocked, failed, stale, or awaiting operator input.",
    group: "needsAttention",
    title: "Needs attention"
  },
  {
    anchor: "work-overview-ready",
    description: "Eligible now, ordered by configured priority then age.",
    group: "ready",
    title: "Ready"
  },
  {
    anchor: "work-overview-ongoing",
    description: "A Run is active or parked, or a PR is awaiting review.",
    group: "ongoing",
    title: "Ongoing / in review"
  },
  {
    anchor: "work-overview-not-ready",
    description: "Filtered by a label, dependency, or operational gate.",
    group: "notReady",
    title: "Not ready"
  }
];

// Not wired into the dashboard's SSE live-fragment refresh (ADR 0074) today
// — this section's own "as of" timestamp is what keeps it from being
// mistaken for live state in the meantime, per the issue's own AC3.
export function renderWorkOverviewSection(data: WorkOverviewData): string {
  const nowMs = data.assembledAtMs;
  const nav = GROUP_HEADINGS.map(
    (heading) => `<a href="#${heading.anchor}">${escapeHtml(heading.title)}</a>`
  ).join(" · ");
  const groups = GROUP_HEADINGS.map((heading) => {
    const entries = data[heading.group];
    return `<section id="${heading.anchor}"><div class="section-head"><h2>${escapeHtml(heading.title)}</h2><span class="count">${entries.length}</span></div><p class="note">${escapeHtml(heading.description)}</p>${renderGroupTable(entries, nowMs)}</section>`;
  }).join("");
  return `<section id="work-overview"><div class="section-head"><h2>Work overview</h2></div><p class="note">Assembled at ${escapeHtml(new Date(nowMs).toISOString())} — not live; reload to refresh.</p><nav aria-label="Work overview groups" class="note">${nav}</nav>${renderProvenanceList(data.projects, nowMs)}${groups}</section>`;
}
