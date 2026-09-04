import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  confirmProviderScopeCleanup,
  markProviderScopeCleanupPending,
  type ProcessCommand,
  type ProcessScope
} from "../lifecycle/process-scope.js";
import { providerScratchEnvironment } from "../lifecycle/provider-scratch.js";
import type {
  AgentProvider,
  AgentProviderName,
  ProviderEvent,
  ProviderRunInput
} from "../provider.js";
import { renderProviderCommandTemplate } from "../provider-command-template.js";
import { parseProviderCommand, type ProviderLabel } from "./command-parse.js";
import {
  createJsonlProcessQueue,
  type ProcessQueue as JsonlProcessQueue
} from "./jsonl-process-queue.js";
import {
  shutdownProviderProcess,
  spawnProviderProcess
} from "./provider-process.js";
import { attachProviderStderrLog } from "./provider-stderr.js";

// The two fields the harness itself reads and writes on every provider's
// run-state; each provider's own run-state type extends this with its protocol
// fields. The harness sets `child` after spawn and `cancelled` from cancel().
export type ProviderRunState = {
  cancelled: boolean;
  child?: ChildProcessWithoutNullStreams;
};

// The context a provider's protocol body receives. `run` is narrowed to carry a
// definite `child`: the body runs only after spawn, so it (and helpers like
// codex's readUntilResponse) never re-checks it — this is what lets codex drop
// its `SpawnedCodexRun` alias and its `as` cast.
export type ProviderTurn<RunState extends ProviderRunState, Queue> = {
  child: ChildProcessWithoutNullStreams;
  input: ProviderRunInput;
  queue: Queue;
  run: RunState & { child: ChildProcessWithoutNullStreams };
};

type ProviderSessionConfig<RunState extends ProviderRunState, Queue> = {
  // Cancel courtesy. May run a synchronous side effect immediately and return a
  // `beforeClose` that shutdownProviderProcess runs once the process group is
  // reserved. Omitted (claude) means a plain cancellation shutdown.
  cancelInterrupt?: (
    run: RunState & { child: ChildProcessWithoutNullStreams },
    child: ChildProcessWithoutNullStreams
  ) => (() => void) | undefined;
  // Build the stdout reader. Receives `run` so an adapter can stash the queue on
  // its own run-state for cancel() to reach.
  createQueue: (
    child: ChildProcessWithoutNullStreams,
    input: ProviderRunInput,
    run: RunState
  ) => Queue;
  // Fresh protocol run-state per attempt, registered in the shared map before
  // the scope-probe await so a cancel landing during it has somewhere to go.
  createRunState: () => RunState;
  // Extra environment merged over the scratch environment (claude's routine
  // background-task guard). Omitted means the scratch environment alone.
  extraEnv?: (input: ProviderRunInput) => NodeJS.ProcessEnv;
  label: ProviderLabel;
  name: AgentProviderName;
  processScope: ProcessScope;
  // Rewrite the parsed command before it is scope-wrapped (claude's output
  // schema + routine argv). Omitted means the parsed command unchanged.
  refineCommand?: (
    command: ProcessCommand,
    input: ProviderRunInput
  ) => ProcessCommand;
  // The provider-specific protocol: handshake, drive the turn, read+yield the
  // event stream. Run inside the try whose finally owns scope cleanup.
  runTurn: (
    turn: ProviderTurn<RunState, Queue>
  ) => AsyncGenerator<ProviderEvent>;
  // omp only: a benign second shutdown at the top of the finally (ADR 0064).
  // Omitted (false) for codex/claude.
  shutdownChildOnFinish?: boolean;
};

type ProviderSession = Pick<AgentProvider, "cancel" | "name" | "runAttempt">;

