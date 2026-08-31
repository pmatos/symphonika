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
  withProviderStderrTail,
  type AttachProviderStderrLogOptions
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
// own file stream have finished. The only synchronization is the capture's own
// `waitForFlush` — the same barrier the provider adapters await — so these
// tests fail rather than flake if that barrier stops ordering the flush.
async function runWithStderr(
  source: string,
  filePath: string | undefined,
  options: AttachProviderStderrLogOptions = {}
): Promise<void> {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ["--input-type=module", "--eval", source],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  child.stdout.resume();
  const capture = attachProviderStderrLog(child, filePath, options);
  await new Promise<void>((resolve) => {
    child.once("close", () => {
      resolve();
    });
  });
  await capture.waitForFlush();
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
      { maxBytes: 128 }
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

describe("attachProviderStderrLog redaction", () => {
  it("scrubs a configured secret before it reaches disk", async () => {
    const root = await makeTempRoot();
    const logPath = path.join(root, "provider.stderr.log");

    await runWithStderr(
      "process.stderr.write('smtp auth failed for hunter2 (retrying)\\n');",
      logPath,
      { redactSecrets: ["hunter2"] }
    );

    const contents = await readFile(logPath, "utf8");
    expect(contents).not.toContain("hunter2");
    expect(contents).toBe("smtp auth failed for [REDACTED] (retrying)\n");
  });

  it("scrubs a secret split across two stderr writes", async () => {
    // `data` chunks break at arbitrary byte offsets, so a redactor that only
    // looks at one chunk at a time leaks any secret straddling the boundary.
    const root = await makeTempRoot();
    const logPath = path.join(root, "provider.stderr.log");

    await runWithStderr(
      [
        "process.stderr.write('token=hun');",
        "await new Promise((r) => setTimeout(r, 20));",
        "process.stderr.write('ter2 rejected\\n');"
      ].join("\n"),
      logPath,
      { redactSecrets: ["hunter2"] }
    );

    const contents = await readFile(logPath, "utf8");
    expect(contents).not.toContain("hunter2");
    expect(contents).toBe("token=[REDACTED] rejected\n");
  });

  it("still flushes the held-back tail when the stream ends mid-holdback", async () => {
    // The redactor holds back `longest secret - 1` characters against a future
    // match; if finalization forgot to flush that carry, the provider's actual
    // last words would be the bytes silently dropped.
    const root = await makeTempRoot();
    const logPath = path.join(root, "provider.stderr.log");

    await runWithStderr("process.stderr.write('fatal: giving up');", logPath, {
      redactSecrets: ["hunter2"]
    });

    expect(await readFile(logPath, "utf8")).toBe("fatal: giving up");
  });

  it("writes only the marker when the secret was the whole of stderr", async () => {
    const root = await makeTempRoot();
    const logPath = path.join(root, "provider.stderr.log");

    await runWithStderr("process.stderr.write('hunter2');", logPath, {
      redactSecrets: ["hunter2"]
    });

    expect(await readFile(logPath, "utf8")).toBe("[REDACTED]");
  });

  it("keeps an astral character intact when it lands on the holdback boundary", async () => {
    // The holdback split is encoded by its own Buffer.from on each side, so a
    // boundary between an emoji's UTF-16 surrogates would persist two U+FFFD.
    const root = await makeTempRoot();
    const logPath = path.join(root, "provider.stderr.log");

    await runWithStderr(
      "process.stderr.write('xxxxx\\u{1F600}yyyyy');",
      logPath,
      { redactSecrets: ["hunter2"] }
    );

    const contents = await readFile(logPath, "utf8");
    expect(contents).toBe("xxxxx\u{1F600}yyyyy");
    expect(contents).not.toContain("\uFFFD");
  });

  it("keeps an astral character intact when it straddles two writes", async () => {
    const root = await makeTempRoot();
    const logPath = path.join(root, "provider.stderr.log");

    await runWithStderr(
      [
        "const b = Buffer.from('aaaaaaaaaa\\u{1F600}bbbbbbbbbb', 'utf8');",
        "process.stderr.write(b.subarray(0, 12));",
        "await new Promise((r) => setTimeout(r, 20));",
        "process.stderr.write(b.subarray(12));"
      ].join("\n"),
      logPath,
      { redactSecrets: ["hunter2"] }
    );

    const contents = await readFile(logPath, "utf8");
    expect(contents).toBe("aaaaaaaaaa\u{1F600}bbbbbbbbbb");
    expect(contents).not.toContain("\uFFFD");
  });

  it("keeps multi-byte characters intact across a chunk boundary", async () => {
    // A byte-sliced carry would decode to U+FFFD; the redactor carries decoded
    // characters instead.
    const root = await makeTempRoot();
    const logPath = path.join(root, "provider.stderr.log");

    await runWithStderr(
      [
        "const b = Buffer.from('déjà vu — hunter2\\n', 'utf8');",
        "process.stderr.write(b.subarray(0, 3));",
        "await new Promise((r) => setTimeout(r, 20));",
        "process.stderr.write(b.subarray(3));"
      ].join("\n"),
      logPath,
      { redactSecrets: ["hunter2"] }
    );

    const contents = await readFile(logPath, "utf8");
    expect(contents).toBe("déjà vu — [REDACTED]\n");
    expect(contents).not.toContain("\uFFFD");
  });
});

describe("attachProviderStderrLog redaction durability", () => {
  it("puts a short diagnostic on disk before the stream ends", async () => {
    // The whole point of teeing the head of the stream is that an orchestrator
    // killed mid-run still leaves the evidence behind. A blanket
    // `longest secret - 1` holdback would keep a message shorter than the
    // secret in memory forever — with a 40-character token, `fatal: disk full`
    // would never reach disk at all.
    const root = await makeTempRoot();
    const logPath = path.join(root, "provider.stderr.log");
    const token = `ghp_${"a".repeat(36)}`;
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "process.stderr.write('fatal: disk full\\n'); await new Promise((r) => setTimeout(r, 5_000));"
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    child.stdout.resume();
    const capture = attachProviderStderrLog(child, logPath, {
      redactSecrets: [token]
    });

    try {
      // No EOF, no flush — only the tee's own incremental writes.
      await expect
        .poll(() => readProviderStderrTail(logPath), { timeout: 4_000 })
        .toBe("fatal: disk full");
    } finally {
      child.kill("SIGKILL");
      await capture.waitForFlush();
    }
  });

  it("withholds only a tail that could still complete a secret", async () => {
    const root = await makeTempRoot();
    const logPath = path.join(root, "provider.stderr.log");
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "process.stderr.write('warn: token=hun'); await new Promise((r) => setTimeout(r, 5_000));"
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    child.stdout.resume();
    const capture = attachProviderStderrLog(child, logPath, {
      redactSecrets: ["hunter2"]
    });

    try {
      // "hun" could still become "hunter2", so it stays in the carry; the
      // text before it is already unambiguous and goes to disk now.
      await expect
        .poll(() => readProviderStderrTail(logPath), { timeout: 4_000 })
        .toBe("warn: token=");
    } finally {
      child.kill("SIGKILL");
      await capture.waitForFlush();
    }
  });
});

describe("attachProviderStderrLog flush barrier", () => {
  it("orders the tail read after the write, with no sleep", async () => {
    // The production callers read this file to explain an unclean exit as soon
    // as the adapter returns. waitForFlush is the only thing ordering that
    // read after the tee's write.
    const root = await makeTempRoot();
    const logPath = path.join(root, "provider.stderr.log");
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "process.stderr.write('boom: out of memory\\n'); process.exit(9);"
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    child.stdout.resume();
    const capture = attachProviderStderrLog(child, logPath, {});

    await new Promise<void>((resolve) => {
      child.once("close", () => {
        resolve();
      });
    });
    await capture.waitForFlush();

    expect(await readProviderStderrTail(logPath)).toBe("boom: out of memory");
  });

  it("resolves without a sink when the provider wrote nothing", async () => {
    const root = await makeTempRoot();
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      ["--input-type=module", "--eval", "process.exit(0);"],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    child.stdout.resume();
    const capture = attachProviderStderrLog(
      child,
      path.join(root, "provider.stderr.log"),
      {}
    );

    await new Promise<void>((resolve) => {
      child.once("close", () => {
        resolve();
      });
    });
    await expect(capture.waitForFlush()).resolves.toBeUndefined();
  });

  it("resolves immediately when no evidence path is configured", async () => {
    const child: ChildProcessWithoutNullStreams = spawn(
      process.execPath,
      ["--input-type=module", "--eval", "process.stderr.write('x');"],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    child.stdout.resume();
    const capture = attachProviderStderrLog(child, undefined);

    await expect(capture.waitForFlush()).resolves.toBeUndefined();
    await new Promise<void>((resolve) => {
      child.once("close", () => {
        resolve();
      });
    });
  });
});

describe("readProviderStderrTail", () => {
  it("returns the last bytes of the log", async () => {
    const root = await makeTempRoot();
    const logPath = path.join(root, "provider.stderr.log");
    await writeFile(logPath, `${"a".repeat(100)}\nlast words\n`, "utf8");

    expect(await readProviderStderrTail(logPath, 16)).toBe("aaaa\nlast words");
  });

  it("does not open the excerpt with a split multi-byte character", async () => {
    // The read offset is arbitrary, so it can land mid-character; the write
    // path is careful never to split one, and the read path must match.
    const root = await makeTempRoot();
    const logPath = path.join(root, "provider.stderr.log");
    await writeFile(logPath, "aaaé done", "utf8");

    const tail = await readProviderStderrTail(logPath, 6);
    expect(tail).toBe("done");
    expect(tail).not.toContain("\uFFFD");
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
