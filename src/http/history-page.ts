// #868: deterministic, GET-only work history reports — all Projects at
// `/history`, one Project at `/projects/:name/history`, over a rolling
// `?window=7d|30d` or an explicit `?from=&to=` UTC range.
//
// Rendered straight from persisted evidence (src/work-history.ts) and
// recomputed on every request: nothing is stored, so "revisiting" a report
// means requesting the same explicit from/to again (a rolling request prints
// the range it resolved to as that permalink). The three kinds of statement
// stay in separate, labelled sections: completed work (recorded execution
// evidence), current GitHub observations (with poll freshness), and past
// Maestro suggestions (proposals, read through a function of their own and
// never counted or cited as evidence).
import type { Context, Hono } from "hono";

import type { RunStore } from "../run-store.js";
import { formatAge } from "../watchdog-status.js";
import {
  buildWorkHistory,
  listMaestroSuggestions,
  parseHistoryRange,
  type HistoryItem,
  type HistoryItemKind,
  type HistoryRange,
  type HistorySection,
  type MaestroSuggestion,
  type ObservedHistoryItem,
  type WorkHistory
} from "../work-history.js";
import { projectHref } from "../work-briefing.js";
import {
  citationLink,
  renderEvidence,
  renderFreshness
} from "./briefing-page.js";
import { escapeHtml, layout, renderTimestamp } from "./pages.js";

export type RegisterHistoryPageOptions = {
  app: Hono;
  getPollingIntervalMs: () => number;
  now: () => number;
  runStore: RunStore;
  startedAtMs: number;
};

const TIME_LABELS: Record<HistoryItemKind, string> = {
  merge_attempt: "merge attempt recorded",
  observed_pull_request: "seen merged in a poll",
  pending_pull_request: "last observed open",
  pull_request: "state last observed by Symphonika",
  run_outcome: "Run reached this state"
};

function historyPath(projectName: string | undefined): string {
  return projectName === undefined
    ? "/history"
    : `${projectHref(projectName)}/history`;
}

function rangeQuery(range: HistoryRange): string {
  return `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
}

function renderRangePicker(
  range: HistoryRange,
  projectName: string | undefined
): string {
  const base = historyPath(projectName);
  const link = (window: string, label: string): string =>
    `<a href="${base}?window=${window}"${range.window === window ? ' aria-current="page"' : ""}>${label}</a>`;
  return (
    `<nav aria-label="History range" class="note">${link("7d", "Last 7 days")} · ${link("30d", "Last 30 days")}</nav>` +
    `<form class="filters" method="get" action="${base}" aria-label="Custom date range">` +
    `<label>From (UTC date, inclusive)<input type="date" name="from" required></label>` +
    `<label>To (UTC date, exclusive)<input type="date" name="to" required></label>` +
    `<button class="btn" type="submit">Show range</button></form>`
  );
}

function renderRangeSummary(
  history: WorkHistory,
  projectName: string | undefined
): string {
  const { range } = history;
  const permalink = `${historyPath(projectName)}?${rangeQuery(range)}`;
  const kind =
    range.kind === "rolling"
      ? `Rolling last ${range.window === "30d" ? "30" : "7"} days, resolved when this report was assembled.`
      : "Custom range.";
  return (
    `<p class="note">${escapeHtml(kind)} Events from <code>${escapeHtml(range.from)}</code> (inclusive) to <code>${escapeHtml(range.to)}</code> (exclusive), UTC. ` +
    `<a href="${escapeHtml(permalink)}">Exact range, to request again</a>.</p>` +
    `<p class="note">Assembled at ${renderTimestamp(history.assembledAt)} from persisted Runs, tracked pull requests, merge attempts and poll snapshots, and recomputed on every request. GitHub was not called. Each event is attributed to the time it was recorded, never to when its Issue or Run was created.</p>`
  );
}

function omittedNote(section: HistorySection<unknown>): string {
  return section.omitted === 0
    ? ""
    : `<p class="note">${section.omitted} more not shown; request a narrower range or one Project.</p>`;
}

function sectionHead(title: string, count: number, note: string): string {
  return `<div class="section-head"><h2>${escapeHtml(title)}</h2><span class="count">${count}</span></div><p class="note">${note}</p>`;
}

function emptyBlock(message: string): string {
  return `<div class="empty"><strong>Nothing here</strong>${escapeHtml(message)}</div>`;
}

function renderWhat(item: HistoryItem): string {
  const issue = item.citations.find((citation) => citation.kind === "issue");
  const pullRequest = item.citations.find(
    (citation) => citation.kind === "pull_request"
  );
  const parts: string[] = [];
  if (item.kind === "run_outcome") {
    const label = `#${item.issueNumber ?? "?"} ${escapeHtml(item.title)}`;
    parts.push(
      issue === undefined
        ? label
        : `<a href="${escapeHtml(issue.href)}">${label}</a>`
    );
  } else {
    const label = escapeHtml(item.title);
    parts.push(
      pullRequest !== undefined
        ? `<a href="${escapeHtml(pullRequest.href)}">${label}</a>`
        : item.pullRequestUrl !== null
          ? `<a href="${escapeHtml(item.pullRequestUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`
          : label
    );
    if (item.issueNumber !== null) {
      parts.push(
        issue === undefined
          ? `<span class="muted">Issue #${item.issueNumber} (no current snapshot)</span>`
          : `<span class="muted">Issue ${citationLink(issue)}</span>`
      );
    }
  }
  if (item.detail !== null && item.detail !== "") {
    parts.push(`<span class="muted">${escapeHtml(item.detail)}</span>`);
  }
  return parts.join("<br>");
}

