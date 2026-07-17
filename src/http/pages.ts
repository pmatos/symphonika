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

    // Fetch one extra row so we can distinguish "exactly EVENT_TAIL_LIMIT
    // events, nothing cut" from "more than EVENT_TAIL_LIMIT, truncated" — the
    // count label must not claim truncation when none happened.
    const tailDesc = options.runStore.listProviderEvents(id, {
      limit: EVENT_TAIL_LIMIT + 1,
      order: "desc"
    });
    const eventsTruncated = tailDesc.length > EVENT_TAIL_LIMIT;
    const events = tailDesc.slice(0, EVENT_TAIL_LIMIT).reverse();
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
      renderWorkflowGraphSummary(detail.id, workflowGraph),
      renderCancelForm(detail),
      renderAttemptsTable(detail.attempts),
      renderTransitionsTable(detail.transitions),
      renderEventsTable(events, eventsTruncated),
      renderRunFileLinks(detail.id, artifacts)
    ].join("");
    return context.html(layout(`Run ${detail.id}`, sections));
  });

  options.app.get("/runs/:id/graph", async (context) => {
    const id = context.req.param("id");
    const detail = options.runStore.getRun(id);
    if (detail === undefined) {
      return context.html(
        layout("Run not found", `<p>Run ${escapeHtml(id)} not found.</p>`),
        404
      );
    }
    const graph = await options.runStore.getWorkflowGraph(id);
    if (graph === undefined) {
      return context.html(
        layout(
          "No workflow graph",
          `<h1>Workflow graph</h1><p>No workflow graph was recorded for run <a href="/runs/${encodeURIComponent(id)}"><code>${escapeHtml(id)}</code></a>.</p>`
        ),
        404
      );
    }
    return context.html(
      layout(
        `Workflow graph ${detail.id}`,
        renderWorkflowGraphPage(detail.id, graph)
      )
    );
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
  runId: string,
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
<p><a href="/runs/${encodeURIComponent(runId)}/graph">&rarr; View interactive graph</a></p>
</section>`;
}

function serializeGraphForScript(graph: ExpandedWorkflow): string {
  return JSON.stringify(graph).replace(
    /[<>&\u2028\u2029]/g,
    (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

function renderWorkflowGraphPage(
  runId: string,
  graph: ExpandedWorkflow
): string {
  const encodedId = encodeURIComponent(runId);
  const name = typeof graph.name === "string" ? graph.name : "(unknown)";
  return `<style>${WORKFLOW_GRAPH_STYLES}</style>
<h1>Workflow graph</h1>
<p class="wf-sub">Run <a href="/runs/${encodedId}"><code>${escapeHtml(runId)}</code></a> &middot; <code>${escapeHtml(name)}</code> &middot; <a href="/logs/runs/${encodedId}/workflow_graph">raw JSON</a></p>
<div class="wf-toolbar">
  <button id="wf-fit" type="button">Fit</button>
  <button id="wf-relayout" type="button">Re-layout</button>
  <span class="wf-hint">Scroll to zoom &middot; drag background to pan &middot; drag a node to move it &middot; click a node for details</span>
</div>
<div class="wf-wrap">
  <div id="wf-cy"></div>
  <aside class="wf-side">
    <div class="wf-card">
      <h2>Legend</h2>
      <div class="wf-legend-row"><span class="wf-swatch" style="background:#dbeafe;border-color:#3b82f6;border-width:2px"></span> initial state</div>
      <div class="wf-legend-row"><span class="wf-swatch" style="background:#eff6ff;border-color:#60a5fa"></span> agent action</div>
      <div class="wf-legend-row"><span class="wf-swatch" style="background:#f1f5f9;border-style:dashed"></span> wait</div>
      <div class="wf-legend-row"><span class="wf-swatch" style="background:#f5f3ff;border-color:#8b5cf6"></span> merge PR</div>
      <div class="wf-legend-row"><span class="wf-swatch" style="background:#dcfce7;border-color:#22c55e"></span> terminal &middot; success</div>
      <div class="wf-legend-row"><span class="wf-swatch" style="background:#fee2e2;border-color:#ef4444"></span> terminal &middot; blocked</div>
      <div class="wf-legend-row"><span class="wf-swatch wf-swatch-line" style="border-top-color:#f59e0b"></span> retry / loop edge</div>
      <div class="wf-legend-row"><span class="wf-swatch wf-swatch-line" style="border-top-color:#cbd5e1"></span> default (&ldquo;otherwise&rdquo;)</div>
    </div>
    <div class="wf-card wf-detail" id="wf-detail">
      <h2>Details</h2>
      <p class="wf-muted">Click a state node to inspect its action and transitions.</p>
    </div>
  </aside>
</div>
<script>window.__WORKFLOW_GRAPH__ = ${serializeGraphForScript(graph)};</script>
${WORKFLOW_GRAPH_SCRIPTS}
<script>${WORKFLOW_GRAPH_CLIENT_JS}</script>`;
}

const WORKFLOW_GRAPH_STYLES = `
.wf-sub { color:#555; font-size:0.9rem; margin:0 0 0.8rem; }
.wf-toolbar { display:flex; gap:.5rem; align-items:center; margin-bottom:.6rem; flex-wrap:wrap; }
.wf-toolbar button { font:inherit; font-size:.85rem; padding:.3rem .7rem; border:1px solid #cbd5e1; background:#fff; border-radius:6px; cursor:pointer; }
.wf-toolbar button:hover { background:#f1f5f9; }
.wf-hint { color:#64748b; font-size:.8rem; }
.wf-wrap { display:flex; gap:1rem; align-items:stretch; }
#wf-cy { flex:1 1 auto; height:80vh; min-height:520px; border:1px solid #e2e8f0; border-radius:10px;
  background:#fbfcfe radial-gradient(circle at 1px 1px, #e6eaf1 1px, transparent 0) 0 0 / 22px 22px; }
.wf-side { flex:0 0 320px; display:flex; flex-direction:column; gap:1rem; }
.wf-card { border:1px solid #e2e8f0; border-radius:10px; padding:.8rem .9rem; background:#fff; }
.wf-card h2 { margin:0 0 .5rem; font-size:.95rem; }
.wf-legend-row { display:flex; align-items:center; gap:.5rem; font-size:.82rem; margin:.28rem 0; }
.wf-swatch { width:16px; height:16px; border-radius:4px; border:1px solid #94a3b8; flex:0 0 auto; }
.wf-swatch-line { height:0; border:none; border-top:2px dashed #cbd5e1; border-radius:0; }
.wf-badges { display:flex; flex-wrap:wrap; gap:.3rem; margin:.2rem 0 .6rem; }
.wf-badge { font-size:.72rem; padding:.12rem .5rem; border-radius:999px; background:#eef2ff; color:#3730a3; border:1px solid #c7d2fe; }
.wf-badge.init { background:#dbeafe; color:#1e40af; border-color:#93c5fd; }
.wf-badge.term-ok { background:#dcfce7; color:#166534; border-color:#86efac; }
.wf-badge.term-block { background:#fee2e2; color:#991b1b; border-color:#fca5a5; }
.wf-dl dt { font-size:.72rem; text-transform:uppercase; letter-spacing:.03em; color:#64748b; margin-top:.5rem; }
.wf-dl dd { margin:.15rem 0 0; font-size:.86rem; }
.wf-dl pre { background:#f8fafc; border:1px solid #eef2f7; border-radius:6px; padding:.4rem .5rem; overflow:auto; margin:.2rem 0 0; font-size:.8rem; }
.wf-trans { list-style:none; margin:.2rem 0 0; padding:0; }
.wf-trans li { font-size:.82rem; margin:.3rem 0; padding-left:.9rem; border-left:2px solid #cbd5e1; }
.wf-cond { color:#475569; }
.wf-muted { color:#94a3b8; font-style:italic; }
.wf-fallback { padding:1rem; }
.wf-fallback pre { background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:.8rem; overflow:auto; }
`;

const WORKFLOW_GRAPH_SCRIPTS = `<script src="https://cdn.jsdelivr.net/npm/cytoscape@3.30.4/dist/cytoscape.min.js" integrity="sha384-H3uzGzTfGHUAumB8+s4GEdfFwzAceN9wCCndN8AXubWKFIPuBSWKKtWDx7RhSf/z" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script src="https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js" integrity="sha384-2IH3T69EIKYC4c+RXZifZRvaH5SRUdacJW7j6HtE5rQbvLhKKdawxq6vpIzJ7j9M" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script src="https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.min.js" integrity="sha384-EHCdyFVbhtbpgI+4x7ETlZUvJwOkxJublmhTpH114NSk3fqfiUgcLl6pQm8JQwg9" crossorigin="anonymous" referrerpolicy="no-referrer"></script>`;

const WORKFLOW_GRAPH_CLIENT_JS = `(function () {
  var graph = window.__WORKFLOW_GRAPH__;
  var cyEl = document.getElementById("wf-cy");
  var detailEl = document.getElementById("wf-detail");
  if (!graph || !cyEl) return;
  var states = Array.isArray(graph.states) ? graph.states : [];

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function fmtVal(v) { return typeof v === "string" ? '"' + v + '"' : String(v); }
  function condLines(when) {
    var keys = when ? Object.keys(when) : [];
    return keys.map(function (k) { return k + " = " + fmtVal(when[k]); });
  }
  function edgeLabel(when) {
    var lines = condLines(when);
    return lines.length === 0 ? "otherwise" : lines.join("\\n");
  }
  function nodeClasses(st) {
    var cls = [];
    if (st.id === graph.initial) cls.push("initial");
    if (st.terminal === "success") cls.push("term-ok");
    else if (st.terminal) cls.push("term-block");
    else if (st.action && st.action.kind) cls.push("act-" + st.action.kind);
    else cls.push("act-default");
    return cls.join(" ");
  }
  function stateById(id) {
    for (var i = 0; i < states.length; i++) { if (states[i].id === id) return states[i]; }
    return undefined;
  }

  var realIds = {};
  states.forEach(function (s) { realIds[s.id] = true; });

  var rank = {};
  if (realIds[graph.initial]) {
    var queue = [graph.initial];
    rank[graph.initial] = 0;
    while (queue.length) {
      var cur = queue.shift();
      var cst = stateById(cur);
      if (!cst) continue;
      (cst.transitions || []).forEach(function (tr) {
        if (realIds[tr.to] && rank[tr.to] === undefined) {
          rank[tr.to] = rank[cur] + 1;
          queue.push(tr.to);
        }
      });
    }
  }

  var elements = [];
  var missing = {};
  states.forEach(function (st) {
    elements.push({ data: { id: st.id, label: st.id, state: st }, classes: nodeClasses(st) });
  });
  states.forEach(function (st) {
    (st.transitions || []).forEach(function (tr, i) {
      var target = tr.to;
      var targetId;
      if (realIds[target]) {
        targetId = target;
      } else {
        targetId = "__missing__" + target;
        if (!missing[target]) {
          missing[target] = true;
          elements.push({ data: { id: targetId, label: target }, classes: "missing" });
        }
      }
      // A retry/loop edge returns to an earlier, non-terminal state. Edges
      // into a terminal state are exits, never loops, even when the terminal
      // sits at a shallow BFS rank (e.g. reached by an early "otherwise").
      var targetState = stateById(target);
      var targetTerminal = !!(targetState && targetState.terminal);
      var isLoop = !targetTerminal && rank[target] !== undefined && rank[st.id] !== undefined && rank[target] < rank[st.id];
      elements.push({ data: {
        id: st.id + "->" + target + "#" + i,
        source: st.id,
        target: targetId,
        label: edgeLabel(tr.when),
        isDefault: condLines(tr.when).length === 0
      }, classes: isLoop ? "loop" : "" });
    });
  });

  if (typeof window.cytoscape === "undefined" || typeof window.dagre === "undefined" || typeof window.cytoscapeDagre === "undefined") {
    renderFallback();
    return;
  }
  try { window.cytoscape.use(window.cytoscapeDagre); } catch (e) {}

  function layoutOpts() {
    return { name: "dagre", rankDir: "TB", nodeSep: 80, rankSep: 140, edgeSep: 28, ranker: "network-simplex", padding: 30 };
  }

  var cy;
  try {
  cy = window.cytoscape({
    container: cyEl,
    elements: elements,
    wheelSensitivity: 0.2,
    style: [
      { selector: "node", style: {
        "label": "data(label)", "text-valign": "center", "text-halign": "center",
        "font-size": 13, "font-weight": 600, "color": "#0f172a",
        "shape": "round-rectangle", "width": "label", "height": "label",
        "padding": "12px", "border-width": 1.5, "border-color": "#94a3b8",
        "background-color": "#ffffff", "text-max-width": 200, "text-wrap": "wrap" } },
      { selector: "node.act-agent", style: { "background-color": "#eff6ff", "border-color": "#60a5fa" } },
      { selector: "node.act-wait", style: { "background-color": "#f1f5f9", "border-color": "#94a3b8", "border-style": "dashed" } },
      { selector: "node.act-merge_pr", style: { "background-color": "#f5f3ff", "border-color": "#8b5cf6" } },
      { selector: "node.act-default", style: { "background-color": "#ffffff", "border-color": "#94a3b8" } },
      { selector: "node.term-ok", style: { "background-color": "#dcfce7", "border-color": "#22c55e", "border-width": 2, "color": "#14532d" } },
      { selector: "node.term-block", style: { "background-color": "#fee2e2", "border-color": "#ef4444", "border-width": 2, "color": "#7f1d1d" } },
      { selector: "node.initial", style: { "border-width": 3, "border-color": "#2563eb" } },
      { selector: "node.missing", style: { "background-color": "#fff7ed", "border-color": "#fb923c", "border-style": "dotted", "color": "#9a3412" } },
      { selector: "node:selected", style: { "border-color": "#1d4ed8", "border-width": 3 } },
      { selector: "edge", style: {
        "width": 1.6, "line-color": "#9aa6b8", "target-arrow-color": "#9aa6b8",
        "target-arrow-shape": "triangle", "curve-style": "bezier", "arrow-scale": 1.0,
        "label": "data(label)", "font-size": 10, "color": "#334155",
        "text-wrap": "wrap", "text-max-width": 150,
        "text-background-color": "#ffffff", "text-background-opacity": 1, "text-background-shape": "roundrectangle",
        "text-border-color": "#e2e8f0", "text-border-width": 1, "text-border-opacity": 1,
        "text-background-padding": 3, "text-rotation": "none", "z-index": 30 } },
      { selector: "edge[?isDefault]", style: { "line-style": "dashed", "line-color": "#cbd5e1", "target-arrow-color": "#cbd5e1", "color": "#94a3b8" } },
      { selector: "edge.loop", style: {
        "curve-style": "unbundled-bezier", "control-point-distances": "90", "control-point-weights": "0.5",
        "line-color": "#f59e0b", "target-arrow-color": "#f59e0b", "line-style": "dashed",
        "color": "#b45309", "text-border-color": "#fde68a" } },
      { selector: "edge.hl", style: { "line-color": "#2563eb", "target-arrow-color": "#2563eb", "width": 2.4, "color": "#1e3a8a", "z-index": 40 } },
      { selector: "node.dim", style: { "opacity": 0.35 } },
      { selector: "edge.dim", style: { "opacity": 0.15 } }
    ],
    layout: layoutOpts()
  });
  } catch (initErr) {
    renderFallback();
    return;
  }

  cy.on("tap", "node", function (evt) { showDetail(evt.target); });
  cy.on("tap", function (evt) { if (evt.target === cy) clearDetail(); });
  var fitBtn = document.getElementById("wf-fit");
  var reBtn = document.getElementById("wf-relayout");
  if (fitBtn) fitBtn.addEventListener("click", function () { cy.fit(undefined, 30); });
  if (reBtn) reBtn.addEventListener("click", function () { cy.layout(layoutOpts()).run(); });
  cy.ready(function () { cy.fit(undefined, 30); });

  function highlight(node) {
    cy.elements().addClass("dim").removeClass("hl");
    node.closedNeighborhood().removeClass("dim");
    node.connectedEdges().removeClass("dim").addClass("hl");
    node.removeClass("dim");
  }
  function clearHighlight() { cy.elements().removeClass("dim hl"); }

  function showDetail(node) {
    highlight(node);
    var st = node.data("state");
    if (!st) {
      detailEl.innerHTML = "<h2>Details</h2><p class='wf-muted'>Unknown target <code>" + esc(node.data("label")) + "</code> (no matching state).</p>";
      return;
    }
    var badges = [];
    if (st.id === graph.initial) badges.push('<span class="wf-badge init">initial</span>');
    if (st.terminal === "success") badges.push('<span class="wf-badge term-ok">terminal &middot; success</span>');
    else if (st.terminal) badges.push('<span class="wf-badge term-block">terminal &middot; ' + esc(st.terminal) + '</span>');
    if (st.action && st.action.kind) badges.push('<span class="wf-badge">' + esc(st.action.kind) + '</span>');
    if (st.action && st.action.provider) badges.push('<span class="wf-badge">' + esc(st.action.provider) + '</span>');

    var html = "<h2>" + esc(st.id) + "</h2>";
    html += '<div class="wf-badges">' + (badges.join("") || '<span class="wf-muted">no attributes</span>') + "</div>";
    html += '<dl class="wf-dl">';
    if (st.action && st.action.prompt) html += "<dt>Prompt</dt><dd><code>" + esc(st.action.prompt) + "</code></dd>";
    if (st.action && st.action.method) html += "<dt>Method</dt><dd><code>" + esc(st.action.method) + "</code></dd>";
    var cw = condLines(st.completeWhen);
    if (cw.length) html += "<dt>Complete when</dt><dd><pre>" + esc(cw.join("\\n")) + "</pre></dd>";
    html += "<dt>Transitions</dt><dd>";
    if (!st.transitions || st.transitions.length === 0) {
      html += "<span class='wf-muted'>none (terminal)</span>";
    } else {
      html += "<ul class='wf-trans'>";
      st.transitions.forEach(function (tr) {
        var c = condLines(tr.when);
        html += "<li>&rarr; <code>" + esc(tr.to) + "</code><br><span class='wf-cond'>" +
                (c.length ? esc(c.join(", ")) : "otherwise") + "</span></li>";
      });
      html += "</ul>";
    }
    html += "</dd></dl>";
    detailEl.innerHTML = html;
  }

  function clearDetail() {
    clearHighlight();
    detailEl.innerHTML = "<h2>Details</h2><p class='wf-muted'>Click a state node to inspect its action and transitions.</p>";
  }

  function renderFallback() {
    var lines = ["Workflow: " + (graph.name || "(unknown)"), "Initial: " + (graph.initial || "(unknown)"), ""];
    states.forEach(function (st) {
      var tag = st.terminal ? " [terminal:" + st.terminal + "]" : (st.action ? " [" + st.action.kind + "]" : "");
      lines.push("- " + st.id + tag);
      (st.transitions || []).forEach(function (tr) {
        var c = condLines(tr.when);
        lines.push("    -> " + tr.to + (c.length ? "  when " + c.join(", ") : "  (otherwise)"));
      });
    });
    cyEl.innerHTML = '<div class="wf-fallback"><p class="wf-muted">Interactive renderer failed to load (offline?). Text view:</p><pre>' +
      esc(lines.join("\\n")) + "</pre></div>";
  }
})();`;

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
