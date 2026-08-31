import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createProcessScope,
  type ProcessScope
} from "../lifecycle/process-scope.js";
import { providerScratchEnvironment } from "../lifecycle/provider-scratch.js";
import type {
  AgentProvider,
  ProviderEvent,
  ProviderRunInput
} from "../provider.js";
import { renderProviderCommandTemplate } from "../provider-command-template.js";
import { VERSION } from "../version.js";
import { parseProviderCommand, type ProviderLabel } from "./command-parse.js";
import {
  createCodexEventReducer,
  isTerminalFailure,
  jsonRpcErrorEvent,
  type CodexEventReducer
} from "./codex-events.js";
import {
  numberField,
  objectField,
  responseId,
  stringField,
  type JsonObject
} from "./codex-json.js";
import {
  createJsonlProcessQueue,
  mapProcessQueueControlEvent,
  type ProcessQueue,
  type ProcessQueueItem
} from "./jsonl-process-queue.js";
import {
  shutdownProviderProcess,
  spawnProviderProcess
} from "./provider-process.js";
import { attachProviderStderrLog } from "./provider-stderr.js";

const PROVIDER_LABEL: ProviderLabel = "Codex";

type ActiveCodexRun = {
  cancelled: boolean;
  child?: ChildProcessWithoutNullStreams;
  nextRequestId: number;
  reducer: CodexEventReducer;
  threadId?: string;
  turnId?: string;
};

type SpawnedCodexRun = ActiveCodexRun & {
  child: ChildProcessWithoutNullStreams;
};

type ResponseReadResult = {
  events: ProviderEvent[];
  stopped: boolean;
};

export type CodexProviderOptions = {
  // Injectable so tests can drive the progress-marker rate limit
  // deterministically instead of sleeping.
  now?: () => number;
  processScope?: ProcessScope;
};

