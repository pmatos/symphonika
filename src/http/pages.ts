import { Hono } from "hono";

import type {
  FilteredProjectIssueSnapshot,
  IssuePollStatus
} from "../issue-polling.js";
import {
  formatCapReachedReason,
  parseCapReachedReason
} from "../lifecycle/terminal-reason.js";
import type {
  ListRunsFilter,
  ProjectState,
  ProviderEventRecord,
  RunArtifactDescriptor,
  RunState,
  RunStatus,
  RunStore
} from "../run-store.js";
import type { RoutineStatus } from "../routines/types.js";
import type { StatusSnapshot } from "../status.js";
import type { ExpandedWorkflow } from "../workflow.js";

export type RegisterPagesOptions = {
  app: Hono;
  getStatusSnapshot?: () => StatusSnapshot;
  issuePollStatus?: IssuePollStatus;
  runStore: RunStore;
  version: string;
};

const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  "cancelled",
  "failed",
  "input_required",
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

const FAILURE_STATES: ReadonlySet<RunState> = new Set(["failed", "stale"]);

// A single run's detail view is cheap to render; coalescing streamed message
// tokens collapses hundreds of rows into a handful, so fetch a generous tail.
const EVENT_TAIL_LIMIT = 500;

export function registerPages(options: RegisterPagesOptions): void {
  options.app.get("/", (context) => {
    const snapshot = options.getStatusSnapshot?.();
    const recentRuns = options.runStore.listRuns({ limit: 25 });
    const html = layout(
      "Symphonika",
      [
        renderHeader(options.version, snapshot),
        renderProjectsCard(snapshot, options.issuePollStatus),
        renderRoutinesTable(options.runStore.listRoutines()),
        renderStaleIssuesCard(options.issuePollStatus?.filteredIssues ?? []),
        renderRunsTable("Recent runs", recentRuns)
      ].join("")
    );
    return context.html(html);
  });

  options.app.get("/runs", (context) => {
    const filter: ListRunsFilter = {};
    const stateParam = context.req.query("state");
    if (
      stateParam !== undefined &&
      KNOWN_RUN_STATES.has(stateParam as RunState)
    ) {
      filter.state = stateParam as RunState;
    }
    const project = context.req.query("project");
    if (project !== undefined) {
      filter.project = project;
    }
    const runs = options.runStore.listRuns(filter);
    const title =
      filter.state === undefined ? "All runs" : `Runs (${filter.state})`;
    const html = layout(title, renderRunsTable(title, runs));
    return context.html(html);
  });

  options.app.get("/runs/:id", async (context) => {
    const id = context.req.param("id");
    const detail = options.runStore.getRun(id);
    if (detail === undefined) {
      return context.html(
        layout("Run not found", `<p>Run ${escapeHtml(id)} not found.</p>`),
        404
      );
    }

    const tailDesc = options.runStore.listProviderEvents(id, {
      limit: EVENT_TAIL_LIMIT,
      order: "desc"
    });
    const events = tailDesc.slice().reverse();
    const eventsTruncated = tailDesc.length >= EVENT_TAIL_LIMIT;
    const isFailure = FAILURE_STATES.has(detail.state);
    const terminalAttempt = detail.attempts[detail.attempts.length - 1];
    const failureEvent = isFailure
      ? options.runStore.getLastFailureEvent(id, terminalAttempt?.id)
      : undefined;
    // Scope to the terminal attempt for the same reason failureEvent is: an
    // earlier attempt's abnormal process_exit must not be attributed to the
    // terminal failure (e.g. a stale run whose terminal attempt was killed via
    // the watchdog DB update and never emitted its own process_exit).
    const exitEvent = isFailure
      ? findLast(
          events,
          (event) =>
            event.normalized.type === "process_exit" &&
            event.attemptId === terminalAttempt?.id
        )
      : undefined;
    const artifacts = options.runStore.listRunArtifacts(id);
    const workflowGraph = await options.runStore.getWorkflowGraph(id);
    const capKind = parseCapReachedReason(detail.terminalReason);
    const capContext =
      capKind === null
        ? null
        : {
            count: options.runStore.countSucceededContinuations(
              detail.project,
              detail.issueNumber
            ),
            kind: capKind
          };
    const sections = [
      `<h1>Run ${escapeHtml(detail.id)}</h1>`,
      renderOutcomeBanner(detail, failureEvent, exitEvent),
      renderRunSummary(detail, capContext),
      renderWorkflowGraphSummary(workflowGraph),
      renderCancelForm(detail),
      renderAttemptsTable(detail.attempts),
      renderTransitionsTable(detail.transitions),
      renderEventsTable(events, eventsTruncated),
      renderRunFileLinks(detail.id, artifacts)
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
.banner { border-radius: 6px; padding: 0.75rem 1rem; margin: 0.8rem 0 1.2rem; }
.banner-failed { background: #fdecef; border: 1px solid #f2b8c2; }
.banner-title { font-weight: 700; margin: 0 0 0.35rem; }
.banner-failed .banner-title { color: #b00020; }
.banner-reason { margin: 0 0 0.4rem; white-space: pre-wrap; font-size: 0.95rem; }
.banner-context { margin: 0; font-size: 0.82rem; color: #555; }
.banner-context code { background: rgba(0,0,0,0.05); padding: 0 0.2rem; border-radius: 3px; }
.msg { white-space: pre-wrap; font-family: inherit; max-height: 22rem; overflow: auto; margin: 0; }
.hint { color: #555; font-size: 0.82rem; margin: 0.2rem 0 0.6rem; }
</style>
</head>
<body>
<header><h1><a href="/">Symphonika</a></h1><nav><a href="/">Dashboard</a><a href="/runs">Runs</a></nav></header>
${body}
</body>
</html>`;
}

function renderHeader(
  version: string,
  snapshot: StatusSnapshot | undefined
): string {
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

function renderProjectsCard(
  snapshot: StatusSnapshot | undefined,
  issuePollStatus: IssuePollStatus | undefined
): string {
  const projectStates = snapshot?.projectStates ?? [];
  if (projectStates.length > 0) {
    const rows = projectStates
      .map((project) => {
        return [
          "<tr>",
          `<td>${escapeHtml(project.projectName)}</td>`,
          `<td>${project.weight}</td>`,
          `<td>${escapeHtml(formatProjectValidation(project))}</td>`,
          `<td>${escapeHtml(formatProjectPoll(project))}</td>`,
          `<td>${escapeHtml(formatProjectDispatch(project))}</td>`,
          "</tr>"
        ].join("");
      })
      .join("");
    return `<section><h2>Projects</h2>
<table><thead><tr><th>Name</th><th>Weight</th><th>Validation</th><th>Last poll</th><th>Last dispatch</th></tr></thead>
<tbody>${rows}</tbody></table></section>`;
  }

  if (snapshot !== undefined && snapshot.projects.length > 0) {
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

  const pollProjects = issuePollStatus?.projects ?? [];
  if (pollProjects.length === 0) {
    return "";
  }

  const rows = pollProjects
    .map((project) => {
      const status = project.ok ? "poll ok" : "poll failed";
      const detail = project.ok
        ? `${project.fetchedIssues} fetched`
        : (project.error ?? "unknown error");
      return `<tr><td>${escapeHtml(project.name)}</td><td>${escapeHtml(status)}</td><td>${escapeHtml(detail)}</td></tr>`;
    })
    .join("");
  return `<section><h2>Projects</h2>
<table><thead><tr><th>Name</th><th>Issue polling</th><th>Last poll</th></tr></thead>
<tbody>${rows}</tbody></table></section>`;
}

function formatProjectValidation(project: ProjectState): string {
  return project.validationMessage === null
    ? project.validationState
    : `${project.validationState}: ${project.validationMessage}`;
}

function formatProjectPoll(project: ProjectState): string {
  if (project.lastPollFinishedAt === null || project.lastPollOk === null) {
    return "never";
  }
  const outcome = project.lastPollOk ? "ok" : "failed";
  return [
    `${outcome} at ${project.lastPollFinishedAt}`,
    `(${project.lastFetchedIssues} fetched, ${project.lastCandidateIssues} candidate, ${project.lastFilteredIssues} filtered)`
  ].join(" ");
}

function formatProjectDispatch(project: ProjectState): string {
  if (
    project.lastDispatchedAt === null ||
    project.lastDispatchedIssueNumber === null
  ) {
    return "never";
  }
  return `#${project.lastDispatchedIssueNumber} at ${project.lastDispatchedAt}`;
}

function renderStaleIssuesCard(
  filteredIssues: FilteredProjectIssueSnapshot[]
): string {
  const staleIssues = filteredIssues.filter((entry) =>
    entry.issue.labels.includes("sym:stale")
  );
  if (staleIssues.length === 0) {
    return "";
  }

  const rows = staleIssues
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.project)}</td><td><a href="${escapeHtml(entry.issue.url)}">#${entry.issue.number}</a> ${escapeHtml(entry.issue.title)}</td><td>${escapeHtml(entry.reasons.join(", "))}</td></tr>`
    )
    .join("");
  return `<section><h2>Stale issues</h2>
<table><thead><tr><th>Project</th><th>Issue</th><th>Reason</th></tr></thead>
<tbody>${rows}</tbody></table></section>`;
}

function renderRoutinesTable(routines: RoutineStatus[]): string {
  if (routines.length === 0) {
    return "";
  }
  const rows = routines
    .map(
      (routine) =>
        `<tr><td>${escapeHtml(routine.projectName)}</td><td>${escapeHtml(routine.name)}</td><td>${escapeHtml(routine.state)}</td><td>${escapeHtml(routine.nextFireAt ?? "-")}</td><td>${escapeHtml(routine.lastFiredAt ?? "-")}</td></tr>`
    )
    .join("");
  return `<section><h2>Routines</h2>
<table><thead><tr><th>Project</th><th>Routine</th><th>State</th><th>next_fire_at</th><th>last_fired_at</th></tr></thead>
<tbody>${rows}</tbody></table></section>`;
}

function renderRunsTable(title: string, runs: RunStatus[]): string {
  if (runs.length === 0) {
    return `<section><h2>${escapeHtml(title)}</h2><p><em>No runs yet.</em></p></section>`;
  }

  const rows = runs
    .map(
      (run) =>
        `<tr><td><a href="/runs/${encodeURIComponent(run.id)}"><code>${escapeHtml(run.id)}</code></a></td><td>${escapeHtml(run.project)}</td><td>#${run.issueNumber} ${escapeHtml(run.issueTitle)}</td><td><span class="state-${escapeHtml(run.state)}">${escapeHtml(run.state)}</span></td><td>${escapeHtml(run.provider)}</td><td>${escapeHtml(run.createdAt)}</td><td>${escapeHtml(run.updatedAt)}</td><td><code>${escapeHtml(run.branchName)}</code></td></tr>`
    )
    .join("");
  return `<section><h2>${escapeHtml(title)}</h2>
<table><thead><tr><th>Run id</th><th>Project</th><th>Issue</th><th>State</th><th>Provider</th><th>Started</th><th>Updated</th><th>Branch</th></tr></thead>
<tbody>${rows}</tbody></table></section>`;
}

type CapContext = {
  count: number;
  kind: ReturnType<typeof parseCapReachedReason>;
};

function renderRunSummary(
  detail: RunStatus,
  capContext: CapContext | null
): string {
  const capContextLine =
    capContext !== null && capContext.kind !== null
      ? `<p><strong>Cap context:</strong> ${escapeHtml(formatCapReachedReason(capContext.kind, capContext.count))}</p>`
      : "";
  return `<section>
  <p><strong>Project:</strong> ${escapeHtml(detail.project)}</p>
  <p><strong>Issue:</strong> #${detail.issueNumber} ${escapeHtml(detail.issueTitle)}</p>
  <p><strong>State:</strong> <span class="state-${escapeHtml(detail.state)}">${escapeHtml(detail.state)}</span></p>
  <p><strong>Provider:</strong> ${escapeHtml(detail.provider)}</p>
  <p><strong>Started:</strong> ${escapeHtml(detail.createdAt)}</p>
  <p><strong>Updated:</strong> ${escapeHtml(detail.updatedAt)}</p>
  <p><strong>Branch:</strong> <code>${escapeHtml(detail.branchName)}</code></p>
  <p><strong>Workspace:</strong> <code>${escapeHtml(detail.workspacePath)}</code></p>
  <p><strong>Retries:</strong> ${detail.retryCount}${detail.isContinuation ? " (continuation)" : ""}</p>
  ${detail.terminalReason !== null ? `<p><strong>Terminal reason:</strong> ${escapeHtml(detail.terminalReason)}</p>` : ""}
  ${capContextLine}
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
    createdAt: string;
    updatedAt: string;
    branchName: string;
  }[]
): string {
  if (attempts.length === 0) {
    return `<section><h2>Attempts</h2><p><em>No attempts recorded.</em></p></section>`;
  }
  const rows = attempts
    .map(
      (attempt) =>
        `<tr><td>${attempt.attemptNumber}</td><td><code>${escapeHtml(attempt.id)}</code></td><td><span class="state-${escapeHtml(attempt.state)}">${escapeHtml(attempt.state)}</span></td><td>${escapeHtml(attempt.providerName)}</td><td>${escapeHtml(attempt.createdAt)}</td><td>${escapeHtml(attempt.updatedAt)}</td><td><code>${escapeHtml(attempt.branchName)}</code></td></tr>`
    )
    .join("");
  return `<section><h2>Attempts</h2><table><thead><tr><th>#</th><th>Attempt id</th><th>State</th><th>Provider</th><th>Attempt started</th><th>Attempt updated</th><th>Branch</th></tr></thead><tbody>${rows}</tbody></table></section>`;
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

function renderOutcomeBanner(
  detail: RunStatus,
  failureEvent: ProviderEventRecord | undefined,
  exitEvent: ProviderEventRecord | undefined
): string {
  // Only failure-state runs get a banner. A prior attempt's failure event must
  // never surface on a run that ultimately succeeded or is still running.
  if (!FAILURE_STATES.has(detail.state)) {
    return "";
  }
  const providerMessage =
    failureEvent !== undefined &&
    typeof failureEvent.normalized.message === "string"
      ? failureEvent.normalized.message
      : undefined;

  const reason =
    providerMessage !== undefined
      ? `<p class="banner-reason">${escapeHtml(providerMessage)}</p>`
      : `<p class="banner-reason">No provider failure message was recorded. See the transcript and logs below.</p>`;

  const context: string[] = [];
  if (detail.terminalReason !== null) {
    context.push(
      `terminal reason <code>${escapeHtml(detail.terminalReason)}</code>`
    );
  }
  const abnormalExit = formatAbnormalExit(exitEvent);
  if (abnormalExit !== undefined) {
    context.push(abnormalExit);
  }
  context.push(`provider <code>${escapeHtml(detail.provider)}</code>`);
  if (failureEvent !== undefined) {
    context.push(`event #${failureEvent.sequence}`);
  }

  return `<section class="banner banner-failed"><p class="banner-title">Run ${escapeHtml(detail.state)}</p>${reason}<p class="banner-context">${context.join(" &middot; ")}</p></section>`;
}

// Exit code is reported only when abnormal: codex exits 0 even after refusing a
// task, so a "process exited 0" line next to a failure would mislead.
function formatAbnormalExit(
  exitEvent: ProviderEventRecord | undefined
): string | undefined {
  if (exitEvent === undefined) {
    return undefined;
  }
  const normalized = exitEvent.normalized;
  const exitCode =
    typeof normalized.exitCode === "number" ? normalized.exitCode : undefined;
  const signal =
    typeof normalized.signal === "string" ? normalized.signal : undefined;
  const bits: string[] = [];
  if (exitCode !== undefined && exitCode !== 0) {
    bits.push(`exit code ${exitCode}`);
  }
  if (signal !== undefined) {
    bits.push(`signal ${signal}`);
  }
  return bits.length === 0 ? undefined : `process ${bits.join(", ")}`;
}

type EventDisplayRow =
  | {
      kind: "message";
      firstSequence: number;
      lastSequence: number;
      text: string;
      createdAt: string;
    }
  | {
      kind: "event";
      sequence: number;
      type: string;
      detail: string;
      createdAt: string;
    };

// Codex streams assistant text one token per event; merge runs of adjacent
// message events into a single readable block, breaking on any other event.
function coalesceEvents(events: ProviderEventRecord[]): EventDisplayRow[] {
  const rows: EventDisplayRow[] = [];
  let buffer: Extract<EventDisplayRow, { kind: "message" }> | undefined;
  const flush = (): void => {
    if (buffer !== undefined) {
      rows.push(buffer);
      buffer = undefined;
    }
  };

  for (const event of events) {
    const message = event.normalized.message;
    if (event.type === "message" && typeof message === "string") {
      if (buffer === undefined) {
        buffer = {
          createdAt: event.createdAt,
          firstSequence: event.sequence,
          kind: "message",
          lastSequence: event.sequence,
          text: message
        };
      } else {
        buffer.text += message;
        buffer.lastSequence = event.sequence;
        buffer.createdAt = event.createdAt;
      }
      continue;
    }

    flush();
    rows.push({
      createdAt: event.createdAt,
      detail:
        typeof message === "string"
          ? message
          : JSON.stringify(event.normalized),
      kind: "event",
      sequence: event.sequence,
      type: event.type
    });
  }

  flush();
  return rows;
}

function renderEventsTable(
  events: ProviderEventRecord[],
  truncated: boolean
): string {
  if (events.length === 0) {
    return `<section><h2>Transcript &amp; events</h2><p><em>No events recorded yet.</em></p></section>`;
  }
  const rows = coalesceEvents(events)
    .map((row) => {
      if (row.kind === "message") {
        const seq =
          row.firstSequence === row.lastSequence
            ? `${row.firstSequence}`
            : `${row.firstSequence}–${row.lastSequence}`;
        return `<tr><td>${seq}</td><td>message</td><td><div class="msg">${escapeHtml(row.text)}</div></td><td>${escapeHtml(row.createdAt)}</td></tr>`;
      }
      return `<tr><td>${row.sequence}</td><td>${escapeHtml(row.type)}</td><td><code>${escapeHtml(row.detail)}</code></td><td>${escapeHtml(row.createdAt)}</td></tr>`;
    })
    .join("");
  const scope = truncated
    ? `most recent ${events.length}`
    : `all ${events.length}`;
  return `<section><h2>Transcript &amp; events</h2><p class="hint">Showing ${scope} events, oldest first. Streamed message tokens are merged into blocks; full logs are under Files below.</p><table><thead><tr><th>Seq</th><th>Type</th><th>Detail</th><th>At</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function renderRunFileLinks(
  runId: string,
  artifacts: RunArtifactDescriptor[]
): string {
  const items = artifacts
    .filter((artifact) => artifact.present)
    .map((artifact) => {
      const size =
        artifact.sizeBytes === undefined
          ? ""
          : ` <small>(${artifact.sizeBytes} bytes)</small>`;
      return `<li><a href="/logs/runs/${encodeURIComponent(runId)}/${encodeURIComponent(artifact.kind)}">${escapeHtml(formatArtifactKind(artifact.kind))}</a>${size}</li>`;
    });
  if (items.length === 0) {
    return "";
  }
  return `<section><h2>Files</h2><ul>${items.join("")}</ul></section>`;
}

function renderWorkflowGraphSummary(
  graph: ExpandedWorkflow | undefined
): string {
  if (graph === undefined) {
    return "";
  }
  const name = typeof graph.name === "string" ? graph.name : "(unknown)";
  const sourceKind =
    typeof graph.source?.kind === "string" ? graph.source.kind : "(unknown)";
  const sourcePath =
    typeof graph.source?.path === "string" ? graph.source.path : "(unknown)";
  const initial =
    typeof graph.initial === "string" ? graph.initial : "(unknown)";
  const stateCount = Array.isArray(graph.states) ? graph.states.length : 0;
  const contentHash =
    typeof graph.contentHash === "string" ? graph.contentHash : "(unknown)";
  return `<section><h2>Workflow graph</h2>
<p><strong>Name:</strong> <code>${escapeHtml(name)}</code></p>
<p><strong>Source kind:</strong> ${escapeHtml(sourceKind)}</p>
<p><strong>Source path:</strong> <code>${escapeHtml(sourcePath)}</code></p>
<p><strong>Initial state:</strong> <code>${escapeHtml(initial)}</code></p>
<p><strong>States:</strong> ${stateCount}</p>
<p><strong>Content hash:</strong> <code>${escapeHtml(contentHash)}</code></p>
</section>`;
}

function formatArtifactKind(kind: RunArtifactDescriptor["kind"]): string {
  switch (kind) {
    case "issue_snapshot":
      return "Issue snapshot";
    case "prompt":
      return "Rendered prompt";
    case "prompt_metadata":
      return "Prompt metadata";
    case "workflow_graph":
      return "Workflow graph";
    case "provider_raw":
      return "Provider event log";
    case "provider_normalized":
      return "Normalized event log";
  }
}

function findLast<T>(
  items: readonly T[],
  predicate: (item: T) => boolean
): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) {
      return item;
    }
  }
  return undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
