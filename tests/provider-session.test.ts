import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ProcessCommand,
  ProcessScope,
  ProviderRunIdentity
} from "../src/lifecycle/process-scope.js";
import type { ProviderEvent, ProviderRunInput } from "../src/provider.js";
import {
  createProviderSession,
  jsonlProviderSession,
  type ProviderRunState,
  type ProviderTurn
} from "../src/providers/provider-session.js";

// The exact synthetic event every adapter used to yield when a cancel won the
// pre-spawn race — codex/claude inline, omp via processExitEvent(run,null,null)
// with cancelled === true. The harness folds all three into one value; this
// literal pins that the fold is byte-identical (keys and order included).
const CANCELLED_BEFORE_SPAWN_EXIT: ProviderEvent = {
  normalized: {
    cancelled: true,
    exitCode: null,
    signal: null,
    type: "process_exit"
  },
  raw: {
    cancelled: true,
    exitCode: null,
    kind: "process_exit",
    signal: null
  }
};

type TestRun = ProviderRunState & { marker?: string };
type TestQueue = { marker: "queue" };

type RecordingProcessScope = ProcessScope & {
  stopCalls: ProviderRunIdentity[];
  wrapCalls: ProviderRunIdentity[];
};

// Mirrors tests/codex-provider.test.ts's noopProcessScope: a recording,
// non-wrapping stand-in for the one injected seam so nothing spawns inside a
// real systemd scope.
function recordingProcessScope(
  wrap?: (
    run: ProviderRunIdentity,
    command: ProcessCommand
  ) => Promise<ProcessCommand>
): RecordingProcessScope {
  const wrapCalls: ProviderRunIdentity[] = [];
  const stopCalls: ProviderRunIdentity[] = [];
  return {
    stopCalls,
    stopProviderScope: (run) => {
      stopCalls.push(run);
      return Promise.resolve(true);
    },
    wrapCalls,
    wrapForProviderScope: async (run, command) => {
      wrapCalls.push(run);
      if (wrap !== undefined) {
        return { ...(await wrap(run, command)), providerScopeWrapped: true };
      }
      return { ...command, providerScopeWrapped: true };
    }
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-session-test-"));
  tempRoots.push(root);
  return root;
}

async function collect(
  events: AsyncIterable<ProviderEvent>
): Promise<ProviderEvent[]> {
  const collected: ProviderEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 4000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function inputFixture(
  overrides: Partial<ProviderRunInput> = {}
): ProviderRunInput {
  return {
    branchName: "sym/symphonika/1-provider-session",
    issue: {
      body: "Issue body",
      created_at: "2026-09-04T10:00:00Z",
      id: 4242,
      labels: ["agent-ready"],
      number: 1,
      priority: 50,
      state: "open",
      title: "Provider session harness",
      updated_at: "2026-09-04T11:00:00Z",
      url: "https://github.com/pmatos/symphonika/issues/1"
    },
    prompt: "Do the thing.",
    promptPath: "/tmp/prompt.md",
    provider: { command: "true", name: "codex" },
    run: { attempt: 1, id: "run-issue-1" },
    workspacePath: "/tmp/workspace",
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("provider session harness", () => {
  it("passes the provider name through (jsonl convenience)", () => {
    const session = jsonlProviderSession<TestRun>({
      createRunState: () => ({ cancelled: false }),
      label: "Codex",
      name: "codex",
      processScope: recordingProcessScope(),
      runTurn: async function* () {
        await Promise.resolve();
        yield* [];
      }
    });
    expect(session.name).toBe("codex");
  });

  it("emits the byte-identical synthetic exit and never spawns when a cancel wins the pre-spawn race", async () => {
    const gate = deferred<void>();
    let createQueueCalls = 0;
    let runTurnCalls = 0;
    let createRunStateCalls = 0;

    const session = createProviderSession<TestRun, TestQueue>({
      createQueue: () => {
        createQueueCalls += 1;
        return { marker: "queue" };
      },
      createRunState: () => {
        createRunStateCalls += 1;
        return { cancelled: false };
      },
      label: "Codex",
      name: "codex",
      processScope: recordingProcessScope(async () => {
        await gate.promise;
        return { args: [], executable: "true" };
      }),
      runTurn: async function* () {
        runTurnCalls += 1;
        await Promise.resolve();
        yield* [];
      }
    });

    const iterator = session.runAttempt(inputFixture())[Symbol.asyncIterator]();
    // Starts the prologue; suspends at the wrapForProviderScope await, after the
    // run is registered in the shared map (ADR 0052 pre-spawn window).
    const first = iterator.next();
    await session.cancel("run-issue-1");
    gate.resolve();

    const yielded = await first;
    expect(yielded.done).toBe(false);
    expect(yielded.value).toEqual(CANCELLED_BEFORE_SPAWN_EXIT);
    expect((await iterator.next()).done).toBe(true);

    expect(createRunStateCalls).toBe(1);
    expect(createQueueCalls).toBe(0);
    expect(runTurnCalls).toBe(0);
    // The map entry was removed on the early-return path: a second cancel is a
    // no-op that resolves.
    await expect(session.cancel("run-issue-1")).resolves.toBeUndefined();
  });

  it("runs the prologue, hands runTurn a spawned child + queue, and confirms scope cleanup in the finally", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const scriptPath = path.join(root, "exit.mjs");
    await writeFile(scriptPath, "process.exit(0)\n");

    const scope = recordingProcessScope();
    const pendingCalls: boolean[] = [];
    const canned: ProviderEvent = {
      normalized: { type: "turn_completed" },
      raw: { ok: true }
    };
    let captured: ProviderTurn<TestRun, TestQueue> | undefined;

    const session = createProviderSession<TestRun, TestQueue>({
      createQueue: () => ({ marker: "queue" }),
      createRunState: () => ({ cancelled: false }),
      label: "Codex",
      name: "codex",
      processScope: scope,
      runTurn: async function* (turn) {
        captured = turn;
        await Promise.resolve();
        yield canned;
      }
    });

    const events = await collect(
      session.runAttempt(
        inputFixture({
          provider: {
            command: `${process.execPath} ${scriptPath}`,
            name: "codex"
          },
          recordProviderScopeCleanupPending: (pending) =>
            pendingCalls.push(pending),
          workspacePath
        })
      )
    );

    expect(events).toEqual([canned]);
    expect(captured?.child).toBeDefined();
    expect(captured?.run.child).toBe(captured?.child);
    expect(captured?.queue).toEqual({ marker: "queue" });
    // markProviderScopeCleanupPending(true) in the prologue, then
    // confirmProviderScopeCleanup(false) in the finally after stopProviderScope.
    expect(pendingCalls).toEqual([true, false]);
    expect(scope.stopCalls.map((run) => run.id)).toContain("run-issue-1");
  });

  it("runs shutdownChildOnFinish before confirming scope cleanup, without breaking the finally", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const scriptPath = path.join(root, "exit.mjs");
    await writeFile(scriptPath, "process.exit(0)\n");

    const scope = recordingProcessScope();
    const pendingCalls: boolean[] = [];
    const session = createProviderSession<TestRun, TestQueue>({
      createQueue: () => ({ marker: "queue" }),
      createRunState: () => ({ cancelled: false }),
      label: "Codex",
      name: "codex",
      processScope: scope,
      runTurn: async function* () {
        await Promise.resolve();
        yield* [];
      },
      shutdownChildOnFinish: true
    });

    await collect(
      session.runAttempt(
        inputFixture({
          provider: {
            command: `${process.execPath} ${scriptPath}`,
            name: "codex"
          },
          recordProviderScopeCleanupPending: (pending) =>
            pendingCalls.push(pending),
          workspacePath
        })
      )
    );

    // With the flag set, the finally still reaches confirmProviderScopeCleanup:
    // the optional shutdown runs first (see omp) and does not short-circuit it.
    expect(pendingCalls).toEqual([true, false]);
    expect(scope.stopCalls.map((run) => run.id)).toContain("run-issue-1");
  });

  it("dispatches cancelInterrupt with the flagged run when a cancel arrives after spawn", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const scriptPath = path.join(root, "exit.mjs");
    await writeFile(scriptPath, "process.exit(0)\n");

    const release = deferred<void>();
    let interruptedRun: (TestRun & { child: unknown }) | undefined;
    let captured: ProviderTurn<TestRun, TestQueue> | undefined;

    const session = createProviderSession<TestRun, TestQueue>({
      cancelInterrupt: (run) => {
        interruptedRun = run;
        return undefined;
      },
      createQueue: () => ({ marker: "queue" }),
      createRunState: () => ({ cancelled: false }),
      label: "Codex",
      name: "codex",
      processScope: recordingProcessScope(),
      runTurn: async function* (turn) {
        captured = turn;
        await release.promise;
        yield* [];
      }
    });

    const drained = collect(
      session.runAttempt(
        inputFixture({
          provider: {
            command: `${process.execPath} ${scriptPath}`,
            name: "codex"
          },
          workspacePath
        })
      )
    );

    await waitFor(() => captured !== undefined);
    // cancelInterrupt is dispatched synchronously inside cancel(), before the
    // shutdown promise it returns is awaited, so the wiring is observable
    // without depending on OS-level process-group reaping.
    const cancelled = session.cancel("run-issue-1");
    expect(interruptedRun?.cancelled).toBe(true);
    expect(interruptedRun?.child).toBeDefined();

    release.resolve();
    await cancelled;
    await drained;
  });
});