function renderItemTable(
  items: Array<HistoryItem | ObservedHistoryItem>,
  options: { showFreshness: boolean; showProject: boolean; timeHeading: string }
): string {
  const rows = items
    .map((item) => {
      const project = options.showProject
        ? `<td><a href="${escapeHtml(projectHref(item.projectName))}">${escapeHtml(item.projectName)}</a></td>`
        : "";
      const freshness =
        options.showFreshness && "freshness" in item
          ? `<td class="c-detail">${renderFreshness(item.freshness)}</td>`
          : "";
      return `<tr><td>${renderTimestamp(item.eventAt)}<br><span class="muted">${escapeHtml(TIME_LABELS[item.kind])}</span></td>${project}<td class="c-title">${renderWhat(item)}</td><td>${escapeHtml(item.outcome)}</td>${freshness}<td class="c-detail">${renderEvidence(item)}</td></tr>`;
    })
    .join("");
  const projectHead = options.showProject ? "<th>Project</th>" : "";
  const freshnessHead = options.showFreshness ? "<th>Freshness</th>" : "";
  return `<div class="table-wrap"><table><thead><tr><th>${escapeHtml(options.timeHeading)}</th>${projectHead}<th>What</th><th>Outcome</th>${freshnessHead}<th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderOutcomeSection(
  anchor: string,
  title: string,
  note: string,
  empty: string,
  section: HistorySection<HistoryItem>,
  showProject: boolean
): string {
  const body =
    section.items.length === 0
      ? emptyBlock(empty)
      : renderItemTable(section.items, {
          showFreshness: false,
          showProject,
          timeHeading: "Event time (UTC)"
        });
  return `<section id="${anchor}">${sectionHead(title, section.items.length + section.omitted, note)}${body}${omittedNote(section)}</section>`;
}

function renderObservations(
  history: WorkHistory,
  nowMs: number,
  showProject: boolean
): string {
  const { observations } = history;
  const freshnessRows = observations.freshness
    .map(
      (project) =>
        `<tr><td><a href="${escapeHtml(projectHref(project.projectName))}">${escapeHtml(project.projectName)}</a></td><td>${escapeHtml(formatAge(project.lastSuccessfulPollAt, nowMs))}</td><td class="c-detail">${renderFreshness(project)}</td></tr>`
    )
    .join("");
  const freshness =
    observations.freshness.length === 0
      ? ""
      : `<h3>Poll freshness</h3><div class="table-wrap"><table><thead><tr><th>Project</th><th>Last successful poll</th><th>Status</th></tr></thead><tbody>${freshnessRows}</tbody></table></div>`;
  const pending = observations.pendingPullRequests;
  const merged = observations.observedMergedPullRequests;
  const pendingBlock =
    `<h3>Pull requests open now</h3>` +
    (pending.items.length === 0
      ? emptyBlock("No tracked pull request is open.")
      : renderItemTable(pending.items, {
          showFreshness: true,
          showProject,
          timeHeading: "Last observed (UTC)"
        })) +
    omittedNote(pending);
  const mergedBlock =
    `<h3>Merged pull requests seen only in a poll</h3>` +
    (merged.items.length === 0
      ? emptyBlock(
          "No merged pull request without a tracked event time was seen in this range."
        )
      : renderItemTable(merged.items, {
          showFreshness: true,
          showProject,
          timeHeading: "Polled (UTC)"
        })) +
    omittedNote(merged);
  const count = pending.items.length + merged.items.length;
  return `<section id="history-observations">${sectionHead(
    "Current GitHub observations",
    count,
    "The latest persisted GitHub state as of this report, not events inside the range. A merge seen only in a poll has no tracked event time of its own, so it is shown as observed rather than completed. Check each item's freshness: a stale poll or failed GitHub read means it may be out of date."
  )}${freshness}${pendingBlock}${mergedBlock}</section>`;
}

function renderSuggestions(section: HistorySection<MaestroSuggestion>): string {
  const rows = section.items
    .map(
      (suggestion) =>
        `<tr><td>${renderTimestamp(suggestion.createdAt)}</td><td>${suggestion.projectName === null ? "Dashboard chat" : `<a href="${escapeHtml(projectHref(suggestion.projectName))}/maestro">${escapeHtml(suggestion.projectName)} chat</a>`}</td><td class="c-detail">${escapeHtml(suggestion.content)}${suggestion.truncated ? " …" : ""}</td></tr>`
    )
    .join("");
  const body =
    section.items.length === 0
      ? emptyBlock("No Maestro replies were recorded in this range.")
      : `<div class="table-wrap"><table><thead><tr><th>Said at (UTC)</th><th>Conversation</th><th>Suggestion, not evidence</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  return `<section id="history-suggestions">${sectionHead(
    "Maestro suggestions",
    section.items.length + section.omitted,
    "What Maestro said in chat during this range. These are proposals read back from the conversation: they are not counted as completed work and are not evidence that anything happened. Only the sections above are built from recorded Runs, pull requests and polls."
  )}${body}${omittedNote(section)}</section>`;
}

