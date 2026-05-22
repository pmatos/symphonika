import { createReadStream } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";

import type { NormalizedProviderEvent } from "../provider.js";
import type { WatchdogConfig } from "../reload.js";
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
    next.outputTokensTotal > previous.outputTokensTotal
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
  let sampled = 0;
  let terminated = 0;

  for (const run of input.runStore.listWatchdogCandidateRuns()) {
    const previous = input.runStore.getWatchdogSample(run.runId);
    const next = await sampleRun({
      previous,
      run,
      runStore: input.runStore,
      sampledAt
    });
    const progress =
      previous === undefined ? false : watchdogProgressObserved(previous, next);
    const idleSince = progress ? null : previous?.idleSince ?? sampledAt;
    const persisted = {
      ...next,
      idleSince
    };
    input.runStore.upsertWatchdogSample(persisted);
    sampled += 1;

    if (progress || idleSince === null) {
      continue;
    }
    if (now.getTime() - Date.parse(idleSince) < input.config.graceMinutes * 60_000) {
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
  workspacePath: string
): Promise<number> {
  if (workspacePath.length === 0) {
    return 0;
  }

  try {
    const root = await stat(workspacePath);
    if (!root.isDirectory()) {
      return Math.floor(root.mtimeMs);
    }
    return await walkWorkspaceMtimeMax(workspacePath, Math.floor(root.mtimeMs));
  } catch {
    return 0;
  }
}

async function sampleRun(input: {
  previous: WatchdogSample | undefined;
  run: WatchdogCandidateRun;
  runStore: RunStore;
  sampledAt: string;
}): Promise<WatchdogSample> {
  const previousOffset = input.previous?.normalizedLogOffset ?? 0;
  const log = await readNormalizedEventsSince(
    input.run.normalizedLogPath,
    previousOffset
  );
  const turnIds = collectTurnIds(log.events);
  const turnIdSetSize = input.runStore.rememberWatchdogTurnIds(
    input.run.runId,
    turnIds
  );
  return {
    idleSince: null,
    lastToolCallAt: latestToolCallAt(
      input.previous?.lastToolCallAt ?? null,
      log.events,
      input.sampledAt
    ),
    normalizedLogOffset: log.offset,
    outputTokensTotal: outputTokensTotal(
      input.previous?.outputTokensTotal ?? 0,
      log.events
    ),
    runId: input.run.runId,
    sampledAt: input.sampledAt,
    turnIdSetSize,
    workspaceMtimeMax: await sampleWorkspaceMtimeMax(input.run.workspacePath)
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
  for await (const chunk of createReadStream(filePath, {
    encoding: "utf8",
    start
  })) {
    contents += chunk;
  }
  const events = parseJsonlEvents(contents);
  return { events, offset: size };
}

async function walkWorkspaceMtimeMax(
  directory: string,
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
      stats = await stat(entryPath);
    } catch {
      continue;
    }
    max = Math.max(max, Math.floor(stats.mtimeMs));
    if (stats.isDirectory()) {
      max = Math.max(max, await walkWorkspaceMtimeMax(entryPath, max));
    }
  }
  return max;
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
  return events.some((event) => event.type === "tool_call") ? sampledAt : previous;
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
  return typeof inner === "number" && Number.isFinite(inner) ? inner : undefined;
}

function stringField(
  value: Record<string, unknown>,
  key: string
): string | undefined {
  const inner = value[key];
  return typeof inner === "string" ? inner : undefined;
}
