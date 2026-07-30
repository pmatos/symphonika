import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  shutdownProviderProcess,
  spawnProviderProcess
} from "../src/providers/provider-process.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn()
}));

const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: originalPlatform
  });
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("provider process spawning", () => {
  it("does not detach the direct provider process on Windows", () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32"
    });
    const child = {} as ChildProcessWithoutNullStreams;
    vi.mocked(spawn).mockReturnValue(child);

    expect(
      spawnProviderProcess(
        { args: ["--version"], executable: "provider.exe" },
        "C:\\workspace"
      )
    ).toBe(child);
    expect(spawn).toHaveBeenCalledWith("provider.exe", ["--version"], {
      cwd: "C:\\workspace",
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
  });

  it("runs a cancellation courtesy registered during shutdown before EOF", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const send = vi.fn();
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      kill: vi.fn(),
      pid: 12_345,
      send,
      stderr: {
        destroy: vi.fn()
      },
      stdin: {
        destroy: vi.fn(),
        destroyed: false,
        end: vi.fn(() => {
          order.push("stdin-end");
        }),
        writable: true
      },
      stdout: {
        destroy: vi.fn()
      }
    }) as unknown as ChildProcessWithoutNullStreams;

    const internalShutdown = shutdownProviderProcess(child);
    const cancellationShutdown = shutdownProviderProcess(child, () => {
      order.push("courtesy");
    });
    child.emit("message", "shutdown-ready");

    await Promise.all([internalShutdown, cancellationShutdown]);
    expect(send).toHaveBeenCalledOnce();
    expect(order).toEqual(["courtesy", "stdin-end"]);
  });
});