function renderHistory(
  history: WorkHistory,
  suggestions: HistorySection<MaestroSuggestion>,
  nowMs: number
): string {
  const { scope } = history;
  const projectName = scope.kind === "project" ? scope.projectName : undefined;
  const showProject = scope.kind === "all";
  const title =
    scope.kind === "all"
      ? "Work history"
      : `Work history: ${escapeHtml(scope.projectName)}`;
  const links =
    scope.kind === "all"
      ? `<a href="/">Dashboard</a> · <a href="/briefing">Work briefing</a> · <a href="/maestro">Maestro</a>`
      : `<a href="${escapeHtml(projectHref(scope.projectName))}">Back to ${escapeHtml(scope.projectName)}</a> · <a href="/history">All Projects</a> · <a href="${escapeHtml(projectHref(scope.projectName))}/briefing">Work briefing for this Project</a> · <a href="${escapeHtml(projectHref(scope.projectName))}/maestro">Maestro</a>`;
  const nav =
    `<nav aria-label="History sections" class="note">` +
    `<a href="#history-completed">Completed</a> · <a href="#history-unsuccessful">Ended without success</a> · <a href="#history-observations">GitHub observations</a> · <a href="#history-suggestions">Maestro suggestions</a></nav>`;
  return (
    `<h1 class="page-title">${title}</h1>` +
    `<p class="note">${links}</p>` +
    renderRangePicker(history.range, projectName) +
    renderRangeSummary(history, projectName) +
    nav +
    renderOutcomeSection(
      "history-completed",
      "Completed work",
      "Recorded execution evidence that finished successfully inside the range: Runs that reached succeeded, tracked pull requests last observed merged, and merge attempts that succeeded.",
      "No completed work was recorded in this range.",
      history.completed,
      showProject
    ) +
    renderOutcomeSection(
      "history-unsuccessful",
      "Ended without success",
      "Recorded outcomes inside the range that are not completed work: failed, blocked, stale, cancelled or input-required Runs, closed pull requests, and failed merge attempts.",
      "No unsuccessful outcome was recorded in this range.",
      history.unsuccessful,
      showProject
    ) +
    renderObservations(history, nowMs, showProject) +
    renderSuggestions(suggestions)
  );
}

export function registerHistoryPage(options: RegisterHistoryPageOptions): void {
  const render = (context: Context, projectName: string | undefined) => {
    // An unknown Project is a 404 whatever the range says.
    if (
      projectName !== undefined &&
      !options.runStore
        .getProjectStatesByName({ includeInactive: true })
        .has(projectName)
    ) {
      return context.html(
        layout(
          "Project not found",
          `<h1 class="page-title">Project not found</h1><p class="lede">Project <code>${escapeHtml(projectName)}</code> was not found.</p>`
        ),
        404
      );
    }
    const nowMs = options.now();
    const parsed = parseHistoryRange(
      {
        from: context.req.query("from"),
        to: context.req.query("to"),
        window: context.req.query("window")
      },
      nowMs
    );
    if (!parsed.ok) {
      const base = historyPath(projectName);
      return context.html(
        layout(
          "Invalid history range",
          `<h1 class="page-title">Invalid history range</h1><p class="lede">${escapeHtml(parsed.error)}</p>` +
            `<p class="note">Try <a href="${base}?window=7d">the last 7 days</a>, <a href="${base}?window=30d">the last 30 days</a>, or an explicit range such as <code>?from=2026-10-01&amp;to=2026-10-08</code> (UTC, from inclusive, to exclusive).</p>`
        ),
        400
      );
    }
    const history = buildWorkHistory({
      nowMs,
      pollingIntervalMs: options.getPollingIntervalMs(),
      projectName,
      range: parsed.range,
      runStore: options.runStore,
      startedAtMs: options.startedAtMs
    });
    if (history === undefined) {
      return context.notFound();
    }
    const suggestions = listMaestroSuggestions({
      projectName,
      range: history.range,
      runStore: options.runStore
    });
    return context.html(
      layout(
        projectName === undefined
          ? "Work history"
          : `Work history: ${projectName}`,
        renderHistory(history, suggestions, nowMs)
      )
    );
  };

  options.app.get("/history", (context) => render(context, undefined));
  options.app.get("/projects/:name/history", (context) =>
    render(context, context.req.param("name"))
  );
}
