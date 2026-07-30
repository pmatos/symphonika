import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { spawnProviderProcess } from "../src/providers/provider-process.js";

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
});