export function createCodexProvider(
  options: CodexProviderOptions = {}
): AgentProvider {
  const processScope = options.processScope ?? createProcessScope();
  const now = options.now ?? (() => Date.now());
  const activeRuns = new Map<string, ActiveCodexRun>();

  return {
    cancel: (runId) => {
      const activeRun = activeRuns.get(runId);
      if (activeRun === undefined) {
        return Promise.resolve();
      }

      activeRun.cancelled = true;
      if (activeRun.child === undefined) {
        // Cancelled before the scope probe/spawn finished — runAttempt's own
        // post-probe recheck (see below) is what stops it from launching.
        return Promise.resolve();
      }
      const child = activeRun.child;
      return shutdownProviderProcess(
        child,
        () => {
          if (
            activeRun.threadId !== undefined &&
            activeRun.turnId !== undefined
          ) {
            writeJson(child, {
              id: activeRun.nextRequestId,
              method: "turn/interrupt",
              params: {
                threadId: activeRun.threadId,
                turnId: activeRun.turnId
              }
            });
            activeRun.nextRequestId += 1;
          }
        },
        "cancellation"
      );
    },
    name: "codex",
    runAttempt: async function* (
      input: ProviderRunInput
    ): AsyncGenerator<ProviderEvent> {
      // Registered before the scope-probe await below so a cancel arriving
      // during that await (up to probeTimeoutMs on the first, uncached
      // call) has somewhere to land instead of being a silent no-op —
      // cancel() finds this entry, sets cancelled, and the recheck right
      // after the await stops the spawn from ever happening. Without this
      // placeholder, a cancel here would be permanently lost: RunController
      // only rechecks its own cancellation latch once, before runAttempt is
      // called (see ADR 0052 at run-controller.ts:2274-2281), and this
      // await reopens that exact race one level deeper.
      const activeRun: ActiveCodexRun = {
        cancelled: false,
        nextRequestId: 4,
        reducer: createCodexEventReducer({
          now,
          session: () => ({
            threadId: activeRun.threadId,
            turnId: activeRun.turnId
          })
        })
      };
      activeRuns.set(input.run.id, activeRun);

      const renderedCommand = renderProviderCommandTemplate(
        input.provider.command,
        input.routine ?? {}
      ).rendered;
      const command = await processScope.wrapForProviderScope(
        input.run,
        parseProviderCommand(renderedCommand, PROVIDER_LABEL)
      );
      if (activeRun.cancelled) {
        // Outside the try/finally below (which owns the only other
        // activeRuns.delete call) -- without this, this placeholder would
        // leak in the map for the lifetime of the provider instance.
        activeRuns.delete(input.run.id);
        yield {
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
        return;
      }
      const child = spawnProviderProcess(
        command,
        input.workspacePath,
        providerScratchEnvironment(input.scratchPath)
      );
      activeRun.child = child;
      const spawnedRun: SpawnedCodexRun = activeRun as SpawnedCodexRun;
      const stderrCapture = attachProviderStderrLog(
        child,
        input.stderrLogPath,
        input.stderrRedactSecrets === undefined
          ? {}
          : { redactSecrets: input.stderrRedactSecrets }
      );
      const queue = createJsonlProcessQueue(child);

      try {
        writeJson(child, {
          id: 1,
          method: "initialize",
          params: {
            capabilities: {
              experimentalApi: true
            },
            clientInfo: {
              name: "symphonika",
              title: "Symphonika",
              version: VERSION
            }
          }
        });
        const initialized = await readUntilResponse(
          queue,
          1,
          spawnedRun,
          (raw) => ({
            raw
          })
        );
        yield* initialized.events;
        if (initialized.stopped) {
          return;
        }

        writeJson(child, {
          method: "initialized"
        });
        writeJson(child, {
          id: 2,
          method: "thread/start",
          params: codexThreadStartParams(input.workspacePath)
        });
        const threadStarted = await readUntilResponse(
          queue,
          2,
          spawnedRun,
          (raw) => {
            const result = objectField(raw, "result");
            const thread = objectField(result, "thread");
            const threadId = stringField(thread, "id");
            if (threadId !== undefined) {
              activeRun.threadId = threadId;
            }

            if (threadId === undefined) {
              return {
                raw
              };
            }

            return {
              normalized: {
                cwd: stringField(result, "cwd") ?? input.workspacePath,
                sessionId: threadId,
                threadId,
                type: "session_started"
              },
              raw
            };
          }
        );
        yield* threadStarted.events;
        if (threadStarted.stopped) {
          return;
        }

        const threadId = activeRun.threadId;
        if (threadId === undefined) {
          yield protocolFailure(
            "thread/start response did not include thread.id"
          );
          await shutdownProviderProcess(child);
          yield* await drainUntilExit(queue, activeRun);
          return;
        }

        writeJson(child, {
          id: 3,
          method: "turn/start",
          params: {
            input: [
              {
                text: input.prompt,
                text_elements: [],
                type: "text"
              }
            ],
            threadId
          }
        });
        const turnStarted = await readUntilResponse(
          queue,
          3,
          spawnedRun,
          (raw) => {
            const result = objectField(raw, "result");
            const turn = objectField(result, "turn");
            const turnId = stringField(turn, "id");
            if (turnId !== undefined) {
              activeRun.turnId = turnId;
            }

            return {
              raw
            };
          }
        );
        yield* turnStarted.events;
        if (turnStarted.stopped) {
          return;
        }

        while (true) {
          const event = providerEventFromQueueItem(
            await queue.next(),
            activeRun
          );
          yield event;
          const type = event.normalized?.type;

          if (type === "process_exit") {
            return;
          }

          if (
            type === "input_required" ||
            type === "malformed_event" ||
            type === "turn_completed" ||
            type === "turn_failed"
          ) {
            await shutdownProviderProcess(child);
          }
        }
      } finally {
        activeRuns.delete(input.run.id);
        // Runs unconditionally, not only on cancellation: the `process_exit`
        // branch above returns directly on ordinary successful completion,
        // bypassing terminateProcess entirely. A provider-spawned build tool
        // (cargo, rustc, ...) can outlive that exit as a detached
        // grandchild; stopping the run's scope here is what actually reaps
        // it (see docs/adr/0064).
        await processScope.stopProviderScope(input.run);
        // Last, so scope teardown is never delayed by it: the caller reads
        // the stderr log to explain an unclean exit as soon as this generator
        // returns, and only this await orders that read after the tee's write
        // (bounded, so a wedged sink cannot strand the attempt).
        await stderrCapture.waitForFlush();
      }
    },
    validate: async (command, values = {}) => {
      const rendered = renderProviderCommandTemplate(command, values).rendered;
      const parsed = parseProviderCommand(rendered, PROVIDER_LABEL);
      if (!parsed.args.includes("app-server")) {
        throw new Error(
          "Codex provider command must include the app-server subcommand"
        );
      }

      await validateCodexAppServerCommand(parsed);
    }
  };
}

async function readUntilResponse(
  queue: ProcessQueue,
  requestId: number,
  activeRun: SpawnedCodexRun,
  mapResponse: (raw: unknown) => ProviderEvent
): Promise<ResponseReadResult> {
  const events: ProviderEvent[] = [];

  while (true) {
    const item = await queue.next();
    if (item.kind === "message" && responseId(item.raw) === requestId) {
      if (objectField(item.raw, "error") !== undefined) {
        events.push(jsonRpcErrorEvent(item.raw));
        await shutdownProviderProcess(activeRun.child);
        events.push(...(await drainUntilExit(queue, activeRun)));
        return {
          events,
          stopped: true
        };
      }

      events.push(mapResponse(item.raw));
      return {
        events,
        stopped: false
      };
    }

    const event = providerEventFromQueueItem(item, activeRun);
    events.push(event);
    if (event.normalized?.type === "process_exit") {
      return {
        events,
        stopped: true
      };
    }
    if (isTerminalFailure(event.normalized?.type)) {
      await shutdownProviderProcess(activeRun.child);
      events.push(...(await drainUntilExit(queue, activeRun)));
      return {
        events,
        stopped: true
      };
    }
  }
}

async function drainUntilExit(
  queue: ProcessQueue,
  activeRun: ActiveCodexRun
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];

  while (true) {
    const event = providerEventFromQueueItem(await queue.next(), activeRun);
    events.push(event);
    if (event.normalized?.type === "process_exit") {
      return events;
    }
  }
}

