import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCodexProvider } from "../src/providers/codex.js";
import type { ProviderEvent, ProviderRunInput } from "../src/provider.js";
import type {
  ProcessCommand,
  ProviderRunIdentity
} from "../src/lifecycle/process-scope.js";

type RecordingProcessScope = {
  stopCalls: ProviderRunIdentity[];
  wrapCalls: Array<{ command: ProcessCommand; run: ProviderRunIdentity }>;
  stopProviderScope: (run: ProviderRunIdentity) => Promise<boolean>;
  wrapForProviderScope: (
    run: ProviderRunIdentity,
    command: ProcessCommand
  ) => Promise<ProcessCommand>;
};

// The default processScope probes real systemd-run availability, which is
// true on a dev box with a live systemd --user session (XDG_RUNTIME_DIR
// set) — every existing test here injects this no-op bypass so spawned
// fake-subprocess commands are never actually wrapped in a real transient
// systemd scope, regardless of the host running the suite.
function noopProcessScope(): RecordingProcessScope {
  const wrapCalls: RecordingProcessScope["wrapCalls"] = [];
  const stopCalls: RecordingProcessScope["stopCalls"] = [];
  return {
    stopCalls,
    stopProviderScope: (run) => {
      stopCalls.push(run);
      return Promise.resolve(true);
    },
    wrapCalls,
    wrapForProviderScope: (run, command) => {
      wrapCalls.push({ command, run });
      return Promise.resolve(command);
    }
  };
}

const tempRoots: string[] = [];
const DEFAULT_CODEX_COMMAND = `codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never --dangerously-bypass-approvals-and-sandbox app-server`;
const originalFakeCodexTranscript =
  process.env.SYMPHONIKA_FAKE_CODEX_TRANSCRIPT;
