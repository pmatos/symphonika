// #868: deterministic, GET-only work briefing reports — all Projects at
// `/briefing`, one Project at `/projects/:name/briefing`.
//
// Rendered straight from the same persisted evidence Maestro's
// get_work_briefing tool reads (src/work-briefing.ts), never from a chat
// message or model prose: no maestro_* table is queried here, so what a chat
// claimed can never appear on this page as execution evidence. The page is
// read-only and never calls GitHub; every item states how old the
// observation behind it is.
import type { Context, Hono } from "hono";

import type { MaestroCitation, RunStore } from "../run-store.js";
import { formatAge } from "../watchdog-status.js";
import {
  BRIEFING_GROUP_ORDER,
  buildWorkBriefing,
  type BriefingFreshness,
  type BriefingFreshnessLabel,
  type BriefingItem,
  type ScheduledCallback,
  type WorkBriefing,
  type WorkGroup
} from "../work-briefing.js";
import { escapeHtml, layout, renderTimestamp } from "./pages.js";

export type RegisterBriefingPageOptions = {
  app: Hono;
  getPollingIntervalMs: () => number;
  getScheduled: () => readonly ScheduledCallback[];
  now: () => number;
  runStore: RunStore;
  startedAtMs: number;
};

const GROUP_HEADINGS: Record<
  WorkGroup,
  { anchor: string; description: string; title: string }
> = {
  needsAttention: {
    anchor: "briefing-needs-attention",
    description:
      "Blocked, failed, stale, or awaiting operator input — these need you.",
    title: "Needs attention"
  },
  notReady: {
    anchor: "briefing-not-ready",
    description: "Filtered by a label, dependency, or operational gate.",
    title: "Not ready"
  },
  ongoing: {
    anchor: "briefing-ongoing",
    description: "A Run is active or parked, or a PR is awaiting review.",
    title: "Ongoing / in review"
  },
  ready: {
    anchor: "briefing-ready",
    description: "Eligible now, ordered by configured priority then age.",
    title: "Ready"
  }
};

const FRESHNESS_PILLS: Record<
  BriefingFreshnessLabel,
  { className: string; text: string }
> = {
  never_polled: { className: "pill--neutral", text: "never polled" },
  poll_failed: { className: "pill--fail", text: "GitHub read failed" },
  pre_restart: { className: "pill--neutral", text: "pre-restart" },
  stale: { className: "pill--blocked", text: "stale poll" }
};

function pill(className: string, text: string): string {
  return `<span class="pill ${className}"><span class="pill-dot" aria-hidden="true"></span>${escapeHtml(text)}</span>`;
}

function renderFreshness(freshness: BriefingFreshness): string {
  if (freshness.labels.length === 0) {
    return pill("pill--ok", "fresh");
  }
  const pills = freshness.labels
    .map((label) => {
      const spec = FRESHNESS_PILLS[label];
      return pill(spec.className, spec.text);
    })
    .join(" ");
  return `${pills}<br><span class="muted">${escapeHtml(freshness.note)}</span>`;
}

function citationLink(citation: MaestroCitation): string {
  return `<a href="${escapeHtml(citation.href)}">${escapeHtml(citation.label)}</a>`;
}

function renderEvidence(item: BriefingItem): string {
  return `<ul class="briefing-evidence">${item.citations
    .map(
      (citation) =>
        `<li>${escapeHtml(citation.kind.replace("_", " "))}: ${citationLink(citation)} <span class="muted">(observed ${renderTimestamp(citation.observedAt)})</span></li>`
    )
    .join("")}</ul>`;
}

function renderAge(item: BriefingItem, nowMs: number): string {
  return item.issueCreatedAt === null
    ? "age unknown"
    : `opened ${formatAge(item.issueCreatedAt, nowMs)}`;
}

