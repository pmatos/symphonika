import { createReadStream } from "node:fs";
import { lstat, opendir, stat } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";

import type { NormalizedProviderEvent } from "../provider.js";
import {
  resolveWatchdogConfig,
  type WatchdogConfig,
  type WatchdogServiceConfig
} from "../reload.js";
import type {
  RunStore,
  WatchdogCandidateRun,
  WatchdogSample
} from "../run-store.js";

import { ActiveRunRegistry, CANCEL_REASONS } from "./active-runs.js";

const WORKSPACE_EXCLUDED_DIRS = new Set([".git", "target", "node_modules"]);
const WORKSPACE_PROGRESS_THRESHOLD_MS = 1_000;

export type ReconcileWatchdogInput = {
  activeRuns: ActiveRunRegistry;
  config: WatchdogConfig;
  logger?: Logger;
  now?: () => Date;
  projects?: WatchdogServiceConfig["projects"];
  runStore: RunStore;
};

export type WatchdogReconcileResult = {
  sampled: number;
  terminated: number;
};

type NormalizedLogRead = {
  events: NormalizedProviderEvent[];
  offset: number;
};

export function watchdogProgressObserved(
  previous: WatchdogSample,
  next: WatchdogSample
): boolean {
  return (
    toolCallAdvanced(previous, next) ||
    next.workspaceMtimeMax - previous.workspaceMtimeMax >=
      WORKSPACE_PROGRESS_THRESHOLD_MS ||
    next.turnIdSetSize > previous.turnIdSetSize ||
    next.outputTokensTotal > previous.outputTokensTotal ||
    messageAdvanced(previous, next)
  );
}

export async function reconcileWatchdog(
  input: ReconcileWatchdogInput
): Promise<WatchdogReconcileResult> {
  if (!input.config.enabled) {
    return { sampled: 0, terminated: 0 };
  }

  const now = input.now?.() ?? new Date();
  const sampledAt = now.toISOString();
  const serviceConfig: WatchdogServiceConfig = {
    projects: input.projects ?? [],
    watchdog: input.config
  };
  let sampled = 0;
  let terminated = 0;

  for (const run of input.runStore.listWatchdogCandidateRuns()) {
    const config = resolveWatchdogConfig(serviceConfig, run.projectName);
    const previous = input.runStore.getWatchdogSample(run.runId);
    const next = await sampleRun({
      mtimeIgnore: config.mtimeIgnore,
      previous,
      run,
      runStore: input.runStore,
      sampledAt
    });
    const progress =
      previous === undefined ? false : watchdogProgressObserved(previous, next);
    // ADR 0054: a transient retry starts a new attempt (a new normalized log
    // path) and must restart the grace clock. Drop the previous attempt's
    // idle_since on an attempt change so the retry gets a fresh grace window
    // rather than inheriting pre-retry idle time. (A retry re-enters a running
    // agent state per ADR 0020, not waiting, so the waiting-entry hook does not
    // fire and idle_since must be reset here.)
    const attemptChanged =
      previous !== undefined &&
      previous.normalizedLogPath !== run.normalizedLogPath;
    const idleSince = progress
      ? null
      : attemptChanged
        ? sampledAt
        : (previous?.idleSince ?? sampledAt);
    const persisted = {
      ...next,
      idleSince
    };
    input.runStore.upsertWatchdogSample(persisted);
    sampled += 1;

    if (progress || idleSince === null) {
      continue;
    }
    if (now.getTime() - Date.parse(idleSince) < config.graceMinutes * 60_000) {
      continue;
    }

    const marked = input.runStore.markRunNoProgressStale(run.runId, sampledAt);
    if (!marked) {
      continue;
    }
    await input.activeRuns.requestCancel(run.runId, CANCEL_REASONS.NO_PROGRESS);
    terminated += 1;
    input.logger?.warn(
      {
        issueNumber: run.issueNumber,
        project: run.projectName,
        runId: run.runId,
        terminalReason: "no_progress"
      },
      "symphonika watchdog marked run stale"
    );
  }

  return { sampled, terminated };
}

