import type { WatchdogConfig } from "../reload.js";
import type {
  CancelReason,
  WatchdogProgressSample,
  WatchdogTerminalReason
} from "../run-store.js";

import { CANCEL_REASONS } from "./active-runs.js";
import { watchdogProgressObserved } from "./watchdog.js";

// One Watchdog subject kind (a Run, or a Routine Firing) expressed as the
// variance between the two otherwise-identical reconcile loops. Everything a
// member needs from the store, the observers, or the terminal policy is
// captured by the closure that builds the port in `reconcileWatchdog`, so the
// driver below — and any fake that drives it in a test — touches no RunStore,
// database, or workspace tree. `Candidate` is opaque to the driver: it is only
// ever threaded back into a port member, never read, so the id (`runId` vs
// `firingId`) and every other subject-specific field stay behind the seam.
export type WatchdogSubjectPort<Candidate> = {
  candidates: () => Iterable<Candidate>;
  id: (subject: Candidate) => string;
  projectName: (subject: Candidate) => string;
  // The id-keyed sample loaded as its shared half — the driver compares only
  // the progress fields, and the adapter re-attaches the id on persist.
  loadPrevious: (subject: Candidate) => WatchdogProgressSample | undefined;
  sample: (
    subject: Candidate,
    input: {
      config: WatchdogConfig;
      previous: WatchdogProgressSample | undefined;
      sampledAt: string;
    }
  ) => Promise<WatchdogProgressSample | undefined>;
  // false when the upsert lost its generation race — skip, no tally.
  persist: (subject: Candidate, sample: WatchdogProgressSample) => boolean;
  // undefined when the subject is still alive. The run-vs-firing terminal policy
  // split (ADR 0091: Firings are bounded by idle grace alone) lives here.
  terminalReason: (
    subject: Candidate,
    decision: {
      config: WatchdogConfig;
      idleSince: string | null;
      now: Date;
      outputTokensTotal: number;
      progress: boolean;
    }
  ) => WatchdogTerminalReason | undefined;
  // false when the mark lost its race — skip, no cancel, no announce.
  markStale: (
    subject: Candidate,
    reason: WatchdogTerminalReason,
    sampledAt: string
  ) => boolean;
  // Fires the termination observer and writes the audit log. Owns its own
  // observer try/catch so a throwing observer never suppresses the log.
  announce: (
    subject: Candidate,
    outcome: {
      config: WatchdogConfig;
      now: Date;
      outputTokensTotal: number;
      terminalReason: WatchdogTerminalReason;
    }
  ) => void;
};

// Subject-agnostic collaborators plus the one cancellation sink shared across
// every subject pass, so a single `Promise.all` in the caller awaits them all.
// `requestCancel` crosses as a closure rather than the `ActiveRunRegistry`
// itself: the registry no-ops silently on an unregistered id, so a spy closure
// is what lets a fake observe that a cancel was requested.
export type WatchdogSubjectContext = {
  cancellations: Promise<void>[];
  now: Date;
  requestCancel: (id: string, reason: CancelReason) => Promise<void>;
  resolveConfig: (projectName: string) => WatchdogConfig;
  sampledAt: string;
};

// The idle clock both Watchdog paths run on. ADR 0054: attempt start normally
// clears the latest sample and advances the generation fence before
// preparing_workspace. Keep path-change detection as a defensive fallback for
// legacy or partially-upgraded state so a surviving prior-attempt row still
// cannot carry its idle clock into the new attempt. Routine Firings have one
// attempt, but the same reset applies if their evidence path ever changes.
function watchdogIdleClock(
  previous: WatchdogProgressSample | undefined,
  next: WatchdogProgressSample,
  sampledAt: string
): { idleSince: string | null; progress: boolean } {
  const progress =
    previous === undefined ? false : watchdogProgressObserved(previous, next);
  const attemptChanged =
    previous !== undefined &&
    previous.normalizedLogPath !== next.normalizedLogPath;
  return {
    idleSince: progress
      ? null
      : attemptChanged
        ? sampledAt
        : (previous?.idleSince ?? sampledAt),
    progress
  };
}

// Each Watchdog verdict cancels under its own name, so the three bounds stay
// distinguishable on the in-flight registry entry while the subject is still
// live. A Routine Firing can only ever reach `no_progress`, whose mapping is
// `CANCEL_REASONS.NO_PROGRESS`, so this one table serves both subjects.
const WATCHDOG_CANCEL_REASONS: Readonly<
  Record<WatchdogTerminalReason, CancelReason>
> = {
  no_convergence: CANCEL_REASONS.NO_CONVERGENCE,
  no_progress: CANCEL_REASONS.NO_PROGRESS,
  run_timeout: CANCEL_REASONS.RUN_TIMEOUT
};

// The reconcile sequence both Watchdog subjects share, in one place. The order
// is load-bearing: the idle clock runs before the terminal decision (ADR 0054),
// and each guard mirrors the two loops it replaces — a missing sample, a lost
// upsert race, a live subject, and a lost mark race each `continue` without a
// cancel. Called once per subject; the caller sums the tallies and awaits the
// shared cancellation array.
export async function driveWatchdogSubject<Candidate>(
  port: WatchdogSubjectPort<Candidate>,
  ctx: WatchdogSubjectContext
): Promise<{ sampled: number; terminated: number }> {
  let sampled = 0;
  let terminated = 0;
  for (const subject of port.candidates()) {
    const config = ctx.resolveConfig(port.projectName(subject));
    const previous = port.loadPrevious(subject);
    const next = await port.sample(subject, {
      config,
      previous,
      sampledAt: ctx.sampledAt
    });
    if (next === undefined) {
      continue;
    }

    const { idleSince, progress } = watchdogIdleClock(
      previous,
      next,
      ctx.sampledAt
    );
    const persisted: WatchdogProgressSample = { ...next, idleSince };
    if (!port.persist(subject, persisted)) {
      continue;
    }
    sampled += 1;

    const terminalReason = port.terminalReason(subject, {
      config,
      idleSince,
      now: ctx.now,
      outputTokensTotal: persisted.outputTokensTotal,
      progress
    });
    if (terminalReason === undefined) {
      continue;
    }
    if (!port.markStale(subject, terminalReason, ctx.sampledAt)) {
      continue;
    }

    ctx.cancellations.push(
      ctx.requestCancel(
        port.id(subject),
        WATCHDOG_CANCEL_REASONS[terminalReason]
      )
    );
    terminated += 1;
    port.announce(subject, {
      config,
      now: ctx.now,
      outputTokensTotal: persisted.outputTokensTotal,
      terminalReason
    });
  }
  return { sampled, terminated };
}
