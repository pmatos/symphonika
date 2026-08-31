import { createHash } from "node:crypto";
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
  CancelReason,
  RoutineWatchdogSample,
  RunStore,
  WatchdogCandidateRoutineFiring,
  WatchdogCandidateRun,
  WatchdogSample,
  WatchdogTerminalReason
} from "../run-store.js";

import { ActiveRunRegistry, CANCEL_REASONS } from "./active-runs.js";

// Directory names whose contents are build or tool output in the ecosystems
// Symphonika dispatches against. They are never descended into, so a
// rebuild-and-crash cycle cannot masquerade as workspace progress. A repository
// adds its own trees through the Workflow Contract's `evidence.ignore` list,
// and opts a named tree back in through the Watchdog's `mtime_include`
// (ADR 0087) — for a compiled project every byte of build progress lands under
// one of these names, so without that opt-in the workspace signal is
// structurally dead for the whole build.
const WORKSPACE_EXCLUDED_DIRS = new Set([
  ".cache",
  ".git",
  ".gradle",
  ".mypy_cache",
  ".next",
  ".nyc_output",
  ".pytest_cache",
  ".ruff_cache",
  ".stack-work",
  ".tox",
  ".turbo",
  ".venv",
  "__pycache__",
  "_build",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "venv"
]);

