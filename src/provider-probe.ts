import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentProvider,
  AgentProviderName,
  ProviderEvent
} from "./provider.js";

export type ProviderProbeResult = {
  detail: string;
  ok: boolean;
};

const DEFAULT_PROBE_PROMPT = "Say Hi";
const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

// Live functional check for an operator-authored provider command: spawns
// the real command (raw, as authored — runAttempt renders any {{tag}}
// placeholders itself with an empty routine context, matching an
// issue-driven Run) with a trivial prompt and waits for a reply. This is the
// opt-in complement to AgentProvider.validate(), which only checks static
// protocol shape (flags, --help output) and never spends a real turn. Not
// part of the default `doctor` run — it is a real billed call that can take
// tens of seconds, so callers gate it behind an explicit flag.
export async function probeProviderCommand(input: {
  command: string;
  prompt?: string;
  provider: AgentProvider;
  providerName: AgentProviderName;
  timeoutMs?: number;
}): Promise<ProviderProbeResult> {
  const workspacePath = await mkdtemp(path.join(tmpdir(), "symphonika-probe-"));
  const runId = "symphonika-doctor-probe";
  const timeoutMs = input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  try {
    const events = input.provider.runAttempt({
      branchName: "symphonika-doctor-probe",
      issue: {
        body: "",
        created_at: EPOCH,
        id: 0,
        labels: [],
        number: 0,
        priority: 0,
        state: "open",
        title: "symphonika doctor live check",
        updated_at: EPOCH,
        url: ""
      },
      prompt: input.prompt ?? DEFAULT_PROBE_PROMPT,
      promptPath: path.join(workspacePath, "prompt.txt"),
      provider: { command: input.command, name: input.providerName },
      run: { attempt: 1, id: runId },
      workspacePath
    });
    const iterator = events[Symbol.asyncIterator]();

    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        void input.provider.cancel(runId);
        return { detail: `no reply within ${timeoutMs}ms`, ok: false };
      }

      const step = await raceWithTimeout(iterator.next(), remainingMs);
      if (step === "timed-out") {
        // Best-effort: ask the provider to stop the run, but don't wait for
        // it — a hung/unresponsive provider must not hang the probe caller.
        void input.provider.cancel(runId);
        return { detail: `no reply within ${timeoutMs}ms`, ok: false };
      }
      if (step.done === true) {
        return {
          detail: "provider closed the event stream without completing a turn",
          ok: false
        };
      }

      const outcome = outcomeFromEvent(step.value);
      if (outcome !== undefined) {
        return outcome;
      }
    }
  } catch (error) {
    return {
      detail: error instanceof Error ? error.message : String(error),
      ok: false
    };
  } finally {
    await rm(workspacePath, { force: true, recursive: true });
  }
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | "timed-out"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const EPOCH = new Date(0).toISOString();

function outcomeFromEvent(
  event: ProviderEvent
): ProviderProbeResult | undefined {
  switch (event.normalized?.type) {
    case "turn_completed":
      return {
        detail: stringOrFallback(event.normalized.result, "(no reply text)"),
        ok: true
      };
    case "turn_failed":
      return {
        detail: stringOrFallback(event.normalized.message, "turn failed"),
        ok: false
      };
    case "input_required":
      return { detail: "provider requested input", ok: false };
    case "process_exit":
      return {
        detail: "provider process exited before completing a turn",
        ok: false
      };
    default:
      return undefined;
  }
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : fallback;
}
