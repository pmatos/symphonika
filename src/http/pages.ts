import { Hono } from "hono";

import type {
  ListRunsFilter,
  RunState,
  RunStatus,
  RunStore
} from "../run-store.js";
import type { StatusSnapshot } from "../status.js";

export type RegisterPagesOptions = {
  app: Hono;
  getStatusSnapshot?: () => StatusSnapshot;
  runStore: RunStore;
  version: string;
};

const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  "cancelled",
  "failed",
  "stale",
  "succeeded"
]);

const KNOWN_RUN_STATES: ReadonlySet<RunState> = new Set([
  "queued",
  "preparing_workspace",
  "running",
  "input_required",
  "failed",
  "succeeded",
  "cancelled",
  "stale"
]);

export function registerPages(options: RegisterPagesOptions): void {
  options.app.get("/", (context) => {
    const snapshot = options.getStatusSnapshot?.();
    const recentRuns = options.runStore.listRuns({ limit: 25 });
    const html = layout(
      "Symphonika",
      [
        renderHeader(options.version, snapshot),
        renderProjectsCard(snapshot),
        renderRunsTable("Recent runs", recentRuns)
      ].join("")
    );
    return context.html(html);
  });

  options.app.get("/runs", (context) => {
    const filter: ListRunsFilter = {};
    const stateParam = context.req.query("state");
    if (stateParam !== undefined && KNOWN_RUN_STATES.has(stateParam as RunState)) {
      filter.state = stateParam as RunState;
    }
    const project = context.req.query("project");
    if (project !== undefined) {
      filter.project = project;
    }
    const runs = options.runStore.listRuns(filter);
    const title = filter.state === undefined ? "All runs" : `Runs (${filter.state})`;
    const html = layout(title, renderRunsTable(title, runs));
    return context.html(html);
  });

  options.app.get("/runs/:id", (context) => {
    const id = context.req.param("id");
    const detail = options.runStore.getRun(id);
    if (detail === undefined) {
      return context.html(
        layout("Run not found", `<p>Run ${escapeHtml(id)} not found.</p>`),
        404
      );
    }

    const events = options.runStore.listProviderEvents(id, { limit: 100 });
    const sections = [
      `<h1>Run ${escapeHtml(detail.id)}</h1>`,
      renderRunSummary(detail),
      renderCancelForm(detail),
      renderAttemptsTable(detail.attempts),
      renderTransitionsTable(detail.transitions),
      renderEventsTable(events),
      renderRunFileLinks(detail)
    ].join("");
    return context.html(layout(`Run ${detail.id}`, sections));
  });
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: system-ui, -apple-system, Helvetica, Arial, sans-serif; margin: 1.5rem; color: #1a1a1a; }
header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 1rem; }
h1, h2, h3 { margin: 0.6rem 0; }
table { border-collapse: collapse; width: 100%; margin: 0.6rem 0 1.2rem; }
th, td { padding: 0.35rem 0.6rem; border-bottom: 1px solid #ddd; text-align: left; vertical-align: top; font-size: 0.9rem; }
th { background: #f5f5f5; }
code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.state-running, .state-queued, .state-preparing_workspace, .state-input_required { color: #b06c00; }
.state-failed, .state-cancelled, .state-stale { color: #b00020; }
.state-succeeded { color: #007a3d; }
nav a { margin-right: 1rem; }
</style>
</head>
<body>
<header><h1><a href="/">Symphonika</a></h1><nav><a href="/">Dashboard</a><a href="/runs">Runs</a></nav></header>
${body}
</body>
</html>`;
}

function renderHeader(version: string, snapshot: StatusSnapshot | undefined): string {
  const stateRoot = snapshot?.stateRoot ?? "";
  const issuePolling = snapshot?.issuePolling;
  const candidateCount = issuePolling?.candidateIssues.length ?? 0;
  const filteredCount = issuePolling?.filteredIssues.length ?? 0;
  const errors = issuePolling?.errors ?? [];
  const errorList =
    errors.length === 0
      ? ""
      : `<ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>`;
  return `<section>
  <p><strong>Version:</strong> <code>${escapeHtml(version)}</code></p>
  <p><strong>State root:</strong> <code>${escapeHtml(stateRoot)}</code></p>
  <p><strong>Eligible issues:</strong> ${candidateCount} &middot; <strong>Filtered:</strong> ${filteredCount}</p>
  ${errorList}
</section>`;
}

function renderProjectsCard(snapshot: StatusSnapshot | undefined): string {
  if (snapshot === undefined || snapshot.projects.length === 0) {
    return "";
  }

  const rows = snapshot.projects
    .map((project) => {
      const missing =
        project.missingOperationalLabels.length === 0
          ? "&mdash;"
          : escapeHtml(project.missingOperationalLabels.join(", "));
      const valid = project.validForDispatch ? "valid" : "invalid";
      return `<tr><td>${escapeHtml(project.name)}</td><td>${escapeHtml(valid)}</td><td><code>${escapeHtml(project.workflowPath)}</code></td><td>${missing}</td></tr>`;
    })
    .join("");
  return `<section><h2>Projects</h2>
<table><thead><tr><th>Name</th><th>Validation</th><th>Workflow</th><th>Missing operational labels</th></tr></thead>
<tbody>${rows}</tbody></table></section>`;
}

function renderRunsTable(title: string, runs: RunStatus[]): string {
  if (runs.length === 0) {
    return `<section><h2>${escapeHtml(title)}</h2><p><em>No runs yet.</em></p></section>`;
  }

  const rows = runs
    .map(
      (run) =>
        `<tr><td><a href="/runs/${encodeURIComponent(run.id)}"><code>${escapeHtml(run.id)}</code></a></td><td>${escapeHtml(run.project)}</td><td>#${run.issueNumber} ${escapeHtml(run.issueTitle)}</td><td><span class="state-${escapeHtml(run.state)}">${escapeHtml(run.state)}</span></td><td>${escapeHtml(run.provider)}</td><td><code>${escapeHtml(run.branchName)}</code></td></tr>`
    )
    .join("");
  return `<section><h2>${escapeHtml(title)}</h2>
<table><thead><tr><th>Run id</th><th>Project</th><th>Issue</th><th>State</th><th>Provider</th><th>Branch</th></tr></thead>
<tbody>${rows}</tbody></table></section>`;
}

function renderRunSummary(detail: RunStatus): string {
  return `<section>
  <p><strong>Project:</strong> ${escapeHtml(detail.project)}</p>
  <p><strong>Issue:</strong> #${detail.issueNumber} ${escapeHtml(detail.issueTitle)}</p>
  <p><strong>State:</strong> <span class="state-${escapeHtml(detail.state)}">${escapeHtml(detail.state)}</span></p>
  <p><strong>Provider:</strong> ${escapeHtml(detail.provider)}</p>
  <p><strong>Branch:</strong> <code>${escapeHtml(detail.branchName)}</code></p>
  <p><strong>Workspace:</strong> <code>${escapeHtml(detail.workspacePath)}</code></p>
  <p><strong>Retries:</strong> ${detail.retryCount}${detail.isContinuation ? " (continuation)" : ""}</p>
  ${detail.terminalReason !== null ? `<p><strong>Terminal reason:</strong> ${escapeHtml(detail.terminalReason)}</p>` : ""}
  ${detail.cancelRequested ? `<p><strong>Cancel requested</strong> (reason: ${escapeHtml(detail.cancelReason ?? "unknown")})</p>` : ""}
</section>`;
}

function renderCancelForm(detail: { id: string; state: RunState }): string {
  if (TERMINAL_STATES.has(detail.state)) {
    return "";
  }
  return `<section><form method="post" action="/api/runs/${encodeURIComponent(detail.id)}/cancel"><button type="submit">Cancel run</button></form></section>`;
}

function renderAttemptsTable(
  attempts: {
    id: string;
    attemptNumber: number;
    state: RunState;
    providerName: string;
    branchName: string;
    promptPath: string;
  }[]
): string {
  if (attempts.length === 0) {
    return `<section><h2>Attempts</h2><p><em>No attempts recorded.</em></p></section>`;
  }
  const rows = attempts
    .map(
      (attempt) =>
        `<tr><td>${attempt.attemptNumber}</td><td><code>${escapeHtml(attempt.id)}</code></td><td><span class="state-${escapeHtml(attempt.state)}">${escapeHtml(attempt.state)}</span></td><td>${escapeHtml(attempt.providerName)}</td><td><code>${escapeHtml(attempt.branchName)}</code></td><td><code>${escapeHtml(attempt.promptPath)}</code></td></tr>`
    )
    .join("");
  return `<section><h2>Attempts</h2><table><thead><tr><th>#</th><th>Attempt id</th><th>State</th><th>Provider</th><th>Branch</th><th>Prompt</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function renderTransitionsTable(
  transitions: { sequence: number; state: RunState; createdAt: string }[]
): string {
  if (transitions.length === 0) {
    return "";
  }
  const rows = transitions
    .map(
      (transition) =>
        `<tr><td>${transition.sequence}</td><td><span class="state-${escapeHtml(transition.state)}">${escapeHtml(transition.state)}</span></td><td>${escapeHtml(transition.createdAt)}</td></tr>`
    )
    .join("");
  return `<section><h2>State transitions</h2><table><thead><tr><th>Seq</th><th>State</th><th>At</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function renderEventsTable(
  events: {
    sequence: number;
    type: string;
    createdAt: string;
    normalized: { type: string; [key: string]: unknown };
  }[]
): string {
  if (events.length === 0) {
    return `<section><h2>Recent events</h2><p><em>No events recorded yet.</em></p></section>`;
  }
  const rows = events
    .map((event) => {
      const message =
        typeof event.normalized.message === "string"
          ? event.normalized.message
          : JSON.stringify(event.normalized);
      return `<tr><td>${event.sequence}</td><td>${escapeHtml(event.type)}</td><td><code>${escapeHtml(message)}</code></td><td>${escapeHtml(event.createdAt)}</td></tr>`;
    })
    .join("");
  return `<section><h2>Recent events (last ${events.length})</h2><table><thead><tr><th>Seq</th><th>Type</th><th>Detail</th><th>At</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function renderRunFileLinks(detail: RunStatus): string {
  const items: string[] = [];
  const linkIfPresent = (label: string, kind: string, value: string): void => {
    if (value.length === 0) {
      return;
    }
    items.push(
      `<li><a href="/api/runs/${encodeURIComponent(detail.id)}/files/${kind}">${escapeHtml(label)}</a></li>`
    );
  };
  linkIfPresent("Rendered prompt", "prompt", detail.promptPath);
  linkIfPresent("Provider raw log", "raw-log", detail.rawLogPath);
  linkIfPresent("Normalized log", "normalized-log", detail.normalizedLogPath);
  linkIfPresent("Issue snapshot", "issue-snapshot", detail.issueSnapshotPath);
  linkIfPresent("Prompt metadata", "metadata", detail.metadataPath);
  if (items.length === 0) {
    return "";
  }
  return `<section><h2>Files</h2><ul>${items.join("")}</ul></section>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
