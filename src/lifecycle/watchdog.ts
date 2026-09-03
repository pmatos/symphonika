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
  RoutineWatchdogSample,
  RunStore,
  WatchdogCandidateRoutineFiring,
  WatchdogCandidateRun,
  WatchdogProgressSample,
  WatchdogSample,
  WatchdogTerminalReason
} from "../run-store.js";

import type { ActiveRunRegistry } from "./active-runs.js";
import {
  driveWatchdogSubject,
  type WatchdogSubjectContext,
  type WatchdogSubjectPort
} from "./watchdog-subject.js";

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

// Signed milliseconds since a Run's claim, or undefined when its timestamp is
// unusable. An unparseable timestamp must read as "age unknown" rather than
// "infinitely old": the wall-clock cap is the one rule that would otherwise
// terminate a perfectly live Run on the strength of a bad row. A future claim
// remains negative so clock skew stays visible and this value remains the exact
// complement of the time-to-deadline calculation in watchdog-status.ts.
export function runElapsedMs(createdAt: string, now: Date): number | undefined {
  const claimedAtMs = Date.parse(createdAt);
  if (Number.isNaN(claimedAtMs)) {
    return undefined;
  }
  return now.getTime() - claimedAtMs;
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

function notifySettledRoutineWatchdogTerminations(
  input: ReconcileWatchdogInput
): void {
  for (const firing of input.runStore.claimSettledRoutineWatchdogTerminations()) {
    try {
      input.onRoutineTerminated?.(firing);
    } catch (error) {
      input.logger?.warn(
        { err: error, firingId: firing.firingId },
        "symphonika routine watchdog termination observer failed"
      );
    }
  }
}

// Drains settled routine watchdog notifications after a successful pass — the
// disabled-config early return and the normal completion both return normally
// from sampleAndTerminate, so one call after the await covers both without
// duplicating it at each return site. This must NOT be a `finally`: a thrown
// sampleAndTerminate (a runStore call, or a rejected cancellation) would still
// durably clear the pending bit and invoke the observer, but the caller's own
// rethrow skips forwarding that entry onward — permanently losing an alert
// that would otherwise have retried claiming it on the next tick.
export async function reconcileWatchdog(
  input: ReconcileWatchdogInput
): Promise<WatchdogReconcileResult> {
  const result = await sampleAndTerminate(input);
  notifySettledRoutineWatchdogTerminations(input);
  return result;
}

async function sampleAndTerminate(
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
  const ctx: WatchdogSubjectContext = {
    cancellations: [],
    now,
    requestCancel: (id, reason) => input.activeRuns.requestCancel(id, reason),
    resolveConfig: (projectName) =>
      resolveWatchdogConfig(serviceConfig, projectName),
    sampledAt
  };

  const runPort: WatchdogSubjectPort<WatchdogCandidateRun> = {
    // Runs onto the shared cancellation sink under the verdict's own name, then
    // fires the termination observer (guarded so a throwing observer never
    // suppresses the audit line that follows) and logs.
    announce: (run, outcome) => {
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
          elapsedMs: runElapsedMs(run.createdAt, outcome.now),
          issueNumber: run.issueNumber,
          maxRunMinutes: outcome.config.maxRunMinutes,
          outputTokenBudget: outcome.config.outputTokenBudget,
          outputTokensTotal: outcome.outputTokensTotal,
          project: run.projectName,
          runId: run.runId,
          terminalReason: outcome.terminalReason
        },
        "symphonika watchdog marked run stale"
      );
    },
    candidates: () => input.runStore.listWatchdogCandidateRuns(),
    id: (run) => run.runId,
    loadPrevious: (run) => input.runStore.getWatchdogSample(run.runId),
    markStale: (run, terminalReason, at) =>
      input.runStore.markRunWatchdogStale(
        run.runId,
        terminalReason,
        at,
        run.watchdogGeneration
      ),
    persist: (run, sample) =>
      input.runStore.upsertWatchdogSample(
        { ...sample, runId: run.runId },
        run.watchdogGeneration
      ),
    projectName: (run) => run.projectName,
    sample: (run, sampleInput) =>
      sampleRun({
        directoryIgnore:
          input.evidenceIgnoreForProject?.(run.projectName) ??
          run.evidenceIgnore,
        mtimeIgnore: sampleInput.config.mtimeIgnore,
        mtimeInclude: sampleInput.config.mtimeInclude,
        previous: sampleInput.previous,
        run,
        runStore: input.runStore,
        sampledAt: sampleInput.sampledAt
      }),
    // ADR 0086/0089: the wall-clock cap and the convergence budget are checked
    // ahead of the liveness clock and independently of it. A Run that burns its
    // whole output-token budget, or trickles real work forever, satisfies the
    // liveness rule on every tick and would never be bounded by it alone.
    terminalReason: (run, decision) =>
      watchdogTerminalReason({
        budget: decision.config.outputTokenBudget,
        createdAt: run.createdAt,
        graceMs: decision.config.graceMinutes * 60_000,
        idleSince: decision.idleSince,
        maxRunMs: decision.config.maxRunMinutes * 60_000,
        now: decision.now,
        outputTokensTotal: decision.outputTokensTotal,
        progress: decision.progress
      })
  };

  const firingPort: WatchdogSubjectPort<WatchdogCandidateRoutineFiring> = {
    // The termination observer fires later, once cancellation has actually
    // settled — see notifySettledRoutineWatchdogTerminations. This announce
    // only logs that cancellation was requested.
    announce: (firing) => {
      input.logger?.warn(
        {
          firingId: firing.firingId,
          project: firing.projectName,
          terminalReason: "no_progress"
        },
        "symphonika watchdog requested routine firing cancellation"
      );
    },
    candidates: () => input.runStore.listWatchdogCandidateRoutineFirings(),
    id: (firing) => firing.firingId,
    loadPrevious: (firing) =>
      input.runStore.getRoutineWatchdogSample(firing.firingId),
    markStale: (firing, _terminalReason, at) =>
      input.runStore.markRoutineFiringWatchdogNoProgress(firing.firingId, at),
    persist: (firing, sample) =>
      input.runStore.upsertRoutineWatchdogSample({
        ...sample,
        firingId: firing.firingId
      }),
    projectName: (firing) => firing.projectName,
    sample: (firing, sampleInput) =>
      sampleRoutineFiring({
        firing,
        mtimeIgnore: sampleInput.config.mtimeIgnore,
        mtimeInclude: sampleInput.config.mtimeInclude,
        previous: sampleInput.previous,
        runStore: input.runStore,
        sampledAt: sampleInput.sampledAt
      }),
    // ADR 0091: a Routine Firing is bounded by the liveness rule alone — no
    // wall-clock cap, no convergence budget — so its only terminal reason is
    // `no_progress`.
    terminalReason: (_firing, decision) =>
      idleGraceExpired({
        graceMs: decision.config.graceMinutes * 60_000,
        idleSince: decision.idleSince,
        now: decision.now,
        progress: decision.progress
      })
        ? "no_progress"
        : undefined
  };

  const runResult = await driveWatchdogSubject(runPort, ctx);
  const firingResult = await driveWatchdogSubject(firingPort, ctx);

  await Promise.all(ctx.cancellations);
  return {
    sampled: runResult.sampled + firingResult.sampled,
    terminated: runResult.terminated + firingResult.terminated
  };
}

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
  return idleGraceExpired(input) ? "no_progress" : undefined;
}

// The liveness rule itself, shared by both Watchdog paths. ADR 0091 keeps the
// convergence budget and the wall-clock cap Run-only, so a Routine Firing is
// bounded by this rule alone.
function idleGraceExpired(input: {
  graceMs: number;
  idleSince: string | null;
  now: Date;
  progress: boolean;
}): boolean {
  if (input.progress || input.idleSince === null) {
    return false;
  }
  return input.now.getTime() - Date.parse(input.idleSince) >= input.graceMs;
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
  previous: WatchdogProgressSample | undefined;
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
  previous: WatchdogProgressSample | undefined;
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
      ["plan_updated", "progress", "thinking"],
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
// summary text (issue #590), while `plan_updated` carries the current
// operator-facing checklist and proves that the model advanced its work
// (ADR 0096).
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
