import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  PROVIDER_STDERR_LOG_MAX_BYTES,
  attachProviderStderrLog,
  providerStderrLogPath,
  readProviderStderrTail,
  withProviderStderrTail
} from "../src/providers/provider-stderr.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-stderr-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

// Spawns a node child that writes `source` (an expression evaluated in the
// child) to stderr, tees it, and resolves once both the process and the tee's
// own file stream have finished.
async function runWithStderr(
  source: string,
  filePath: string | undefined,
  maxBytes?: number
): Promise<void> {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ["--input-type=module", "--eval", source],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  child.stdout.resume();
  attachProviderStderrLog(child, filePath, maxBytes);
  await new Promise<void>((resolve) => {
    child.once("close", () => {
      resolve();
    });
  });
  // The tee ends its write stream from the stderr 'end'/'close' handler, which
  // can land in the same tick as the process close; give the flush a turn.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
}

describe("providerStderrLogPath", () => {
  it("derives a sibling of the raw log, preserving the attempt suffix", () => {
    expect(
      providerStderrLogPath("/state/logs/runs/r1/provider.raw.jsonl")
    ).toBe("/state/logs/runs/r1/provider.stderr.log");
    expect(
      providerStderrLogPath("/state/logs/runs/r1/provider.raw.attempt-12.jsonl")
    ).toBe("/state/logs/runs/r1/provider.stderr.attempt-12.log");
  });

  it("still yields a sibling path for an unrecognised raw-log name", () => {
    expect(providerStderrLogPath("/state/logs/runs/r1/custom.jsonl")).toBe(
      "/state/logs/runs/r1/provider.stderr.log"
    );
  });
});

describe("attachProviderStderrLog", () => {
  it("writes what the provider said on stderr to the evidence file", async () => {
    const root = await makeTempRoot();
    const logPath = path.join(root, "provider.stderr.log");

    await runWithStderr(
      "process.stderr.write('auth warning: token expired\\n');",
      logPath
    );

    expect(await readFile(logPath, "utf8")).toBe(
      "auth warning: token expired\n"
    );
  });

  it("leaves no file behind when the provider writes nothing to stderr", async () => {
    const root = await makeTempRoot();
    const logPath = path.join(root, "provider.stderr.log");

    await runWithStderr("process.stdout.write('only stdout\\n');", logPath);

    await expect(stat(logPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("caps the log and records the truncation instead of filling the disk", async () => {
    const root = await makeTempRoot();
    const logPath = path.join(root, "provider.stderr.log");

    await runWithStderr(
      "for (let i = 0; i < 64; i += 1) { process.stderr.write('x'.repeat(64)); }",
      logPath,
      128
    );

    const contents = await readFile(logPath, "utf8");
    expect(contents.startsWith("x".repeat(128))).toBe(true);
    expect(contents).toContain(
      "[symphonika] provider stderr truncated at 128 bytes"
    );
    // The cap bounds the payload; only the one-line marker is written past it.
    expect(contents.replaceAll("x", "").trim()).toBe(
      "[symphonika] provider stderr truncated at 128 bytes"
    );
  });

  it("keeps draining stderr when no evidence path is configured", async () => {
    // A paused stderr would eventually block the provider on a full pipe, so
    // the no-path case must still consume the stream rather than ignore it.
    await runWithStderr(
      "process.stderr.write('y'.repeat(256 * 1024)); process.exit(0);",
      undefined
    );
  });

  it("defaults to a cap large enough for ordinary provider chatter", () => {
    expect(PROVIDER_STDERR_LOG_MAX_BYTES).toBeGreaterThanOrEqual(1_000_000);
  });
});

describe("readProviderStderrTail", () => {
  it("returns the last bytes of the log", async () => {
    const root = await makeTempRoot();
    const logPath = path.join(root, "provider.stderr.log");
    await writeFile(logPath, `${"a".repeat(100)}\nlast words\n`, "utf8");

    expect(await readProviderStderrTail(logPath, 16)).toBe("aaaa\nlast words");
  });

  it("returns undefined for a missing or empty log", async () => {
    const root = await makeTempRoot();
    const missing = path.join(root, "absent.log");
    const empty = path.join(root, "empty.log");
    await writeFile(empty, "", "utf8");

    expect(await readProviderStderrTail(missing)).toBeUndefined();
    expect(await readProviderStderrTail(empty)).toBeUndefined();
  });
});

describe("withProviderStderrTail", () => {
  it("appends a single-line excerpt to an otherwise unexplained reason", async () => {
    const root = await makeTempRoot();
    const logPath = path.join(root, "provider.stderr.log");
    await writeFile(logPath, "fatal:\n  out of memory\n", "utf8");

    expect(await withProviderStderrTail("process_exit_137", logPath)).toBe(
      "process_exit_137 (stderr: fatal: out of memory)"
    );
  });

  it("leaves the reason untouched when the provider said nothing", async () => {
    const root = await makeTempRoot();
    const logPath = path.join(root, "provider.stderr.log");

    expect(await withProviderStderrTail("firing_timeout", logPath)).toBe(
      "firing_timeout"
    );
    expect(await withProviderStderrTail("firing_timeout", undefined)).toBe(
      "firing_timeout"
    );
  });

  it("bounds the excerpt so terminal_reason stays a readable one-liner", async () => {
    const root = await makeTempRoot();
    const logPath = path.join(root, "provider.stderr.log");
    await writeFile(logPath, "z".repeat(4_000), "utf8");

    const reason = await withProviderStderrTail("process_exit_1", logPath);
    expect(reason.length).toBeLessThan(250);
    expect(reason.startsWith("process_exit_1 (stderr: zzz")).toBe(true);
  });
});