export async function sampleWorkspaceMtimeMax(
  workspacePath: string,
  mtimeIgnore: readonly string[] = []
): Promise<number> {
  if (workspacePath.length === 0) {
    return 0;
  }

  try {
    const root = await stat(workspacePath);
    if (!root.isDirectory()) {
      return Math.floor(root.mtimeMs);
    }
    const ignore = mtimeIgnore.map(globToRegExp);
    return await walkWorkspaceMtimeMax(
      workspacePath,
      workspacePath,
      ignore,
      Math.floor(root.mtimeMs)
    );
  } catch {
    return 0;
  }
}

async function sampleRun(input: {
  mtimeIgnore: readonly string[];
  previous: WatchdogSample | undefined;
  run: WatchdogCandidateRun;
  runStore: RunStore;
  sampledAt: string;
}): Promise<WatchdogSample> {
  // A retry attempt writes a fresh normalized log path
  // (provider.normalized.attempt-N.jsonl). Per-attempt baselines (the byte
  // offset and the output-token high-water mark) belong to the previous
  // attempt's file, so carry them over only when the path is unchanged. On a
  // path change we restart the offset at 0 (so the new attempt's early events
  // are not skipped) and the token baseline at 0 (so a new process whose output
  // token counter restarts below the failed attempt's total still registers as
  // progress instead of being suppressed by Math.max).
  const carryOver =
    input.previous !== undefined &&
    input.previous.normalizedLogPath === input.run.normalizedLogPath
      ? input.previous
      : undefined;
  const log = await readNormalizedEventsSince(
    input.run.normalizedLogPath,
    carryOver?.normalizedLogOffset ?? 0
  );
  const turnIds = collectTurnIds(log.events);
  const turnIdSetSize = input.runStore.rememberWatchdogTurnIds(
    input.run.runId,
    turnIds
  );
  return {
    idleSince: null,
    lastMessageAt: latestMessageAt(
      input.previous?.lastMessageAt ?? null,
      log.events,
      input.sampledAt
    ),
    lastToolCallAt: latestToolCallAt(
      input.previous?.lastToolCallAt ?? null,
      log.events,
      input.sampledAt
    ),
    normalizedLogOffset: log.offset,
    normalizedLogPath: input.run.normalizedLogPath,
    outputTokensTotal: outputTokensTotal(
      carryOver?.outputTokensTotal ?? 0,
      log.events
    ),
    runId: input.run.runId,
    sampledAt: input.sampledAt,
    turnIdSetSize,
    workspaceMtimeMax: await sampleWorkspaceMtimeMax(
      input.run.workspacePath,
      input.mtimeIgnore
    )
  };
}

async function readNormalizedEventsSince(
  filePath: string,
  offset: number
): Promise<NormalizedLogRead> {
  if (filePath.length === 0) {
    return { events: [], offset };
  }

  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return { events: [], offset };
  }

  const start = offset > size ? 0 : offset;
  if (size <= start) {
    return { events: [], offset: size };
  }

  let contents = "";
  try {
    for await (const chunk of createReadStream(filePath, {
      encoding: "utf8",
      start
    })) {
      contents += chunk;
    }
  } catch {
    return { events: [], offset };
  }
  const events = parseJsonlEvents(contents);
  return { events, offset: size };
}