function providerEventFromQueueItem(
  item: ProcessQueueItem,
  activeRun: ActiveCodexRun
): ProviderEvent {
  if (item.kind === "message") {
    return activeRun.reducer.reduce(item.raw);
  }

  return mapProcessQueueControlEvent(item, activeRun.cancelled);
}

function protocolFailure(message: string): ProviderEvent {
  return {
    normalized: {
      message,
      type: "malformed_event"
    },
    raw: {
      kind: "protocol_error",
      message
    }
  };
}

function writeJson(
  child: ChildProcessWithoutNullStreams,
  value: JsonObject
): void {
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

function terminateProcess(child: ChildProcess): void {
  if (child.killed || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
}

function shutdownProbeProcess(child: ChildProcessWithoutNullStreams): void {
  if (!child.stdin.destroyed && child.stdin.writable) {
    child.stdin.end();
  }

  const timer = setTimeout(() => {
    terminateProcess(child);
  }, 250);
  timer.unref();
}

async function validateCodexAppServerCommand(command: {
  args: string[];
  executable: string;
}): Promise<void> {
  const help = await runCodexProbe(command.executable, [
    ...command.args,
    "--help"
  ]);
  if (help.kind === "spawn_error") {
    throw new Error(
      `Codex provider command executable not available: ${command.executable}: ${help.message}`
    );
  }
  if (help.kind === "timeout") {
    throw new Error("Codex provider command validation timed out");
  }
  if (help.exitCode !== 0) {
    throw new Error(
      `Codex provider command validation failed with exit code ${help.exitCode ?? "unknown"}: ${help.output.trim() || "no output"}`
    );
  }
  if (!/app-server/.test(help.output)) {
    throw new Error(
      "Codex provider command help output does not look like app-server"
    );
  }

  const profile = extractProfileName(command.args);
  if (profile !== undefined) {
    await validateCodexProfile(command, profile);
  }

  await validateCodexAppServerRuntime(command);
}

async function validateCodexProfile(
  command: { args: string[]; executable: string },
  profile: string
): Promise<void> {
  const appServerIndex = command.args.indexOf("app-server");
  const baseArgs =
    appServerIndex >= 0
      ? command.args.slice(0, appServerIndex)
      : command.args.slice();
  const probe = await runCodexProbe(command.executable, [
    ...baseArgs,
    "features",
    "list"
  ]);
  if (probe.kind === "spawn_error") {
    throw new Error(
      `Codex profile probe for '${profile}' could not spawn ${command.executable}: ${probe.message}`
    );
  }
  if (probe.kind === "timeout") {
    throw new Error(
      `Codex profile probe for '${profile}' timed out; cannot verify profile exists`
    );
  }
  if (probe.exitCode !== 0) {
    const stderr = probe.output.trim();
    if (/config profile/i.test(stderr) && /not found/i.test(stderr)) {
      throw new Error(missingProfileMessage(profile, stderr));
    }
    throw new Error(
      `Codex profile probe for '${profile}' failed with exit code ${probe.exitCode ?? "unknown"}: ${stderr || "no output"}`
    );
  }
}

async function validateCodexAppServerRuntime(command: {
  args: string[];
  executable: string;
}): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), "symphonika-codex-probe-"));
  const child = spawn(command.executable, command.args, {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const queue = createJsonlProcessQueue(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    writeJson(child, {
      id: 1,
      method: "initialize",
      params: {
        capabilities: {
          experimentalApi: true
        },
        clientInfo: {
          name: "symphonika-doctor",
          title: "Symphonika Doctor",
          version: VERSION
        }
      }
    });
    await readProbeResponse(queue, child, 1, "initialize", () => stderr);

    writeJson(child, {
      method: "initialized"
    });
    writeJson(child, {
      id: 2,
      method: "thread/start",
      params: codexThreadStartParams(cwd, { ephemeral: true })
    });
    const threadResponse = await readProbeResponse(
      queue,
      child,
      2,
      "thread/start",
      () => stderr
    );
    validateThreadStartProbeResponse(threadResponse);

    const runtimeProbeTimeoutMs = codexRuntimeProbeTimeoutMs();
    writeJson(child, {
      id: 3,
      method: "command/exec",
      params: {
        command: [
          "bash",
          "-lc",
          [
            "touch .symphonika-codex-write-probe || { echo SYMPHONIKA_PROBE_WRITE_FAILED >&2; exit 11; }",
            "git ls-remote https://github.com/openai/codex.git HEAD >/dev/null || { echo SYMPHONIKA_PROBE_GIT_NETWORK_FAILED >&2; exit 12; }",
            nodeGithubApiProbeCommand(),
            "echo SYMPHONIKA_PROBE_OK"
          ].join("; ")
        ],
        cwd,
        disableOutputCap: true,
        sandboxPolicy: {
          type: "dangerFullAccess"
        },
        timeoutMs: runtimeProbeTimeoutMs
      }
    });
    const commandResponse = await readProbeResponse(
      queue,
      child,
      3,
      "command/exec",
      () => stderr,
      runtimeProbeTimeoutMs + 5_000
    );
    validateCommandExecProbeResponse(commandResponse);
  } finally {
    shutdownProbeProcess(child);
    await rm(cwd, { force: true, recursive: true });
  }
}

async function readProbeResponse(
  queue: ProcessQueue,
  child: ChildProcessWithoutNullStreams,
  requestId: number,
  context: string,
  stderr: () => string,
  timeoutMs = codexProbeTimeoutMs()
): Promise<unknown> {
  while (true) {
    const item = await nextProbeItem(queue, child, context, timeoutMs);
    switch (item.kind) {
      case "error":
        throw new Error(
          `Codex app-server runtime probe failed during ${context}: ${item.error.message}`
        );
      case "exit":
        throw new Error(
          `Codex app-server runtime probe exited before ${context} response with exit code ${item.exitCode ?? "unknown"}${formatProbeStderr(stderr())}`
        );
      case "malformed":
        throw new Error(
          `Codex app-server runtime probe received malformed JSON during ${context}: ${item.message}`
        );
      case "message":
        if (responseId(item.raw) !== requestId) {
          continue;
        }
        if (objectField(item.raw, "error") !== undefined) {
          throw new Error(
            `Codex app-server runtime probe ${context} failed: ${JSON.stringify(objectField(item.raw, "error"))}`
          );
        }
        return item.raw;
    }
  }
}

async function nextProbeItem(
  queue: ProcessQueue,
  child: ChildProcess,
  context: string,
  timeoutMs: number
): Promise<ProcessQueueItem> {
  return await new Promise<ProcessQueueItem>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      terminateProcess(child);
      reject(
        new Error(
          `Codex app-server runtime probe timed out waiting for ${context} response`
        )
      );
    }, timeoutMs);
    timer.unref();

    queue.next().then(
      (item) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(item);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function validateThreadStartProbeResponse(raw: unknown): void {
  const result = objectField(raw, "result");
  const approvalPolicy = stringField(result, "approvalPolicy");
  const sandbox = objectField(result, "sandbox");
  const sandboxType = stringField(sandbox, "type");

  if (approvalPolicy !== "never") {
    throw new Error(
      `Codex app-server thread/start approvalPolicy is ${approvalPolicy ?? "missing"}; expected never`
    );
  }
  if (sandboxType !== "dangerFullAccess") {
    throw new Error(
      `Codex app-server thread/start sandbox is ${sandboxType ?? "missing"}; expected dangerFullAccess`
    );
  }
}

function validateCommandExecProbeResponse(raw: unknown): void {
  const result = objectField(raw, "result");
  const exitCode = numberField(result, "exitCode");
  if (exitCode === 0) {
    return;
  }

  const stdout = stringField(result, "stdout") ?? "";
  const stderr = stringField(result, "stderr") ?? "";
  const output = `${stdout}\n${stderr}`;
  if (exitCode === 11 || output.includes("SYMPHONIKA_PROBE_WRITE_FAILED")) {
    throw new Error("Codex app-server sandbox blocks in-cwd writes");
  }
  if (
    exitCode === 12 ||
    output.includes("SYMPHONIKA_PROBE_GIT_NETWORK_FAILED")
  ) {
    throw new Error(
      "Codex app-server sandbox blocks public git network access"
    );
  }
  if (
    exitCode === 13 ||
    output.includes("SYMPHONIKA_PROBE_GITHUB_API_FAILED")
  ) {
    throw new Error(
      "Codex app-server sandbox blocks api.github.com reachability"
    );
  }
  throw new Error(
    `Codex app-server command/exec sandbox probe failed with exit code ${exitCode ?? "unknown"}${formatProbeStderr(output)}`
  );
}

function formatProbeStderr(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length > 0 ? `: ${trimmed}` : "";
}

type CodexProbeResult =
  | { exitCode: number | null; kind: "exit"; output: string }
  | { kind: "spawn_error"; message: string }
  | { kind: "timeout" };

async function runCodexProbe(
  executable: string,
  args: string[]
): Promise<CodexProbeResult> {
  const timeoutMs = codexProbeTimeoutMs();
  return await new Promise<CodexProbeResult>((resolve) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      terminateProcess(child);
      resolve({ kind: "timeout" });
    }, timeoutMs);

    const settle = (result: CodexProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", (error) => {
      settle({ kind: "spawn_error", message: error.message });
    });
    child.once("close", (exitCode) => {
      settle({ exitCode, kind: "exit", output });
    });
  });
}

