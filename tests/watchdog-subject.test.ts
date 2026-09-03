import { describe, expect, it, type Mock, vi } from "vitest";

import { CANCEL_REASONS } from "../src/lifecycle/active-runs.js";
import {
  driveWatchdogSubject,
  type WatchdogSubjectContext,
  type WatchdogSubjectPort
} from "../src/lifecycle/watchdog-subject.js";
import type { WatchdogConfig } from "../src/reload.js";
import type { CancelReason, WatchdogProgressSample } from "../src/run-store.js";

// The whole point of the seam: the shared reconcile sequence is exercised
// through a hand-rolled fake WatchdogSubject, with no RunStore, no database,
// and no workspace tree. The real run/firing adapters stay covered end-to-end
// by tests/watchdog.test.ts against a live store.

type FakeCandidate = { key: string };

const CONFIG: WatchdogConfig = {
  enabled: true,
  graceMinutes: 30,
  maxRunMinutes: 0,
  mtimeIgnore: [],
  mtimeInclude: [],
  outputTokenBudget: 0,
  sampleIntervalSeconds: 60
};

function progressSample(
  overrides: Partial<WatchdogProgressSample> = {}
): WatchdogProgressSample {
  return {
    idleSince: null,
    lastMessageAt: null,
    lastProgressAt: null,
    lastToolCallAt: null,
    normalizedLogOffset: 0,
    normalizedLogPath: "provider.normalized.jsonl",
    outputTokensTotal: 0,
    sampledAt: "2026-09-03T01:00:00.000Z",
    turnIdSetSize: 0,
    workspaceDigest: "",
    workspaceMtimeMax: 0,
    ...overrides
  };
}

type TestContext = WatchdogSubjectContext & {
  requestCancel: Mock<(id: string, reason: CancelReason) => Promise<void>>;
};

function makeContext(
  overrides: Partial<WatchdogSubjectContext> = {}
): TestContext {
  const requestCancel = vi
    .fn<(id: string, reason: CancelReason) => Promise<void>>()
    .mockResolvedValue(undefined);
  return {
    cancellations: [],
    now: new Date("2026-09-03T01:00:00.000Z"),
    requestCancel,
    resolveConfig: () => CONFIG,
    sampledAt: "2026-09-03T01:00:00.000Z",
    ...overrides
  } as TestContext;
}

function basePort(
  overrides: Partial<WatchdogSubjectPort<FakeCandidate>> = {}
): WatchdogSubjectPort<FakeCandidate> {
  return {
    announce: () => {},
    candidates: () => [{ key: "a" }],
    id: (candidate) => candidate.key,
    loadPrevious: () => undefined,
    markStale: () => true,
    persist: () => true,
    projectName: () => "proj",
    sample: () => Promise.resolve(progressSample()),
    terminalReason: () => "run_timeout",
    ...overrides
  };
}

describe("driveWatchdogSubject", () => {
  it("cancels, announces, and tallies a terminal candidate", async () => {
    const announced: { terminalReason: string }[] = [];
    const ctx = makeContext();
    const port = basePort({
      announce: (_candidate, outcome) => {
        announced.push({ terminalReason: outcome.terminalReason });
      }
    });

    const result = await driveWatchdogSubject(port, ctx);

    expect(result).toEqual({ sampled: 1, terminated: 1 });
    expect(ctx.requestCancel).toHaveBeenCalledWith(
      "a",
      CANCEL_REASONS.RUN_TIMEOUT
    );
    expect(ctx.cancellations).toHaveLength(1);
    expect(announced).toEqual([{ terminalReason: "run_timeout" }]);
  });

  it("skips a candidate whose sample is undefined", async () => {
    const persist = vi.fn(() => true);
    const ctx = makeContext();
    const port = basePort({
      persist,
      sample: () => Promise.resolve(undefined)
    });

    const result = await driveWatchdogSubject(port, ctx);

    expect(result).toEqual({ sampled: 0, terminated: 0 });
    expect(persist).not.toHaveBeenCalled();
    expect(ctx.requestCancel).not.toHaveBeenCalled();
  });

  it("does not tally or evaluate termination when the upsert loses its race", async () => {
    const terminalReason = vi.fn<
      WatchdogSubjectPort<FakeCandidate>["terminalReason"]
    >(() => "run_timeout");
    const port = basePort({ persist: () => false, terminalReason });

    const result = await driveWatchdogSubject(port, makeContext());

    expect(result).toEqual({ sampled: 0, terminated: 0 });
    expect(terminalReason).not.toHaveBeenCalled();
  });

  it("counts a sampled-but-live candidate without terminating it", async () => {
    const markStale = vi.fn(() => true);
    const ctx = makeContext();
    const port = basePort({ markStale, terminalReason: () => undefined });

    const result = await driveWatchdogSubject(port, ctx);

    expect(result).toEqual({ sampled: 1, terminated: 0 });
    expect(markStale).not.toHaveBeenCalled();
    expect(ctx.requestCancel).not.toHaveBeenCalled();
  });

  it("does not cancel or announce when marking stale loses its race", async () => {
    const announce = vi.fn();
    const ctx = makeContext();
    const port = basePort({
      announce,
      markStale: () => false,
      terminalReason: () => "no_progress"
    });

    const result = await driveWatchdogSubject(port, ctx);

    expect(result).toEqual({ sampled: 1, terminated: 0 });
    expect(ctx.requestCancel).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  it("runs the idle clock before the terminal decision (ADR-0054)", async () => {
    const decisions: { idleSince: string | null; progress: boolean }[] = [];
    const previous = progressSample({
      idleSince: "2026-09-03T00:59:00.000Z",
      outputTokensTotal: 5
    });
    const port = basePort({
      loadPrevious: () => previous,
      sample: () => Promise.resolve(progressSample({ outputTokensTotal: 9 })),
      terminalReason: (_candidate, decision) => {
        decisions.push({
          idleSince: decision.idleSince,
          progress: decision.progress
        });
        return undefined;
      }
    });

    await driveWatchdogSubject(port, makeContext());

    // More output tokens than the previous sample is progress, so the clock
    // clears idleSince — and its output is what the terminal decision sees.
    expect(decisions).toEqual([{ idleSince: null, progress: true }]);
  });

  it("accumulates tallies and pushes each cancellation onto the shared array", async () => {
    const ctx = makeContext();
    const port = basePort({
      candidates: () => [{ key: "a" }, { key: "b" }],
      terminalReason: () => "no_progress"
    });

    const result = await driveWatchdogSubject(port, ctx);

    expect(result).toEqual({ sampled: 2, terminated: 2 });
    expect(ctx.cancellations).toHaveLength(2);
    expect(ctx.requestCancel.mock.calls.map((call) => call[0])).toEqual([
      "a",
      "b"
    ]);
  });
});
