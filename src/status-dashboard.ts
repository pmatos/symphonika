import type { DoctorProjectReport } from "./doctor.js";
import type { NormalizedProviderEvent } from "./provider.js";
import type { ProviderEventRecord, RunState, RunStatus } from "./run-store.js";

export type DashboardIssueCounts = {
  candidate: number;
  failed: number;
  filtered: number;
  running: number;
  stale: number;
};

export type DashboardEventSummary = {
  message: string;
  sequence: number;
  type: string;
};

export type StatusDashboardInput = {
  daemon: string;
  issueCounts: DashboardIssueCounts;
  lastPollOutcome: string;
  latestEvents: ReadonlyMap<string, DashboardEventSummary>;
  projects: DoctorProjectReport[];
  reload: string;
  runs: RunStatus[];
  stateRoot: string;
};

const ACTIVE_RUN_STATES = new Set<RunState>([
  "queued",
  "preparing_workspace",
  "running",
  "waiting"
]);

const ATTENTION_RUN_STATES = new Set<RunState>([
  "failed",
  "stale"
]);

const RECENT_RUN_STATES = new Set<RunState>([
  "cancelled",
  "failed",
  "stale",
  "succeeded"
]);

const RECENT_LIMIT = 5;

export function renderStatusDashboard(input: StatusDashboardInput): string {
  const validProjects = input.projects.filter(
    (project) => project.validForDispatch
  ).length;
  const invalidProjects = input.projects.length - validProjects;
  const activeRuns = input.runs.filter((run) => ACTIVE_RUN_STATES.has(run.state));
  const attentionRuns = input.runs.filter((run) =>
    ATTENTION_RUN_STATES.has(run.state)
  );
  const runCounts = countRunsByState(input.runs);
  const recentRuns = input.runs
    .filter((run) => RECENT_RUN_STATES.has(run.state))
    .slice(0, RECENT_LIMIT);

  const lines = [
    "╭─ SYMPHONIKA STATUS",
    `│ Daemon: ${input.daemon}`,
    `│ Config reload: ${input.reload}`,
    `│ State root: ${input.stateRoot}`,
    `│ Projects: ${validProjects} valid / ${invalidProjects} invalid`,
    `│ Issues: candidate ${input.issueCounts.candidate} | filtered ${input.issueCounts.filtered} | running ${input.issueCounts.running} | failed ${input.issueCounts.failed} | stale ${input.issueCounts.stale}`,
    `│ Runs: active ${activeRuns.length} | succeeded ${runCounts.succeeded ?? 0} | failed ${runCounts.failed ?? 0} | cancelled ${runCounts.cancelled ?? 0} | total ${input.runs.length}`,
    `│ Last poll: ${input.lastPollOutcome}`,
    "├─ Active runs",
    ...formatActiveRuns(activeRuns, input.latestEvents),
    "├─ Attention",
    ...formatAttention(input.projects, attentionRuns),
    "├─ Recent runs",
    ...formatRecentRuns(recentRuns),
    "╰─"
  ];

  return `${lines.join("\n")}\n`;
}

export function summarizeDashboardEvent(
  event: ProviderEventRecord | undefined
): DashboardEventSummary | undefined {
  if (event === undefined) {
    return undefined;
  }
  return {
    message: summarizeNormalizedEvent(event.normalized),
    sequence: event.sequence,
    type: event.type
  };
}

function countRunsByState(runs: RunStatus[]): Partial<Record<RunState, number>> {
  const counts: Partial<Record<RunState, number>> = {};
  for (const run of runs) {
    counts[run.state] = (counts[run.state] ?? 0) + 1;
  }
  return counts;
}

function formatActiveRuns(
  runs: RunStatus[],
  latestEvents: ReadonlyMap<string, DashboardEventSummary>
): string[] {
  if (runs.length === 0) {
    return ["│   No active runs"];
  }

  return [
    "│   ID           PROJECT      ISSUE   STATE                PROVIDER  EVENT",
    "│   -------------------------------------------------------------------------------",
    ...runs.map((run) => {
      const event = latestEvents.get(run.id);
      return [
        "│  ",
        pad(truncate(run.id, 12), 12),
        " ",
        pad(truncate(run.project, 12), 12),
        " ",
        pad(`#${run.issueNumber}`, 7),
        " ",
        pad(run.state, 20),
        " ",
        pad(run.provider || "-", 8),
        " ",
        truncate(eventSummary(event), 42)
      ].join("");
    })
  ];
}

function formatAttention(
  projects: DoctorProjectReport[],
  runs: RunStatus[]
): string[] {
  const lines: string[] = [];
  for (const run of runs.slice(0, RECENT_LIMIT)) {
    lines.push(
      `│   ${run.state} ${run.project} #${run.issueNumber} ${truncate(run.issueTitle, 52)}${formatReason(run)}`
    );
  }
  for (const project of projects) {
    for (const issue of project.staleIssues.slice(0, RECENT_LIMIT)) {
      lines.push(
        `│   stale claim ${project.name} #${issue.number} ${truncate(issue.title, 52)}`
      );
    }
  }
  if (lines.length === 0) {
    return ["│   No failed, input-required, or stale work"];
  }
  return lines;
}

function formatRecentRuns(runs: RunStatus[]): string[] {
  if (runs.length === 0) {
    return ["│   No completed runs yet"];
  }
  return runs.map(
    (run) =>
      `│   ${pad(truncate(run.id, 14), 14)} ${pad(run.project, 12)} #${pad(String(run.issueNumber), 5)} ${pad(run.state, 10)} ${truncate(run.issueTitle, 42)}`
  );
}

function formatReason(run: RunStatus): string {
  const reason = run.terminalReason ?? run.stateTransitionReason;
  return reason === null ? "" : ` — ${truncate(reason, 40)}`;
}

function eventSummary(event: DashboardEventSummary | undefined): string {
  if (event === undefined) {
    return "(no events)";
  }
  return `${event.sequence}. ${event.type}: ${event.message}`;
}

function summarizeNormalizedEvent(event: NormalizedProviderEvent): string {
  if (typeof event.message === "string" && event.message.trim().length > 0) {
    return event.message.trim().replace(/\s+/g, " ");
  }
  if (event.type === "tool_call" && typeof event.toolName === "string") {
    return `tool ${event.toolName}`;
  }
  if (event.type === "usage_updated" && isRecord(event.tokenUsage)) {
    const total =
      numberField(event.tokenUsage, "total_tokens") ??
      numberField(event.tokenUsage, "totalTokens") ??
      numberField(event.tokenUsage, "total");
    return total === undefined ? "usage updated" : `${total.toLocaleString()} tokens`;
  }
  if (event.type === "turn_completed" && typeof event.status === "string") {
    return event.status;
  }
  if (event.type === "process_exit" && typeof event.exitCode === "number") {
    return `exit ${event.exitCode}`;
  }
  if (event.type === "session_started" && typeof event.sessionId === "string") {
    return `session ${truncate(event.sessionId, 18)}`;
  }
  return event.type;
}

function numberField(
  value: Record<string, unknown>,
  key: string
): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value.padEnd(width, " ");
}

function truncate(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }
  if (width <= 1) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 1)}…`;
}