function codexThreadStartParams(
  cwd: string,
  options: { ephemeral?: boolean } = {}
): JsonObject {
  return {
    approvalPolicy: "never",
    cwd,
    ...(options.ephemeral === true ? { ephemeral: true } : {}),
    experimentalRawEvents: false,
    sandbox: "danger-full-access",
    persistExtendedHistory: options.ephemeral === true ? false : true
  };
}

function codexProbeTimeoutMs(): number {
  const envTimeout = Number(process.env.SYMPHONIKA_CODEX_PROBE_TIMEOUT_MS);
  return Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 5_000;
}

function codexRuntimeProbeTimeoutMs(): number {
  const envTimeout = Number(
    process.env.SYMPHONIKA_CODEX_RUNTIME_PROBE_TIMEOUT_MS
  );
  return Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 30_000;
}

function nodeGithubApiProbeCommand(): string {
  const script = [
    `const https = require("node:https");`,
    `const req = https.request("https://api.github.com", { method: "HEAD", headers: { "user-agent": "symphonika-codex-probe" } }, (res) => {`,
    `  res.resume();`,
    `  process.exit(res.statusCode !== undefined && res.statusCode < 500 ? 0 : 13);`,
    `});`,
    `req.setTimeout(15_000, () => req.destroy(new Error("timeout")));`,
    `req.on("error", () => process.exit(13));`,
    `req.end();`
  ].join(" ");
  return `${shellQuote(process.execPath)} -e ${shellQuote(script)} || { echo SYMPHONIKA_PROBE_GITHUB_API_FAILED >&2; exit 13; }`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// Exported so doctor's execution-environment report checks the profile the
// operator's command actually selects instead of assuming the default name.
export function extractProfileName(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "-p" || arg === "--profile") {
      return args[i + 1];
    }
    if (arg.startsWith("--profile=")) {
      return arg.slice("--profile=".length);
    }
  }
  return undefined;
}

function missingProfileMessage(profile: string, stderr: string): string {
  return [
    `Codex profile '${profile}' is not defined in ~/.codex/config.toml.`,
    `Codex reported: ${stderr}`,
    "",
    `Add this block to ~/.codex/config.toml (see README.md and docs/adr/0042-codex-profile-for-headless-runs.md):`,
    "",
    `  [profiles.${profile}]`,
    `  analytics = { enabled = false }`,
    `  sandbox_mode = "danger-full-access"`,
    `  approval_policy = "never"`,
    `  model_reasoning_summary = "detailed"`,
    `  model_verbosity = "medium"`,
    "",
    `  [profiles.${profile}.features]`,
    `  memories         = false`,
    `  multi_agent      = true`,
    `  codex_hooks      = false`,
    `  image_generation = false`
  ].join("\n");
}