// Yielded when a cancel wins the pre-spawn race. Value-identical to what all
// three adapters emitted before the harness (the branch only runs when
// cancelled === true); a fresh object per call preserves the current per-yield
// allocation.
function cancelledBeforeSpawnExit(): ProviderEvent {
  return {
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
}

export function createProviderSession<RunState extends ProviderRunState, Queue>(
  config: ProviderSessionConfig<RunState, Queue>
): ProviderSession {
  const { processScope } = config;
  const activeRuns = new Map<string, RunState>();

  return {
    cancel: (runId) => {
      const run = activeRuns.get(runId);
      if (run === undefined) {
        return Promise.resolve();
      }

      run.cancelled = true;
      const child = run.child;
      if (child === undefined) {
        // Cancelled before the scope probe/spawn finished — runAttempt's own
        // post-probe recheck (see below) is what stops it from launching.
        return Promise.resolve();
      }

      const spawnedRun = run as RunState & {
        child: ChildProcessWithoutNullStreams;
      };
      const beforeClose = config.cancelInterrupt?.(spawnedRun, child);
      return shutdownProviderProcess(child, beforeClose, "cancellation");
    },
    name: config.name,
    runAttempt: async function* (
      input: ProviderRunInput
    ): AsyncGenerator<ProviderEvent> {
      // Registered before the scope-probe await below so a cancel arriving
      // during that await (up to probeTimeoutMs on the first, uncached call)
      // has somewhere to land instead of being a silent no-op — cancel() finds
      // this entry, sets cancelled, and the recheck right after the await stops
      // the spawn from ever happening. RunController only rechecks its own
      // cancellation latch once, before runAttempt is called (see ADR 0052 at
      // run-controller.ts), and this await reopens that exact race one level
      // deeper.
      const run = config.createRunState();
      activeRuns.set(input.run.id, run);

      const rendered = renderProviderCommandTemplate(
        input.provider.command,
        input.routine ?? {}
      ).rendered;
      const parsed = parseProviderCommand(rendered, config.label);
      const command = await processScope.wrapForProviderScope(
        input.run,
        config.refineCommand === undefined
          ? parsed
          : config.refineCommand(parsed, input)
      );
      if (run.cancelled) {
        // Outside the try/finally below (which owns the only other
        // activeRuns.delete call) -- without this, this entry would leak in the
        // map for the lifetime of the provider instance.
        activeRuns.delete(input.run.id);
        yield cancelledBeforeSpawnExit();
        return;
      }

      const providerScopeWrapped = markProviderScopeCleanupPending(
        command,
        input.recordProviderScopeCleanupPending
      );
      const child = spawnProviderProcess(command, input.workspacePath, {
        ...providerScratchEnvironment(
          input.scratchPath,
          input.globalMaxInFlight
        ),
        ...(config.extraEnv?.(input) ?? {})
      });
      run.child = child;
      const stderrCapture = attachProviderStderrLog(
        child,
        input.stderrLogPath,
        input.stderrRedactSecrets === undefined
          ? {}
          : { redactSecrets: input.stderrRedactSecrets }
      );
      const queue = config.createQueue(child, input, run);

      try {
        yield* config.runTurn({
          child,
          input,
          queue,
          run: run as RunState & { child: ChildProcessWithoutNullStreams }
        });
      } finally {
        activeRuns.delete(input.run.id);
        if (config.shutdownChildOnFinish === true) {
          // Runs unconditionally, not only on cancellation: an ordinary
          // successful completion returns without terminating the child, and a
          // provider-spawned build tool can outlive it as a detached
          // grandchild; stopping it here is what reaps it (see docs/adr/0064).
          await shutdownProviderProcess(child);
        }
        await confirmProviderScopeCleanup(
          processScope,
          input.run,
          providerScopeWrapped,
          input.recordProviderScopeCleanupPending
        );
        // Last, so scope teardown is never delayed by it: the caller reads the
        // stderr log to explain an unclean exit as soon as this generator
        // returns, and only this await orders that read after the tee's write
        // (bounded, so a wedged sink cannot strand the attempt).
        await stderrCapture.waitForFlush();
      }
    }
  };
}

// The common case: codex and claude both read a JSONL stream, so they never
// name a queue — the harness fixes it to createJsonlProcessQueue for them.
export function jsonlProviderSession<RunState extends ProviderRunState>(
  config: Omit<
    ProviderSessionConfig<RunState, JsonlProcessQueue>,
    "createQueue"
  >
): ProviderSession {
  return createProviderSession<RunState, JsonlProcessQueue>({
    ...config,
    createQueue: (child) => createJsonlProcessQueue(child)
  });
}