async function walkWorkspaceMtimeMax(
  directory: string,
  workspaceRoot: string,
  ignore: readonly RegExp[],
  currentMax: number
): Promise<number> {
  let max = currentMax;
  let dir;
  try {
    dir = await opendir(directory);
  } catch {
    return max;
  }

  for await (const entry of dir) {
    if (entry.isDirectory() && WORKSPACE_EXCLUDED_DIRS.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    let stats;
    try {
      // lstat (not stat) so symlinks are never followed: a symlinked directory
      // reports isDirectory() === false here, so it is not descended into. This
      // keeps the excluded-dir check (entry.isDirectory(), also symlink-blind)
      // consistent with the recursion decision and prevents symlink cycles or
      // links to external trees from stalling the tick or injecting foreign
      // mtimes as false progress.
      stats = await lstat(entryPath);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      max = Math.max(max, Math.floor(stats.mtimeMs));
      max = Math.max(
        max,
        await walkWorkspaceMtimeMax(entryPath, workspaceRoot, ignore, max)
      );
    } else if (!isMtimeIgnored(workspaceRoot, entryPath, ignore)) {
      // ADR 0054: drop files whose workspace-relative path matches an
      // mtime_ignore glob so build-output churn (e.g. *.log) cannot keep a
      // wedged Run alive through the workspace-mtime signal.
      max = Math.max(max, Math.floor(stats.mtimeMs));
    }
  }
  return max;
}

function isMtimeIgnored(
  workspaceRoot: string,
  entryPath: string,
  ignore: readonly RegExp[]
): boolean {
  if (ignore.length === 0) {
    return false;
  }
  const relative = path
    .relative(workspaceRoot, entryPath)
    .split(path.sep)
    .join("/");
  return ignore.some((pattern) => pattern.test(relative));
}

// Compile a workspace-relative glob to an anchored RegExp. `*` matches within a
// path segment, `**` matches across separators, `?` matches one non-separator
// character; everything else is matched literally.
function globToRegExp(glob: string): RegExp {
  let source = "";
  let i = 0;
  while (i < glob.length) {
    const char = glob.charAt(i);
    if (char === "*") {
      if (glob.charAt(i + 1) === "*") {
        source += ".*";
        i += 2;
        if (glob.charAt(i) === "/") {
          i += 1;
        }
      } else {
        source += "[^/]*";
        i += 1;
      }
    } else if (char === "?") {
      source += "[^/]";
      i += 1;
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

function parseJsonlEvents(contents: string): NormalizedProviderEvent[] {
  const events: NormalizedProviderEvent[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { type?: unknown }).type === "string"
      ) {
        events.push(parsed as NormalizedProviderEvent);
      }
    } catch {
      continue;
    }
  }
  return events;
}

function collectTurnIds(events: NormalizedProviderEvent[]): Set<string> {
  const turnIds = new Set<string>();
  for (const event of events) {
    const turnId = stringField(event, "turnId");
    if (turnId !== undefined) {
      turnIds.add(turnId);
    }
  }
  return turnIds;
}

function latestToolCallAt(
  previous: string | null,
  events: NormalizedProviderEvent[],
  sampledAt: string
): string | null {
  return events.some((event) => event.type === "tool_call")
    ? sampledAt
    : previous;
}

function latestMessageAt(
  previous: string | null,
  events: NormalizedProviderEvent[],
  sampledAt: string
): string | null {
  // Both providers normalize streamed assistant deltas (Claude text_delta,
  // Codex item/agentMessage/delta) to a `message` event, so a fresh `message`
  // since the last sample is genuine user-visible output — ADR 0054 signal 5.
  return events.some((event) => event.type === "message")
    ? sampledAt
    : previous;
}

function outputTokensTotal(
  previousTotal: number,
  events: NormalizedProviderEvent[]
): number {
  let total = previousTotal;
  for (const event of events) {
    if (event.type !== "usage_updated") {
      continue;
    }
    const tokens = outputTokens(event);
    if (tokens !== undefined) {
      total = Math.max(total, tokens);
    }
  }
  return total;
}

function outputTokens(event: NormalizedProviderEvent): number | undefined {
  const usage = objectField(event, "tokenUsage");
  return (
    numberField(usage, "outputTokens") ??
    numberField(usage, "output_tokens") ??
    numberField(usage, "output")
  );
}

function toolCallAdvanced(
  previous: WatchdogSample,
  next: WatchdogSample
): boolean {
  if (next.lastToolCallAt === null) {
    return false;
  }
  if (previous.lastToolCallAt === null) {
    return true;
  }
  return Date.parse(next.lastToolCallAt) > Date.parse(previous.lastToolCallAt);
}

function messageAdvanced(
  previous: WatchdogSample,
  next: WatchdogSample
): boolean {
  if (next.lastMessageAt === null) {
    return false;
  }
  if (previous.lastMessageAt === null) {
    return true;
  }
  return Date.parse(next.lastMessageAt) > Date.parse(previous.lastMessageAt);
}

function objectField(
  value: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const inner = value[key];
  return typeof inner === "object" && inner !== null
    ? (inner as Record<string, unknown>)
    : undefined;
}

function numberField(
  value: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const inner = value[key];
  return typeof inner === "number" && Number.isFinite(inner)
    ? inner
    : undefined;
}

function stringField(
  value: Record<string, unknown>,
  key: string
): string | undefined {
  const inner = value[key];
  return typeof inner === "string" ? inner : undefined;
}