function renderGroup(
  group: WorkGroup,
  items: BriefingItem[],
  options: { nowMs: number; showProject: boolean }
): string {
  const heading = GROUP_HEADINGS[group];
  const head = `<div class="section-head"><h2>${escapeHtml(heading.title)}</h2><span class="count">${items.length}</span></div><p class="note">${escapeHtml(heading.description)}</p>`;
  if (items.length === 0) {
    return `<section id="${heading.anchor}">${head}<div class="empty"><strong>Nothing here</strong>No Issues currently fall into this group.</div></section>`;
  }
  const rows = items
    .map((item) => {
      const issueLabel = `#${item.issueNumber} ${escapeHtml(item.title)}`;
      const issue = item.citations.find(
        (citation) => citation.kind === "issue"
      );
      const issueCell =
        issue === undefined
          ? issueLabel
          : `<a href="${escapeHtml(issue.href)}">${issueLabel}</a>`;
      const projectCell = options.showProject
        ? `<td><a href="/projects/${encodeURIComponent(item.projectName)}">${escapeHtml(item.projectName)}</a></td>`
        : "";
      const priority = item.priority === null ? "—" : `P${item.priority}`;
      return `<tr><td class="c-title">${issueCell}</td>${projectCell}<td>${priority}</td><td class="c-detail">${escapeHtml(item.reason.text)}<br><span class="muted">evidence: ${citationLink(item.reason.citation)}, observed ${renderTimestamp(item.reason.citation.observedAt)}</span></td><td>${escapeHtml(renderAge(item, options.nowMs))}</td><td class="c-detail">${renderFreshness(item.freshness)}</td><td class="c-detail">${renderEvidence(item)}</td></tr>`;
    })
    .join("");
  const projectHead = options.showProject ? "<th>Project</th>" : "";
  return `<section id="${heading.anchor}">${head}<div class="table-wrap"><table><thead><tr><th>Issue</th>${projectHead}<th>Priority</th><th>Reason</th><th>Age</th><th>Freshness</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderProjectFreshness(briefing: WorkBriefing, nowMs: number): string {
  if (briefing.projects.length === 0) {
    return "";
  }
  const rows = briefing.projects
    .map(
      (project) =>
        `<tr><td><a href="/projects/${encodeURIComponent(project.projectName)}">${escapeHtml(project.projectName)}</a></td><td>${escapeHtml(formatAge(project.lastSuccessfulPollAt, nowMs))}</td><td class="c-detail">${renderFreshness(project)}</td></tr>`
    )
    .join("");
  return `<section id="briefing-freshness"><div class="section-head"><h2>GitHub observation freshness</h2></div><div class="table-wrap"><table><thead><tr><th>Project</th><th>Last successful poll</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderWorkBriefing(briefing: WorkBriefing, nowMs: number): string {
  const scope = briefing.scope;
  const title =
    scope.kind === "all"
      ? "Work briefing"
      : `Work briefing: ${escapeHtml(scope.projectName)}`;
  const links =
    scope.kind === "all"
      ? `<a href="/">Dashboard</a> · <a href="/maestro">Maestro</a>`
      : `<a href="/projects/${encodeURIComponent(scope.projectName)}">Back to ${escapeHtml(scope.projectName)}</a> · <a href="/briefing">All Projects</a> · <a href="/projects/${encodeURIComponent(scope.projectName)}/maestro">Maestro</a>`;
  const nav = BRIEFING_GROUP_ORDER.map(
    (group) =>
      `<a href="#${GROUP_HEADINGS[group].anchor}">${escapeHtml(GROUP_HEADINGS[group].title)}</a>`
  ).join(" · ");
  const groups = BRIEFING_GROUP_ORDER.map((group) =>
    renderGroup(group, briefing.groups[group], {
      nowMs,
      showProject: scope.kind === "all"
    })
  ).join("");
  return (
    `<h1 class="page-title">${title}</h1>` +
    `<p class="note">${links}</p>` +
    `<p class="note">Assembled at ${renderTimestamp(briefing.assembledAt)} from persisted poll snapshots and recorded Runs. GitHub was not called, so this is not live; reload to refresh. Every item links the evidence behind it and says how old that evidence is. This report is built from that evidence only, never from Maestro chat.</p>` +
    `<nav aria-label="Briefing groups" class="note">${nav}</nav>` +
    renderProjectFreshness(briefing, nowMs) +
    groups
  );
}

export function registerBriefingPage(
  options: RegisterBriefingPageOptions
): void {
  const render = (context: Context, projectName: string | undefined) => {
    const nowMs = options.now();
    const briefing = buildWorkBriefing({
      nowMs,
      pollingIntervalMs: options.getPollingIntervalMs(),
      projectName,
      runStore: options.runStore,
      scheduled: options.getScheduled(),
      startedAtMs: options.startedAtMs
    });
    if (briefing === undefined) {
      return context.html(
        layout(
          "Project not found",
          `<h1 class="page-title">Project not found</h1><p class="lede">Project <code>${escapeHtml(projectName ?? "")}</code> was not found.</p>`
        ),
        404
      );
    }
    return context.html(
      layout(
        projectName === undefined
          ? "Work briefing"
          : `Work briefing: ${projectName}`,
        renderWorkBriefing(briefing, nowMs)
      )
    );
  };

  options.app.get("/briefing", (context) => render(context, undefined));
  options.app.get("/projects/:name/briefing", (context) =>
    render(context, context.req.param("name"))
  );
}