const originalProbeTimeout = process.env.SYMPHONIKA_CODEX_PROBE_TIMEOUT_MS;
const originalRuntimeProbeTimeout =
  process.env.SYMPHONIKA_CODEX_RUNTIME_PROBE_TIMEOUT_MS;

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-codex-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  if (originalFakeCodexTranscript === undefined) {
    delete process.env.SYMPHONIKA_FAKE_CODEX_TRANSCRIPT;
  } else {
    process.env.SYMPHONIKA_FAKE_CODEX_TRANSCRIPT = originalFakeCodexTranscript;
  }
  if (originalProbeTimeout === undefined) {
    delete process.env.SYMPHONIKA_CODEX_PROBE_TIMEOUT_MS;
  } else {
    process.env.SYMPHONIKA_CODEX_PROBE_TIMEOUT_MS = originalProbeTimeout;
  }
  if (originalRuntimeProbeTimeout === undefined) {
    delete process.env.SYMPHONIKA_CODEX_RUNTIME_PROBE_TIMEOUT_MS;
  } else {
    process.env.SYMPHONIKA_CODEX_RUNTIME_PROBE_TIMEOUT_MS =
      originalRuntimeProbeTimeout;
  }

  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("Codex JSON-RPC provider", () => {
  it("launches the configured app-server in the workspace and maps a completed turn", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeServerPath = path.join(root, "fake-codex-app-server.mjs");
    await writeFakeCodexAppServer(fakeServerPath, transcriptPath);
    const provider = createCodexProvider({ processScope: noopProcessScope() });

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeServerPath} app-server`,
          name: "codex"
        },
        workspacePath
      })
    );

    const requests = readJsonl(await readFile(transcriptPath, "utf8"));
    expect(requests.map((request) => objectField(request, "method"))).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start"
    ]);
    expect(requests[2]).toMatchObject({
      method: "thread/start",
      params: {
        approvalPolicy: "never",
        cwd: workspacePath,
        experimentalRawEvents: false,
        persistExtendedHistory: true,
        sandbox: "danger-full-access"
      }
    });
    expect(
      objectField(objectField(requests[2], "params"), "ephemeral")
    ).toBeUndefined();
    expect(
      objectField(objectField(requests[2], "params"), "permissionProfile")
    ).toBeUndefined();
    expect(requests[3]).toMatchObject({
      method: "turn/start",
      params: {
        input: [
          {
            text: "Implement issue #9.",
            text_elements: [],
            type: "text"
          }
        ],
        threadId: "thread-9"
      }
    });

    expect(events.map((event) => event.raw)).toEqual([
      {
        id: 1,
        result: {
          codexHome: "/tmp/fake-codex-home",
          platformFamily: "unix",
          platformOs: "linux",
          userAgent: "fake-codex-app-server"
        }
      },
      {
        id: 2,
        result: {
          cwd: workspacePath,
          thread: {
            id: "thread-9"
          }
        }
      },
      {
        id: 3,
        result: {
          turn: {
            id: "turn-9",
            status: "inProgress"
          }
        }
      },
      {
        method: "item/agentMessage/delta",
        params: {
          delta: "done",
          itemId: "item-1",
          threadId: "thread-9",
          turnId: "turn-9"
        }
      },
      {
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-9",
          tokenUsage: {
            inputTokens: 11,
            outputTokens: 7,
            totalTokens: 18
          },
          turnId: "turn-9"
        }
      },
      {
        method: "account/rateLimits/updated",
        params: {
          rateLimits: {
            primary: {
              remaining: 42,
              resetAt: 1777470000
            }
          }
        }
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-9",
          turn: {
            id: "turn-9",
            status: "completed"
          }
        }
      },
      {
        cancelled: false,
        exitCode: 0,
        kind: "process_exit",
        signal: null
      }
    ]);
    const normalizedEvents = events
      .map((event) => event.normalized)
      .filter(Boolean);
    expect(normalizedEvents).toMatchObject([
      {
        cwd: workspacePath,
        sessionId: "thread-9",
        threadId: "thread-9",
        type: "session_started"
      },
      {
        message: "done",
        threadId: "thread-9",
        turnId: "turn-9",
        type: "message"
      },
      {
        threadId: "thread-9",
        tokenUsage: {
          inputTokens: 11,
          outputTokens: 7,
          totalTokens: 18
        },
        turnId: "turn-9",
        type: "usage_updated"
      },
      {
        rateLimits: {
          primary: {
            remaining: 42,
            resetAt: 1777470000
          }
        },
        type: "rate_limit_updated"
      },
      {
        status: "completed",
        threadId: "thread-9",
        turnId: "turn-9",
        type: "turn_completed"
      },
      {
        cancelled: false,
        exitCode: 0,
        signal: null,
        type: "process_exit"
      }
    ]);
  });

  it("wraps the spawned command via the injected process scope and stops the scope when the run completes normally", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeServerPath = path.join(root, "fake-codex-app-server.mjs");
    await writeFakeCodexAppServer(fakeServerPath, transcriptPath);
    const processScope = noopProcessScope();
    const provider = createCodexProvider({ processScope });
    const command = `${process.execPath} ${fakeServerPath} app-server`;

    await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: { command, name: "codex" },
        workspacePath
      })
    );

    expect(processScope.wrapCalls).toEqual([
      {
        command: {
          args: [fakeServerPath, "app-server"],
          executable: process.execPath
        },
        run: { attempt: 1, id: "run-issue-9" }
      }
    ]);
    // The regression this guards: ordinary successful completion takes the
    // `process_exit` early-return path, which bypasses terminateProcess
    // entirely — stopProviderScope must still fire from the unconditional
    // cleanup path, not only on cancellation.
    expect(processScope.stopCalls).toEqual([{ attempt: 1, id: "run-issue-9" }]);
  });

  it("maps app-server input requests to input_required and stops the process", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeServerPath = path.join(root, "fake-codex-app-server.mjs");
    await writeFakeCodexAppServer(fakeServerPath, transcriptPath);
    const provider = createCodexProvider({ processScope: noopProcessScope() });

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeServerPath} --scenario=input-required app-server`,
          name: "codex"
        },
        workspacePath
      })
    );

    const normalizedEvents = events
      .map((event) => event.normalized)
      .filter(Boolean);
    expect(normalizedEvents).toMatchObject([
      {
        cwd: workspacePath,
        sessionId: "thread-9",
        threadId: "thread-9",
        type: "session_started"
      },
      {
        method: "item/tool/requestUserInput",
        params: {
          itemId: "item-input",
          questions: [
            {
              header: "Choice",
              id: "choice",
              options: [],
              question: "Need operator input?"
            }
          ],
          threadId: "thread-9",
          turnId: "turn-9"
        },
        requestId: "input-1",
        type: "input_required"
      },
      {
        cancelled: false,
        exitCode: 0,
        signal: null,
        type: "process_exit"
      }
    ]);
  });

  it("maps malformed app-server output to malformed_event and stops the process", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeServerPath = path.join(root, "fake-codex-app-server.mjs");
    await writeFakeCodexAppServer(fakeServerPath, transcriptPath);
    const provider = createCodexProvider({ processScope: noopProcessScope() });

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeServerPath} --scenario=malformed app-server`,
          name: "codex"
        },
        workspacePath
      })
    );

    const normalizedEvents = events
      .map((event) => event.normalized)
      .filter(Boolean);
    expect(normalizedEvents).toMatchObject([
      {
        cwd: workspacePath,
        sessionId: "thread-9",
        threadId: "thread-9",
        type: "session_started"
      },
      {
        line: "{bad json",
        type: "malformed_event"
      },
      {
        cancelled: false,
        exitCode: 0,
        signal: null,
        type: "process_exit"
      }
    ]);
    expect(String(objectField(normalizedEvents[1], "message"))).toContain(
      "JSON"
    );
  });

  it("maps app-server error notifications to turn_failed and stops the process", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeServerPath = path.join(root, "fake-codex-app-server.mjs");
    await writeFakeCodexAppServer(fakeServerPath, transcriptPath);
    const provider = createCodexProvider({ processScope: noopProcessScope() });

    const events = await collectProviderEvents(
      provider.runAttempt({
        ...providerInputFixture(),
        provider: {
          command: `${process.execPath} ${fakeServerPath} --scenario=error app-server`,
          name: "codex"
        },
        workspacePath
      })
    );

    expect(events.map((event) => event.normalized).filter(Boolean)).toEqual([
      {
        cwd: workspacePath,
        sessionId: "thread-9",
        threadId: "thread-9",
        type: "session_started"
      },
      {
        message: "model exploded politely",
        threadId: "thread-9",
        turnId: "turn-9",
        type: "turn_failed"
      },
      {
        cancelled: false,
        exitCode: 0,
        signal: null,
        type: "process_exit"
      }
    ]);
  });

  it("interrupts and stops the app-server process on cancellation", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeServerPath = path.join(root, "fake-codex-app-server.mjs");
    await writeFakeCodexAppServer(fakeServerPath, transcriptPath);
    const processScope = noopProcessScope();
    const provider = createCodexProvider({ processScope });
    const iterable = provider.runAttempt({
      ...providerInputFixture(),
      provider: {
        command: `${process.execPath} ${fakeServerPath} --scenario=wait app-server`,
        name: "codex"
      },
      workspacePath
    });
    const iterator = iterable[Symbol.asyncIterator]();

    const initialEvents = [
      await nextProviderEvent(iterator),
      await nextProviderEvent(iterator),
      await nextProviderEvent(iterator)
    ];
    await provider.cancel("run-issue-9");
    const remainingEvents = await collectIteratorEvents(iterator);
    const events = [...initialEvents, ...remainingEvents];

    const requests = readJsonl(await readFile(transcriptPath, "utf8"));
    expect(requests.map((request) => objectField(request, "method"))).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
      "turn/interrupt"
    ]);
    expect(events.map((event) => event.normalized).filter(Boolean)).toEqual([
      {
        cwd: workspacePath,
        sessionId: "thread-9",
        threadId: "thread-9",
        type: "session_started"
      },
      {
        cancelled: true,
        exitCode: 0,
        signal: null,
        type: "process_exit"
      }
    ]);
    expect(processScope.stopCalls).toEqual([{ attempt: 1, id: "run-issue-9" }]);
  });

  it.skipIf(process.platform === "win32")(
    "does not escalate after cancellation finds the process group already gone",
    async () => {
      const root = await makeTempRoot();
      const workspacePath = path.join(root, "workspace");
      await mkdir(workspacePath, { recursive: true });
      const transcriptPath = path.join(root, "requests.jsonl");
      const pidPath = path.join(root, "app-server.pid");
      const fakeServerPath = path.join(root, "fake-codex-app-server.mjs");
      await writeFakeCodexAppServer(fakeServerPath, transcriptPath, pidPath);
      const provider = createCodexProvider({
        processScope: noopProcessScope()
      });
      const iterator = provider
        .runAttempt({
          ...providerInputFixture(),
          provider: {
            command: `${process.execPath} ${fakeServerPath} --scenario=wait app-server`,
            name: "codex"
          },
          workspacePath
        })
        [Symbol.asyncIterator]();
      await nextProviderEvent(iterator);
      await nextProviderEvent(iterator);
      await nextProviderEvent(iterator);
      const pid = Number(await waitForFileContent(pidPath));
      const realKill = process.kill.bind(process);
      const signalSpy = vi
        .spyOn(process, "kill")
        .mockImplementation((targetPid, signal) => {
          if (targetPid === -pid) {
            throw Object.assign(new Error("no such process group"), {
              code: "ESRCH"
            });
          }
          return realKill(targetPid, signal);
        });

      try {
        await provider.cancel("run-issue-9");
        await collectIteratorEvents(iterator);
        await vi.waitFor(() => {
          expect(signalSpy).toHaveBeenCalledWith(expect.any(Number), "SIGTERM");
        });
        await new Promise((resolve) => setTimeout(resolve, 1_100));

        expect(
          signalSpy.mock.calls
            .filter(([targetPid]) => targetPid === -pid)
            .map(([, signal]) => signal)
        ).toEqual(["SIGTERM"]);
      } finally {
        signalSpy.mockRestore();
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "terminates app-server-spawned grandchildren on cancellation",
    async () => {
      const root = await makeTempRoot();
      const workspacePath = path.join(root, "workspace");
      await mkdir(workspacePath, { recursive: true });
      const grandchildPath = path.join(root, "grandchild.mjs");
      const grandchildPidPath = path.join(root, "grandchild.pid");
      const fakeServerPath = path.join(root, "fake-codex-process-tree.mjs");
      await writeFakeCodexProcessTree(
        fakeServerPath,
        grandchildPath,
        grandchildPidPath
      );
      const provider = createCodexProvider({
        processScope: noopProcessScope()
      });
      const iterator = provider
        .runAttempt({
          ...providerInputFixture(),
          provider: {
            command: `${process.execPath} ${fakeServerPath} app-server`,
            name: "codex"
          },
          workspacePath
        })
        [Symbol.asyncIterator]();
      let grandchildPid: number | undefined;

      try {
        const initialEvents = [
          await nextProviderEvent(iterator),
          await nextProviderEvent(iterator),
          await nextProviderEvent(iterator)
        ];
        grandchildPid = Number(await waitForFileContent(grandchildPidPath));

        await provider.cancel("run-issue-9");
        const events = [
          ...initialEvents,
          ...(await collectIteratorEvents(iterator))
        ];

        expect(events.at(-1)?.normalized).toMatchObject({
          cancelled: true,
          type: "process_exit"
        });
        await waitForProcessStopped(grandchildPid);
      } finally {
        if (
          grandchildPid !== undefined &&
          Number.isSafeInteger(grandchildPid)
        ) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch {
            // The provider already cleaned the process up.
          }
          await waitForProcessStopped(grandchildPid).catch(() => {
            // Best-effort cleanup after an assertion failure.
          });
        }
      }
    }
  );

  // Regression: wrapForProviderScope's await (up to probeTimeoutMs on an
  // uncached probe) sits between RunController's one-shot pre-start
  // cancellation recheck (ADR 0052) and the point where this provider used
  // to register a cancellable entry. A cancel arriving in that window must
  // not be silently swallowed -- it must stop the process from ever being
  // spawned.
  it("never spawns the app-server when cancelled while the scope probe is still pending", async () => {
    const root = await makeTempRoot();
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const transcriptPath = path.join(root, "requests.jsonl");
    const fakeServerPath = path.join(root, "fake-codex-app-server.mjs");
    await writeFakeCodexAppServer(fakeServerPath, transcriptPath);

    let resolveWrap: ((command: ProcessCommand) => void) | undefined;
    const wrapPending = new Promise<ProcessCommand>((resolve) => {
      resolveWrap = resolve;
    });
    const processScope = {
      stopCalls: [] as ProviderRunIdentity[],
      stopProviderScope: (run: ProviderRunIdentity) => {
        processScope.stopCalls.push(run);
        return Promise.resolve(true);
      },
      wrapForProviderScope: (
        _run: ProviderRunIdentity,
        command: ProcessCommand
      ) => {
        void command;
        return wrapPending;
      }
    };
    const provider = createCodexProvider({ processScope });
    const iterable = provider.runAttempt({
      ...providerInputFixture(),
      provider: {
        command: `${process.execPath} ${fakeServerPath} app-server`,
        name: "codex"
      },
      workspacePath
    });
    const iterator = iterable[Symbol.asyncIterator]();
    const eventsPromise = collectIteratorEvents(iterator);

    // Regression: the placeholder registered before the wrapForProviderScope
    // await lives outside the try/finally that owns the only
    // activeRuns.delete call, so the early return taken on this cancellation
    // path used to skip cleanup entirely and leak the map entry for the
    // lifetime of the provider instance.
    const deleteSpy = vi.spyOn(Map.prototype, "delete");
    await provider.cancel("run-issue-9");
    resolveWrap?.({
      args: [fakeServerPath, "app-server"],
      executable: process.execPath
    });
    const events = await eventsPromise;

    expect(events.map((event) => event.normalized)).toEqual([
      {
        cancelled: true,
        exitCode: null,
        signal: null,
        type: "process_exit"
      }
    ]);
    await expect(readFile(transcriptPath, "utf8")).rejects.toThrow();
    expect(deleteSpy).toHaveBeenCalledWith("run-issue-9");
    deleteSpy.mockRestore();
  });
});

describe("Codex provider validate", () => {
  it("succeeds when no profile is configured", async () => {
    const root = await makeTempRoot();
    const fakePath = path.join(root, "fake-codex-validate.mjs");
    await writeFakeCodexValidator(fakePath, []);
    const provider = createCodexProvider({ processScope: noopProcessScope() });

    await expect(
      provider.validate(`${process.execPath} ${fakePath} app-server`)
    ).resolves.toBeUndefined();
  });

  it("probes the configured app-server sandbox before accepting the command", async () => {
    const root = await makeTempRoot();
    const fakePath = path.join(root, "fake-codex-validate.mjs");
    const transcriptPath = path.join(root, "validate-requests.jsonl");
    await writeFakeCodexValidator(fakePath, [], { transcriptPath });
    const provider = createCodexProvider({ processScope: noopProcessScope() });

    await expect(
      provider.validate(`${process.execPath} ${fakePath} app-server`)
    ).resolves.toBeUndefined();

    const requests = readJsonl(await readFile(transcriptPath, "utf8"));
    expect(requests.map((request) => objectField(request, "method"))).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "command/exec"
    ]);
    expect(requests[2]).toMatchObject({
      method: "thread/start",
      params: {
        approvalPolicy: "never",
        ephemeral: true,
        persistExtendedHistory: false,
        sandbox: "danger-full-access"
      }
    });
    expect(requests[3]).toMatchObject({
      method: "command/exec",
      params: {
        sandboxPolicy: {
          type: "dangerFullAccess"
        },
        timeoutMs: 30_000
      }
    });
    const command = objectField(objectField(requests[3], "params"), "command");
    expect(command).toEqual(["bash", "-lc", expect.any(String)]);
    const shellScript =
      Array.isArray(command) && typeof command[2] === "string"
        ? command[2]
        : "";
    expect(shellScript).toContain("https://api.github.com");
    expect(shellScript).toContain("node:https");
    expect(shellScript).not.toContain("curl");
  });

  it("lets operators override the runtime sandbox probe timeout independently", async () => {
    const root = await makeTempRoot();
    const fakePath = path.join(root, "fake-codex-validate.mjs");
    const transcriptPath = path.join(root, "validate-requests.jsonl");
    await writeFakeCodexValidator(fakePath, [], { transcriptPath });
    process.env.SYMPHONIKA_CODEX_RUNTIME_PROBE_TIMEOUT_MS = "42000";
    const provider = createCodexProvider({ processScope: noopProcessScope() });

    await expect(
      provider.validate(`${process.execPath} ${fakePath} app-server`)
    ).resolves.toBeUndefined();

    const requests = readJsonl(await readFile(transcriptPath, "utf8"));
    expect(objectField(objectField(requests[3], "params"), "timeoutMs")).toBe(
      42_000
    );
  });

  it("rejects app-server commands that start read-only Codex threads", async () => {
    const root = await makeTempRoot();
    const fakePath = path.join(root, "fake-codex-validate.mjs");
    await writeFakeCodexValidator(fakePath, [], { sandboxType: "readOnly" });
    const provider = createCodexProvider({ processScope: noopProcessScope() });

    await expect(
      provider.validate(`${process.execPath} ${fakePath} app-server`)
    ).rejects.toThrow(
      /thread\/start sandbox is readOnly; expected dangerFullAccess/
    );
  });

  it.each([
    {
      exitCode: 11,
      message: /blocks in-cwd writes/,
      stderr: "SYMPHONIKA_PROBE_WRITE_FAILED\n"
    },
    {
      exitCode: 12,
      message: /blocks public git network access/,
      stderr: "SYMPHONIKA_PROBE_GIT_NETWORK_FAILED\n"
    },
    {
      exitCode: 13,
      message: /blocks api\.github\.com reachability/,
      stderr: "SYMPHONIKA_PROBE_GITHUB_API_FAILED\n"
    }
  ])(
    "surfaces command/exec sandbox probe failures for exit code $exitCode",
    async ({ exitCode, message, stderr }) => {
      const root = await makeTempRoot();
      const fakePath = path.join(root, "fake-codex-validate.mjs");
      await writeFakeCodexValidator(fakePath, [], {
        commandExitCode: exitCode,
        commandStderr: stderr
      });
      const provider = createCodexProvider({
        processScope: noopProcessScope()
      });

      await expect(
        provider.validate(`${process.execPath} ${fakePath} app-server`)
      ).rejects.toThrow(message);
    }
  );

  it("succeeds when the configured profile exists", async () => {
    const root = await makeTempRoot();
    const fakePath = path.join(root, "fake-codex-validate.mjs");
    await writeFakeCodexValidator(fakePath, ["symphonika"]);
    const provider = createCodexProvider({ processScope: noopProcessScope() });

    await expect(
      provider.validate(
        `${process.execPath} ${fakePath} -p symphonika app-server`
      )
    ).resolves.toBeUndefined();
  });

  it("returns an actionable error including the [profiles.<name>] snippet when the profile is missing", async () => {
    const root = await makeTempRoot();
    const fakePath = path.join(root, "fake-codex-validate.mjs");
    await writeFakeCodexValidator(fakePath, []);
    const provider = createCodexProvider({ processScope: noopProcessScope() });

    await expect(
      provider.validate(
        `${process.execPath} ${fakePath} -p symphonika app-server`
      )
    ).rejects.toThrow(/\[profiles\.symphonika\][\s\S]*memories\s*=\s*false/);
  });

  it("fails validation when the profile probe times out instead of silently treating it as success", async () => {
    const root = await makeTempRoot();
    const fakePath = path.join(root, "fake-codex-validate.mjs");
    await writeFakeCodexValidator(fakePath, ["symphonika"], {
      hangFeaturesList: true
    });
    const previousTimeout = process.env.SYMPHONIKA_CODEX_PROBE_TIMEOUT_MS;
    process.env.SYMPHONIKA_CODEX_PROBE_TIMEOUT_MS = "5000";
    const provider = createCodexProvider({ processScope: noopProcessScope() });

    try {
      await expect(
        provider.validate(
          `${process.execPath} ${fakePath} -p symphonika app-server`
        )
      ).rejects.toThrow(/profile probe for 'symphonika' timed out/i);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.SYMPHONIKA_CODEX_PROBE_TIMEOUT_MS;
      } else {
        process.env.SYMPHONIKA_CODEX_PROBE_TIMEOUT_MS = previousTimeout;
      }
    }
  }, 15_000);
});

async function collectProviderEvents(
  iterable: AsyncIterable<ProviderEvent>
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

async function collectIteratorEvents(
  iterator: AsyncIterator<ProviderEvent>
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  while (true) {
    const result = await iterator.next();
    if (result.done === true) {
      return events;
    }

    events.push(result.value);
  }
}

async function nextProviderEvent(
  iterator: AsyncIterator<ProviderEvent>
): Promise<ProviderEvent> {
  const result = await iterator.next();
  if (result.done === true) {
    throw new Error("expected provider event");
  }

  return result.value;
}

function providerInputFixture(): ProviderRunInput {
  return {
    branchName: "sym/symphonika/9-add-codex-json-rpc-provider-adapter",
    issue: {
      body: "Issue body",
      created_at: "2026-04-20T10:00:00Z",
      id: 5009,
      labels: ["agent-ready"],
      number: 9,
      priority: 99,
      state: "open",
      title: "Add Codex JSON-RPC provider adapter",
      updated_at: "2026-04-21T11:00:00Z",
      url: "https://github.com/pmatos/symphonika/issues/9"
    },
    prompt: "Implement issue #9.",
    promptPath: "/tmp/prompt.md",
    provider: {
      command: DEFAULT_CODEX_COMMAND,
      name: "codex"
    },
    run: {
      attempt: 1,
      id: "run-issue-9"
    },
    workspacePath: "/tmp/workspace"
  };
}

async function writeFakeCodexAppServer(
  filePath: string,
  transcriptPath: string,
  pidPath?: string
): Promise<void> {
  await writeFile(
    filePath,
    [
      "import { appendFile, writeFile } from 'node:fs/promises';",
      "import readline from 'node:readline';",
      "",
      "const scenarioArg = process.argv.find((arg) => arg.startsWith('--scenario='));",
      "const scenario = scenarioArg ? scenarioArg.slice('--scenario='.length) : 'success';",
      `const pidPath = ${JSON.stringify(pidPath)};`,
      "if (pidPath) { await writeFile(pidPath, String(process.pid), 'utf8'); }",
      "",
      "if (process.argv.includes('--help')) {",
      "  process.stdout.write('Usage: fake-codex app-server --listen <URL>\\n');",
      "  process.exit(0);",
      "}",
      "",
      "const transcriptPath = process.env.SYMPHONIKA_FAKE_CODEX_TRANSCRIPT;",
      "const rl = readline.createInterface({ input: process.stdin });",
      "function send(message) {",
      "  process.stdout.write(`${JSON.stringify(message)}\\n`);",
      "}",
      "async function record(message) {",
      "  if (transcriptPath) {",
      "    await appendFile(transcriptPath, `${JSON.stringify(message)}\\n`, 'utf8');",
      "  }",
      "}",
      "",
      "for await (const line of rl) {",
      "  const message = JSON.parse(line);",
      "  await record(message);",
      "  if (message.method === 'initialize') {",
      "    send({",
      "      id: message.id,",
      "      result: {",
      "        codexHome: '/tmp/fake-codex-home',",
      "        platformFamily: 'unix',",
      "        platformOs: 'linux',",
      "        userAgent: 'fake-codex-app-server'",
      "      }",
      "    });",
      "  }",
      "  if (message.method === 'thread/start') {",
      "    send({",
      "      id: message.id,",
      "      result: {",
      "        cwd: process.cwd(),",
      "        thread: {",
      "          id: 'thread-9'",
      "        }",
      "      }",
      "    });",
      "  }",
      "  if (message.method === 'turn/start') {",
      "    send({",
      "      id: message.id,",
      "      result: {",
      "        turn: {",
      "          id: 'turn-9',",
      "          status: 'inProgress'",
      "        }",
      "      }",
      "    });",
      "    if (scenario === 'input-required') {",
      "      send({ method: 'item/tool/requestUserInput', id: 'input-1', params: { threadId: 'thread-9', turnId: 'turn-9', itemId: 'item-input', questions: [{ header: 'Choice', id: 'choice', question: 'Need operator input?', options: [] }] } });",
      "      continue;",
      "    }",
      "    if (scenario === 'malformed') {",
      "      process.stdout.write('{bad json\\n');",
      "      continue;",
      "    }",
      "    if (scenario === 'error') {",
      "      send({ method: 'error', params: { threadId: 'thread-9', turnId: 'turn-9', error: { message: 'model exploded politely', codexErrorInfo: null, additionalDetails: null }, willRetry: false } });",
      "      continue;",
      "    }",
      "    if (scenario === 'wait') {",
      "      continue;",
      "    }",
      "    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-9', turnId: 'turn-9', itemId: 'item-1', delta: 'done' } });",
      "    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-9', turnId: 'turn-9', tokenUsage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } } });",
      "    send({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { remaining: 42, resetAt: 1777470000 } } } });",
      "    send({ method: 'turn/completed', params: { threadId: 'thread-9', turn: { id: 'turn-9', status: 'completed' } } });",
      "    process.exit(0);",
      "  }",
      "  if (message.method === 'turn/interrupt') {",
      "    send({ id: message.id, result: {} });",
      "    process.exit(0);",
      "  }",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );

  process.env.SYMPHONIKA_FAKE_CODEX_TRANSCRIPT = transcriptPath;
}

async function writeFakeCodexProcessTree(
  filePath: string,
  grandchildPath: string,
  grandchildPidPath: string
): Promise<void> {
  await writeFile(
    grandchildPath,
    [
      "import { writeFileSync } from 'node:fs';",
      "process.on('SIGTERM', () => {});",
      `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    filePath,
    [
      "import { spawn } from 'node:child_process';",
      "import readline from 'node:readline';",
      `spawn(process.execPath, [${JSON.stringify(grandchildPath)}], { stdio: 'ignore' });`,
      "const rl = readline.createInterface({ input: process.stdin });",
      "function send(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }",
      "for await (const line of rl) {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') {",
      "    send({ id: message.id, result: { codexHome: '/tmp/fake-codex-home', platformFamily: 'unix', platformOs: 'linux', userAgent: 'fake-codex-app-server' } });",
      "  }",
      "  if (message.method === 'thread/start') {",
      "    send({ id: message.id, result: { cwd: process.cwd(), thread: { id: 'thread-9' } } });",
      "  }",
      "  if (message.method === 'turn/start') {",
      "    send({ id: message.id, result: { turn: { id: 'turn-9', status: 'inProgress' } } });",
      "  }",
      "  if (message.method === 'turn/interrupt') {",
      "    send({ id: message.id, result: {} });",
      "  }",
      "}",
      "await new Promise(() => {});",
      ""
    ].join("\n"),
    "utf8"
  );
}

