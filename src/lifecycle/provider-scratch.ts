// Disk-backed scratch space for spawned providers.
//
// Agents and the tools they run put multi-gigabyte build output under
// $TMPDIR. On a host whose /tmp is a tmpfs — the default on most modern
// systemd distributions — that output is RAM, and nothing ever reclaims it:
// stale trees from finished runs sit there permanently removing memory from
// the machine until an operator clears them by hand. Issue #599 measured
// 45G of a 63G /tmp tmpfs held that way on a 124G host, with swap fully
// exhausted, while a `commitlint --edit` that normally takes 0.30s took 54
// minutes.
//
// Pointing each attempt's TMPDIR at a directory under the state root fixes
// both halves: the bytes land on disk rather than in RAM, and they have an
// owner that can delete them when the attempt ends. See ADR 0088.

import { mkdir, readdir, rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";

/** State-root-relative directory holding every attempt's scratch space. */
const PROVIDER_SCRATCH_DIRECTORY = "scratch";
/** Generated provider-slice hard memory ceiling; shared with service.ts. */
export const PROVIDER_SLICE_MEMORY_MAX_GIB = 32;
const BUILD_JOB_PEAK_MEMORY_MIB = 1536;

export type ProviderScratchIdentity = {
  attempt: number;
  id: string;
};

/** Root of all provider scratch directories for a state root. */
export function providerScratchRoot(stateRoot: string): string {
  return path.join(path.resolve(stateRoot), PROVIDER_SCRATCH_DIRECTORY);
}

/**
 * One attempt's scratch directory. Keyed by attempt, not just run, so a retry
 * never inherits a previous attempt's half-written temporary state.
 */
export function providerScratchPath(
  stateRoot: string,
  run: ProviderScratchIdentity
): string {
  return path.join(
    providerScratchRoot(stateRoot),
    `${safeScratchSegment(run.id)}-attempt-${run.attempt}`
  );
}

/** Create the attempt's scratch directory and return its path. */
export async function createProviderScratch(
  stateRoot: string,
  run: ProviderScratchIdentity
): Promise<string> {
  const scratchPath = providerScratchPath(stateRoot, run);
  await mkdir(scratchPath, { recursive: true });
  return scratchPath;
}

/**
 * Remove the attempt's scratch directory. Best effort by design: this runs
 * from an attempt's `finally`, where a failure to delete temporary files must
 * never mask the attempt's own outcome. A directory left behind is reclaimed
 * by the next startup sweep.
 */
export async function removeProviderScratch(
  stateRoot: string,
  run: ProviderScratchIdentity
): Promise<void> {
  await rm(providerScratchPath(stateRoot, run), {
    force: true,
    recursive: true
  });
}

/**
 * Resource environment for a spawned provider. Temporary files land in
 * `scratchPath`: TMPDIR is what POSIX tooling reads, while Node's
 * `os.tmpdir()` and cross-platform tools commonly consult TMP or TEMP first.
 *
 * When global concurrency is bounded, make and `cmake --build` also get the
 * smaller of this attempt's CPU share and its share of the generated provider
 * slice's hard memory budget. The 1.5 GiB per-job allowance is the measured
 * peak from the C++ build incident behind #643. With an unbounded global cap,
 * no honest per-attempt share exists and those variables stay unset.
 */
export function providerScratchEnvironment(
  scratchPath: string | undefined,
  capacity?: {
    globalMaxInFlight: number;
    hostParallelism?: number;
  }
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  if (scratchPath !== undefined) {
    environment.TEMP = scratchPath;
    environment.TMP = scratchPath;
    environment.TMPDIR = scratchPath;
  }
  if (capacity !== undefined) {
    const concurrentAttempts = Math.max(
      1,
      Math.floor(capacity.globalMaxInFlight)
    );
    const memoryShare = Math.max(
      1,
      Math.floor(
        (PROVIDER_SLICE_MEMORY_MAX_GIB * 1024) /
          BUILD_JOB_PEAK_MEMORY_MIB /
          concurrentAttempts
      )
    );
    const hostJobs = Math.max(
      1,
      Math.floor(capacity.hostParallelism ?? availableParallelism())
    );
    const cpuShare = Math.max(1, Math.floor(hostJobs / concurrentAttempts));
    const buildParallelism = Math.min(cpuShare, memoryShare);
    environment.CMAKE_BUILD_PARALLEL_LEVEL = String(buildParallelism);
    environment.MAKEFLAGS = `-j${buildParallelism}`;
  }
  return environment;
}

export type SweepProviderScratchReport = {
  failures: Array<{ error: string; path: string }>;
  removed: string[];
};

/**
 * Remove every scratch directory left behind by a previous daemon instance.
 * A crashed or SIGKILLed daemon never runs its attempts' `finally` blocks, so
 * without this the very accumulation this module exists to prevent would
 * simply move from /tmp to the state root. Runs at startup, where no attempt
 * of this instance owns a scratch directory yet, so removing all of them is
 * unambiguous.
 */
export async function sweepProviderScratch(
  stateRoot: string
): Promise<SweepProviderScratchReport> {
  const root = providerScratchRoot(stateRoot);
  const report: SweepProviderScratchReport = { failures: [], removed: [] };
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    // No scratch root yet (a fresh state root, or nothing has run) — nothing
    // to sweep, and creating one here would be pointless.
    return report;
  }
  for (const entry of entries) {
    const entryPath = path.join(root, entry);
    try {
      await rm(entryPath, { force: true, recursive: true });
      report.removed.push(entryPath);
    } catch (error) {
      report.failures.push({ error: errorMessage(error), path: entryPath });
    }
  }
  return report;
}

// Run and firing ids are generated (UUID / ULID), but they reach here from
// the run store rather than from a fresh mint, so a traversal segment must
// not be able to steer a recursive delete out of the scratch root.
function safeScratchSegment(input: string): string {
  const segment = input
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|-+$/g, "");
  return segment.length === 0 ? "run" : segment;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
