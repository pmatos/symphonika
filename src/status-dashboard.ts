import type { DoctorProjectReport } from "./doctor.js";
import type { NormalizedProviderEvent } from "./provider.js";
import type { ProviderEventRecord, RunState, RunStatus } from "./run-store.js";
import type { RoutineStatus } from "./routines/types.js";
import {
  formatWatchdogDuration,
  type WatchdogIdleStatus
} from "./watchdog-status.js";

type DashboardIssueCounts = {
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
  routines?: RoutineStatus[];
  runs: RunStatus[];
  stateRoot: string;
  watchdogByRun?: ReadonlyMap<string, WatchdogIdleStatus>;
};

export type StatusDashboardRedrawFrame = {
  lineCount: number;
  output: string;
};

const ACTIVE_RUN_STATES = new Set<RunState>([
  "queued",
  "preparing_workspace",
  "running",
  "waiting"
]);

const ATTENTION_RUN_STATES = new Set<RunState>(["failed", "blocked", "stale"]);

const RECENT_RUN_STATES = new Set<RunState>([
  "cancelled",
  "failed",
  "blocked",
  "stale",
  "succeeded"
]);

const RECENT_LIMIT = 5;

export function renderStatusDashboardRedrawFrame(
  renderedDashboard: string,
  previousLineCount = 0
): StatusDashboardRedrawFrame {
  const lines = linesWithoutFinalNewline(renderedDashboard);
  const trailingBlankErases = Array.from(
    { length: Math.max(0, previousLineCount - lines.length) },
    () => "\x1b[K"
  );
  const frameLines = [
    ...lines.map((line) => `${line}\x1b[K`),
    ...trailingBlankErases
  ];
  const initialFrameTrailingErase = previousLineCount === 0 ? "\x1b[J" : "";
  return {
    lineCount: lines.length,
    output: `\x1b[H${frameLines.join("\n")}\n${initialFrameTrailingErase}`
  };
}

export function renderStatusDashboard(input: StatusDashboardInput): string {
  const validProjects = input.projects.filter(
    (project) => project.validForDispatch
  ).length;
  const invalidProjects = input.projects.length - validProjects;
  const activeRuns = input.runs.filter((run) =>
    ACTIVE_RUN_STATES.has(run.state)
  );
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
    `│ Runs: active ${activeRuns.length} | succeeded ${runCounts.succeeded ?? 0} | failed ${runCounts.failed ?? 0} | blocked ${runCounts.blocked ?? 0} | cancelled ${runCounts.cancelled ?? 0} | total ${input.runs.length}`,
    `│ Last poll: ${input.lastPollOutcome}`,
    "├─ Active runs",
    ...formatActiveRuns(
      activeRuns,
      input.latestEvents,
      input.watchdogByRun ?? new Map()
    ),
    "├─ Attention",
    ...formatAttention(input.projects, attentionRuns),
    "├─ Routines",
    ...formatRoutines(input.routines ?? []),
    "├─ Recent runs",
    ...formatRecentRuns(recentRuns),
    "╰─"
  ];

  return `${lines.join("\n")}\n`;
}

function formatRoutines(routines: RoutineStatus[]): string[] {
  if (routines.length === 0) {
    return ["│   No routines configured"];
  }
  return [
    "│   PROJECT      ROUTINE              STATE     DISABLED_REASON    NEXT_FIRE_AT              LAST_FIRED_AT             LAST_ATTEMPTED_AT         LAST_SKIP_REASON   LAST_SKIP_AT              SKIPS_24H                                                        PRS",
    "│   -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------",
    ...routines.map((routine) =>
      [
        "│  ",
        pad(truncate(routine.projectName, 12), 12),
        " ",
        pad(truncate(routine.name, 20), 20),
        " ",
        pad(routine.state, 9),
        " ",
        pad(truncate(routine.disabledReason ?? "-", 18), 18),
        " ",
        pad(truncate(routine.nextFireAt ?? "-", 25), 25),
        " ",
        pad(truncate(routine.lastFiredAt ?? "-", 25), 25),
        " ",
        pad(truncate(routine.lastAttemptedAt ?? "-", 25), 25),
        " ",
        pad(truncate(routine.lastSkipReason ?? "-", 18), 18),
        " ",
        pad(truncate(routine.lastSkipAt ?? "-", 25), 25),
        " ",
        formatRoutineSkipCounts(routine.skipCounts24h),
        " ",
        formatRoutinePullRequestNumbers(routine.pullRequestNumbers)
      ].join("")
    )
  ];
}

function formatRoutinePullRequestNumbers(numbers: number[]): string {
  return numbers.length === 0
    ? "-"
    : numbers.map((number) => `#${number}`).join(",");
}

function formatRoutineSkipCounts(
  counts: RoutineStatus["skipCounts24h"]
): string {
  return `overlap=${counts.overlap},concurrency_cap=${counts.concurrency_cap},catch_up_window=${counts.catch_up_window}`;
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

function countRunsByState(
  runs: RunStatus[]
): Partial<Record<RunState, number>> {
  const counts: Partial<Record<RunState, number>> = {};
  for (const run of runs) {
    counts[run.state] = (counts[run.state] ?? 0) + 1;
  }
  return counts;
}

function formatActiveRuns(
  runs: RunStatus[],
  latestEvents: ReadonlyMap<string, DashboardEventSummary>,
  watchdogByRun: ReadonlyMap<string, WatchdogIdleStatus>
): string[] {
  if (runs.length === 0) {
    return ["│   No active runs"];
  }

  return [
    "│   ID           PROJECT      ISSUE   STATE                PROVIDER  EVENT",
    "│   -------------------------------------------------------------------------------",
    ...runs.flatMap((run) => {
      const event = latestEvents.get(run.id);
      const lines = [
        [
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
        ].join("")
      ];
      const watchdog = watchdogByRun.get(run.id);
      if (
        watchdog?.enabled === true &&
        watchdog.idleSince !== undefined &&
        watchdog.graceRemainingMs !== undefined
      ) {
        lines.push(
          `│      watchdog idle since ${watchdog.idleSince} (grace remaining ${formatWatchdogDuration(watchdog.graceRemainingMs)})`
        );
      }
      return lines;
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
    return ["│   No failed, blocked, input-required, or stale work"];
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
    return total === undefined
      ? "usage updated"
      : `${total.toLocaleString()} tokens`;
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
  return typeof field === "number" && Number.isFinite(field)
    ? field
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value.padEnd(width, " ");
}

function linesWithoutFinalNewline(value: string): string[] {
  const trimmed = value.endsWith("\n") ? value.slice(0, -1) : value;
  return trimmed.length === 0 ? [] : trimmed.split("\n");
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