async function waitForFileContent(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      // The child process has not created the file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for file ${filePath}`);
}

async function waitForProcessStopped(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!(await processIsRunning(pid))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for process ${pid} to stop`);
}

async function processIsRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }

  if (process.platform !== "linux") {
    return true;
  }

  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    return commandEnd < 0 || stat.slice(commandEnd + 2, commandEnd + 3) !== "Z";
  } catch (error) {
    return !hasErrorCode(error, "ENOENT");
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function writeFakeCodexValidator(
  filePath: string,
  knownProfiles: string[],
  options: {
    commandExitCode?: number;
    commandStderr?: string;
    hangFeaturesList?: boolean;
    sandboxType?: "dangerFullAccess" | "readOnly";
    transcriptPath?: string;
  } = {}
): Promise<void> {
  await writeFile(
    filePath,
    [
      "import { appendFile } from 'node:fs/promises';",
      "import readline from 'node:readline';",
      "",
      `const known = new Set(${JSON.stringify(knownProfiles)});`,
      `const commandExitCode = ${JSON.stringify(options.commandExitCode ?? 0)};`,
      `const commandStderr = ${JSON.stringify(options.commandStderr ?? "")};`,
      `const hangFeaturesList = ${options.hangFeaturesList === true ? "true" : "false"};`,
      `const sandboxType = ${JSON.stringify(options.sandboxType ?? "dangerFullAccess")};`,
      `const transcriptPath = ${JSON.stringify(options.transcriptPath)};`,
      "const args = process.argv.slice(2);",
      "function profileFrom(args) {",
      "  for (let i = 0; i < args.length; i++) {",
      "    const a = args[i];",
      "    if (a === '-p' || a === '--profile') return args[i + 1];",
      "    if (a.startsWith('--profile=')) return a.slice('--profile='.length);",
      "  }",
      "  return undefined;",
      "}",
      "function send(message) {",
      "  process.stdout.write(`${JSON.stringify(message)}\\n`);",
      "}",
      "async function record(message) {",
      "  if (transcriptPath) {",
      "    await appendFile(transcriptPath, `${JSON.stringify(message)}\\n`, 'utf8');",
      "  }",
      "}",
      "if (args.includes('--help')) {",
      "  process.stdout.write('Usage: fake-codex app-server --listen <URL>\\n');",
      "  process.exit(0);",
      "} else if (args.includes('features') && args.includes('list')) {",
      "  if (hangFeaturesList) {",
      "    setTimeout(() => process.exit(0), 60_000);",
      "  } else {",
      "    const profile = profileFrom(args);",
      "    if (profile !== undefined && !known.has(profile)) {",
      "      process.stderr.write('Error: config profile `' + profile + '` not found\\n');",
      "      process.exit(1);",
      "    }",
      "    process.stdout.write('memories experimental true\\n');",
      "    process.exit(0);",
      "  }",
      "} else {",
      "  const rl = readline.createInterface({ input: process.stdin });",
      "  for await (const line of rl) {",
      "    const message = JSON.parse(line);",
      "    await record(message);",
      "    if (message.method === 'initialize') {",
      "      send({ id: message.id, result: { codexHome: '/tmp/fake-codex-home', platformFamily: 'unix', platformOs: 'linux', userAgent: 'fake-codex-app-server' } });",
      "    }",
      "    if (message.method === 'thread/start') {",
      "      send({ id: message.id, result: { approvalPolicy: 'never', cwd: message.params.cwd, sandbox: { type: sandboxType }, thread: { id: 'validate-thread' } } });",
      "    }",
      "    if (message.method === 'command/exec') {",
      "      send({ id: message.id, result: { exitCode: commandExitCode, stdout: commandExitCode === 0 ? 'probe ok\\n' : '', stderr: commandStderr } });",
      "      process.exit(0);",
      "    }",
      "  }",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
}

function readJsonl(contents: string): unknown[] {
  return contents
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function objectField(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) {
    return value[key as keyof typeof value];
  }

  return undefined;
}