export type ReconcileWatchdogInput = {
  activeRuns: ActiveRunRegistry;
  config: WatchdogConfig;
  evidenceIgnoreForProject?: (
    projectName: string
  ) => readonly string[] | undefined;
  logger?: Logger;
  now?: () => Date;
  onTerminated?: (run: {
    issueNumber: number;
    projectName: string;
    runId: string;
  }) => void;
  onRoutineTerminated?: (firing: {
    firingId: string;
    projectName: string;
    routineName: string;
  }) => void;
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

type WatchdogProgressSample = Omit<WatchdogSample, "runId">;

// Milliseconds a Run has been alive, or undefined when its claim timestamp is
// unusable. An unparseable timestamp must read as "age unknown" rather than
// "infinitely old": the wall-clock cap is the one rule that would otherwise
// terminate a perfectly live Run on the strength of a bad row. Clamped at zero
// so clock skew cannot produce a negative age.
export function runElapsedMs(createdAt: string, now: Date): number | undefined {
  const claimedAtMs = Date.parse(createdAt);
  if (Number.isNaN(claimedAtMs)) {
    return undefined;
  }
  return Math.max(0, now.getTime() - claimedAtMs);
}

export function watchdogProgressObserved(
  previous: WatchdogProgressSample,
  next: WatchdogProgressSample
): boolean {
  return (
    toolCallAdvanced(previous, next) ||
    workspaceChanged(previous, next) ||
    next.turnIdSetSize > previous.turnIdSetSize ||
    next.outputTokensTotal > previous.outputTokensTotal ||
    messageAdvanced(previous, next) ||
    timestampAdvanced(previous.lastProgressAt, next.lastProgressAt)
  );
}

// ADR 0086: the workspace signal is a change in the tree's shape — which files
// exist and how large they are — not a bare mtime advance. A build that
// reproduces byte-identical output on every cycle refreshes mtimes without
// carrying new information, which is how the vow#1055 incident kept a wedged
// Run's workspace signal alive for fourteen hours. Digests are compared
// literally; an empty previous digest is a pre-upgrade row rather than an
// observation, so it is not read as a change.
function workspaceChanged(
  previous: WatchdogProgressSample,
  next: WatchdogProgressSample
): boolean {
  if (previous.workspaceDigest.length === 0) {
    return false;
  }
  return next.workspaceDigest !== previous.workspaceDigest;
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
  const cancellations: Promise<void>[] = [];
  let sampled = 0;
  let terminated = 0;

  for (const run of input.runStore.listWatchdogCandidateRuns()) {
    const config = resolveWatchdogConfig(serviceConfig, run.projectName);
    const previous = input.runStore.getWatchdogSample(run.runId);
    const next = await sampleRun({
      directoryIgnore:
        input.evidenceIgnoreForProject?.(run.projectName) ?? run.evidenceIgnore,
      mtimeIgnore: config.mtimeIgnore,
      mtimeInclude: config.mtimeInclude,
      previous,
      run,
      runStore: input.runStore,
      sampledAt
    });
    if (next === undefined) {
      continue;
    }
    const progress =
      previous === undefined ? false : watchdogProgressObserved(previous, next);
    // ADR 0054: attempt start normally clears the latest sample and advances
    // the generation fence before preparing_workspace. Keep path-change
    // detection as a defensive fallback for legacy or partially-upgraded state
    // so a surviving prior-attempt row still cannot carry its idle clock into
    // the new attempt.
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
    if (
      !input.runStore.upsertWatchdogSample(persisted, run.watchdogGeneration)
    ) {
      continue;
    }
    sampled += 1;

    // ADR 0086: the convergence budget is checked before the liveness clock and
    // independently of it. A Run that burns its whole output-token budget
    // without finishing is busy, not idle — the liveness rule is satisfied on
    // every tick and would never fire. ADR 0089's wall-clock cap sits ahead of
    // both for the same reason, one step further: a Run trickling real work
    // satisfies the liveness rule AND stays under the budget, so elapsed time
    // is the only signal left that can bound it.
    const terminalReason = watchdogTerminalReason({
      budget: config.outputTokenBudget,
      createdAt: run.createdAt,
      graceMs: config.graceMinutes * 60_000,
      idleSince,
      maxRunMs: config.maxRunMinutes * 60_000,
      now,
      outputTokensTotal: persisted.outputTokensTotal,
      progress
    });
    if (terminalReason === undefined) {
      continue;
    }

    const marked = input.runStore.markRunWatchdogStale(
      run.runId,
      terminalReason,
      sampledAt,
      run.watchdogGeneration
    );
    if (!marked) {
      continue;
    }
    cancellations.push(
      input.activeRuns.requestCancel(
        run.runId,
        WATCHDOG_CANCEL_REASONS[terminalReason]
      )
    );
    terminated += 1;
    try {
      input.onTerminated?.({
        issueNumber: run.issueNumber,
        projectName: run.projectName,
        runId: run.runId
      });
    } catch (error) {
      input.logger?.warn(
        { err: error, runId: run.runId },
        "symphonika watchdog termination observer failed"
      );
    }
    input.logger?.warn(
      {
        elapsedMs: runElapsedMs(run.createdAt, now),
        issueNumber: run.issueNumber,
        maxRunMinutes: config.maxRunMinutes,
        outputTokenBudget: config.outputTokenBudget,
        outputTokensTotal: persisted.outputTokensTotal,
        project: run.projectName,
        runId: run.runId,
        terminalReason
      },
      "symphonika watchdog marked run stale"
    );
  }

  for (const firing of input.runStore.listWatchdogCandidateRoutineFirings()) {
    const config = resolveWatchdogConfig(serviceConfig, firing.projectName);
    const previous = input.runStore.getRoutineWatchdogSample(firing.firingId);
    const next = await sampleRoutineFiring({
      firing,
      mtimeIgnore: config.mtimeIgnore,
      mtimeInclude: config.mtimeInclude,
      previous,
      runStore: input.runStore,
      sampledAt
    });
    if (next === undefined) {
      continue;
    }
    const progress =
      previous === undefined ? false : watchdogProgressObserved(previous, next);
    const attemptChanged =
      previous !== undefined &&
      previous.normalizedLogPath !== firing.normalizedLogPath;
    const idleSince = progress
      ? null
      : attemptChanged
        ? sampledAt
        : (previous?.idleSince ?? sampledAt);
    const persisted = { ...next, idleSince };
    if (!input.runStore.upsertRoutineWatchdogSample(persisted)) {
      continue;
    }
    sampled += 1;

    if (
      progress ||
      idleSince === null ||
      now.getTime() - Date.parse(idleSince) < config.graceMinutes * 60_000
    ) {
      continue;
    }
    if (
      !input.runStore.markRoutineFiringWatchdogNoProgress(
        firing.firingId,
        sampledAt
      )
    ) {
      continue;
    }
    cancellations.push(
      input.activeRuns.requestCancel(
        firing.firingId,
        CANCEL_REASONS.NO_PROGRESS
      )
    );
    terminated += 1;
    try {
      input.onRoutineTerminated?.({
        firingId: firing.firingId,
        projectName: firing.projectName,
        routineName: firing.routineName
      });
    } catch (error) {
      input.logger?.warn(
        { err: error, firingId: firing.firingId },
        "symphonika routine watchdog termination observer failed"
      );
    }
    input.logger?.warn(
      {
        firingId: firing.firingId,
        project: firing.projectName,
        terminalReason: "no_progress"
      },
      "symphonika watchdog terminated routine firing"
    );
  }

  await Promise.all(cancellations);
  return { sampled, terminated };
}

// Each Watchdog verdict cancels under its own name, so the three bounds stay
// distinguishable on the in-flight registry entry while the Run is still live.
// This reason is in-memory only — `markRunWatchdogStale` deliberately does not
// write `runs.cancel_reason` (it reads `cancel_requested = 0` as its guard
// against a competing cancel), so the durable verdict is `terminal_reason`.
const WATCHDOG_CANCEL_REASONS: Readonly<
  Record<WatchdogTerminalReason, CancelReason>
> = {
  no_convergence: CANCEL_REASONS.NO_CONVERGENCE,
  no_progress: CANCEL_REASONS.NO_PROGRESS,
  run_timeout: CANCEL_REASONS.RUN_TIMEOUT
};

function watchdogTerminalReason(input: {
  budget: number;
  createdAt: string;
  graceMs: number;
  idleSince: string | null;
  maxRunMs: number;
  now: Date;
  outputTokensTotal: number;
  progress: boolean;
}): WatchdogTerminalReason | undefined {
  if (input.maxRunMs > 0) {
    const elapsedMs = runElapsedMs(input.createdAt, input.now);
    if (elapsedMs !== undefined && elapsedMs >= input.maxRunMs) {
      return "run_timeout";
    }
  }
  if (input.budget > 0 && input.outputTokensTotal >= input.budget) {
    return "no_convergence";
  }
  if (input.progress || input.idleSince === null) {
    return undefined;
  }
  if (input.now.getTime() - Date.parse(input.idleSince) < input.graceMs) {
    return undefined;
  }
  return "no_progress";
}

export type WorkspaceSample = {
  digest: string;
  mtimeMax: number;
};

export async function sampleWorkspace(
  workspacePath: string,
  mtimeIgnore: readonly string[] = [],
  directoryIgnore: readonly string[] = [],
  directoryInclude: readonly string[] = []
): Promise<WorkspaceSample> {
  if (workspacePath.length === 0) {
    return { digest: "", mtimeMax: 0 };
  }

  try {
    const root = await stat(workspacePath);
    if (!root.isDirectory()) {
      return {
        digest: digestEntries([`${path.basename(workspacePath)}:${root.size}`]),
        mtimeMax: Math.floor(root.mtimeMs)
      };
    }
    const ignore = mtimeIgnore.map(globToRegExp);
    const ignoredDirectories = new Set(
      directoryIgnore.map(normalizeDirectoryPath)
    );
    const includedDirectories = new Set(
      directoryInclude.map(normalizeDirectoryPath)
    );
    const entries: string[] = [];
    const mtimeMax = await walkWorkspaceMtimeMax(
      workspacePath,
      workspacePath,
      ignore,
      ignoredDirectories,
      includedDirectories,
      false,
      Math.floor(root.mtimeMs),
      entries
    );
    return { digest: digestEntries(entries), mtimeMax };
  } catch {
    return { digest: "", mtimeMax: 0 };
  }
}

export async function sampleWorkspaceMtimeMax(
  workspacePath: string,
  mtimeIgnore: readonly string[] = [],
  directoryIgnore: readonly string[] = [],
  directoryInclude: readonly string[] = []
): Promise<number> {
  return (
    await sampleWorkspace(
      workspacePath,
      mtimeIgnore,
      directoryIgnore,
      directoryInclude
    )
  ).mtimeMax;
}

// Sorted so the digest is independent of directory-read order, and hashed so a
// large workspace still costs one short string in the sample row.
function digestEntries(entries: string[]): string {
  const hash = createHash("sha1");
  for (const entry of entries.sort()) {
    hash.update(entry);
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function sampleRun(input: {
  directoryIgnore: readonly string[];
  mtimeIgnore: readonly string[];
  mtimeInclude: readonly string[];
  previous: WatchdogSample | undefined;
  run: WatchdogCandidateRun;
  runStore: RunStore;
  sampledAt: string;
}): Promise<WatchdogSample | undefined> {
  const sample = await sampleProgress({
    directoryIgnore: input.directoryIgnore,
    mtimeIgnore: input.mtimeIgnore,
    mtimeInclude: input.mtimeInclude,
    normalizedLogPath: input.run.normalizedLogPath,
    previous: input.previous,
    rememberTurnIds: (turnIds) =>
      input.runStore.rememberWatchdogTurnIds(
        input.run.runId,
        turnIds,
        input.run.watchdogGeneration
      ),
    sampledAt: input.sampledAt,
    workspacePath: input.run.workspacePath
  });
  return sample === undefined
    ? undefined
    : { ...sample, runId: input.run.runId };
}

async function sampleRoutineFiring(input: {
  firing: WatchdogCandidateRoutineFiring;
  mtimeIgnore: readonly string[];
  mtimeInclude: readonly string[];
  previous: RoutineWatchdogSample | undefined;
  runStore: RunStore;
  sampledAt: string;
}): Promise<RoutineWatchdogSample | undefined> {
  const sample = await sampleProgress({
    directoryIgnore: [],
    mtimeIgnore: input.mtimeIgnore,
    mtimeInclude: input.mtimeInclude,
    normalizedLogPath: input.firing.normalizedLogPath,
    previous: input.previous,
    rememberTurnIds: (turnIds) =>
      input.runStore.rememberRoutineWatchdogTurnIds(
        input.firing.firingId,
        turnIds
      ),
    sampledAt: input.sampledAt,
    workspacePath: input.firing.workspacePath
  });
  return sample === undefined
    ? undefined
    : { ...sample, firingId: input.firing.firingId };
}

async function sampleProgress(input: {
  directoryIgnore: readonly string[];
  mtimeIgnore: readonly string[];
  mtimeInclude: readonly string[];
  normalizedLogPath: string;
  previous: WatchdogProgressSample | undefined;
  rememberTurnIds: (turnIds: Iterable<string>) => number | undefined;
  sampledAt: string;
  workspacePath: string;
}): Promise<WatchdogProgressSample | undefined> {
  // A retry writes a fresh normalized log. Carry per-attempt offsets and
  // token totals only while the path is unchanged; Routine Firings have one
  // attempt but use the same defensive reset if their evidence path changes.
  const carryOver =
    input.previous !== undefined &&
    input.previous.normalizedLogPath === input.normalizedLogPath
      ? input.previous
      : undefined;
  const log = await readNormalizedEventsSince(
    input.normalizedLogPath,
    carryOver?.normalizedLogOffset ?? 0
  );
  const turnIdSetSize = input.rememberTurnIds(collectTurnIds(log.events));
  if (turnIdSetSize === undefined) {
    return undefined;
  }
  const workspace = await sampleWorkspace(
    input.workspacePath,
    input.mtimeIgnore,
    input.directoryIgnore,
    input.mtimeInclude
  );
  return {
    idleSince: null,
    lastMessageAt: latestEventAt(
      input.previous?.lastMessageAt ?? null,
      log.events,
      ["message"],
      input.sampledAt
    ),
    lastProgressAt: latestEventAt(
      input.previous?.lastProgressAt ?? null,
      log.events,
      ["progress", "thinking"],
      input.sampledAt
    ),
    lastToolCallAt: latestEventAt(
      input.previous?.lastToolCallAt ?? null,
      log.events,
      ["tool_call"],
      input.sampledAt
    ),
    normalizedLogOffset: log.offset,
    normalizedLogPath: input.normalizedLogPath,
    outputTokensTotal: outputTokensTotal(
      carryOver?.outputTokensTotal ?? 0,
      log.events
    ),
    sampledAt: input.sampledAt,
    turnIdSetSize,
    workspaceDigest: workspace.digest,
    workspaceMtimeMax: workspace.mtimeMax
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
  ignoredDirectories: ReadonlySet<string>,
  includedDirectories: ReadonlySet<string>,
  insideIncluded: boolean,
  currentMax: number,
  entries: string[]
): Promise<number> {
  let max = currentMax;
  let dir;
  try {
    dir = await opendir(directory);
  } catch {
    return max;
  }

  for await (const entry of dir) {
    const entryPath = path.join(directory, entry.name);
    const relative = workspaceRelativePath(workspaceRoot, entryPath);
    // An opted-in tree suppresses the built-in name exclusions for everything
    // beneath it, not just its own entry: a Rust `target/` holds `build/` and
    // `deps/` directories that the built-in set would otherwise prune again one
    // level down, leaving the opt-in doing almost nothing. Explicit ignores
    // still win everywhere, so a repository can name a noisy subtree back out.
    const included = insideIncluded || includedDirectories.has(relative);
    if (
      entry.isDirectory() &&
      (ignoredDirectories.has(relative) ||
        (!included && WORKSPACE_EXCLUDED_DIRS.has(entry.name)))
    ) {
      continue;
    }
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
        await walkWorkspaceMtimeMax(
          entryPath,
          workspaceRoot,
          ignore,
          ignoredDirectories,
          includedDirectories,
          included,
          max,
          entries
        )
      );
    } else if (!isMtimeIgnored(workspaceRoot, entryPath, ignore)) {
      // ADR 0054: drop files whose workspace-relative path matches an
      // mtime_ignore glob so build-output churn (e.g. *.log) cannot keep a
      // wedged Run alive through the workspace-mtime signal.
      max = Math.max(max, Math.floor(stats.mtimeMs));
      entries.push(`${relative}:${stats.size}`);
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
  const relative = workspaceRelativePath(workspaceRoot, entryPath);
  return ignore.some((pattern) => pattern.test(relative));
}

function normalizeDirectoryPath(directory: string): string {
  return directory.replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function workspaceRelativePath(
  workspaceRoot: string,
  entryPath: string
): string {
  return path.relative(workspaceRoot, entryPath).split(path.sep).join("/");
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

// A signal timestamp is "this sample saw at least one such event since the
// previous one", not the event's own clock: most normalized events carry no
// timestamp, and the sample time is what the any-of rule compares consistently.
// `message` covers both providers' streamed assistant deltas (Claude
// text_delta, Codex item/agentMessage/delta) — ADR 0054 signal 5 — and
// `progress` covers the payload-free provider liveness markers of ADR 0087;
// `thinking` covers Codex reasoning boundaries even when Codex supplies no
// summary text (issue #590).
function latestEventAt(
  previous: string | null,
  events: NormalizedProviderEvent[],
  types: readonly string[],
  sampledAt: string
): string | null {
  return events.some((event) => types.includes(event.type))
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
    const usage = objectField(event, "tokenUsage");
    if (usage === undefined) {
      continue;
    }
    // Providers report output tokens in two different shapes. Codex nests a
    // cumulative running total under `tokenUsage.total`; Claude and Oh My Pi
    // report one completed assistant message's output at the top level. An
    // absolute total is taken as-is, a per-message count is added, so the
    // sample is a true cumulative for every provider (ADR 0086).
    const cumulative = cumulativeOutputTokens(usage);
    if (cumulative !== undefined) {
      total = Math.max(total, cumulative);
      continue;
    }
    const increment = perMessageOutputTokens(usage);
    if (increment !== undefined) {
      total += increment;
    }
  }
  return total;
}

function cumulativeOutputTokens(
  usage: Record<string, unknown>
): number | undefined {
  return numberField(objectField(usage, "total"), "outputTokens");
}

function perMessageOutputTokens(
  usage: Record<string, unknown>
): number | undefined {
  return (
    numberField(usage, "outputTokens") ??
    numberField(usage, "output_tokens") ??
    numberField(usage, "output")
  );
}

function toolCallAdvanced(
  previous: WatchdogProgressSample,
  next: WatchdogProgressSample
): boolean {
  return timestampAdvanced(previous.lastToolCallAt, next.lastToolCallAt);
}

function messageAdvanced(
  previous: WatchdogProgressSample,
  next: WatchdogProgressSample
): boolean {
  return timestampAdvanced(previous.lastMessageAt, next.lastMessageAt);
}

function timestampAdvanced(
  previous: string | null,
  next: string | null
): boolean {
  if (next === null) {
    return false;
  }
  if (previous === null) {
    return true;
  }
  return Date.parse(next) > Date.parse(previous);
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
