import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderEvent } from "../src/provider.js";
import {
  createRoutineProviderEvidenceWriter,
  createRunProviderEvidenceWriter
} from "../src/providers/provider-evidence.js";
import { readRecentRoutineEvents } from "../src/routines/evidence.js";
import type { RunStore } from "../src/run-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function evidencePaths() {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-provider-evidence-")
  );
  roots.push(root);
  return {
    normalizedIndexPath: path.join(root, "normalized.jsonl.idx"),
    normalizedLogPath: path.join(root, "normalized.jsonl"),
    rawLogPath: path.join(root, "raw.jsonl")
  };
}

function runStore() {
  return {
    recordProviderEvent: vi.fn<RunStore["recordProviderEvent"]>(),
    recordProviderStreamReceipt:
      vi.fn<RunStore["recordProviderStreamReceipt"]>()
  };
}

describe("Run Provider Evidence Writer", () => {
  it("records raw-only receipts and normalized events with the raw sequence and ingestion timestamp", async () => {
    const paths = await evidencePaths();
    const store = runStore();
    const writer = createRunProviderEvidenceWriter({
      ...paths,
      attemptId: "attempt-1",
      runId: "run-1",
      runStore: store,
      redactSecrets: []
    });
    const receivedAt = "2026-09-01T00:00:01.000Z";
    await writer.write({ raw: { chunk: "partial" }, receivedAt });
    const event: ProviderEvent = {
      raw: { done: true },
      normalized: { type: "process_exit", exitCode: 0 },
      receivedAt
    };
    expect(await writer.write(event)).toBe(event.normalized);
    expect(store.recordProviderStreamReceipt).toHaveBeenCalledExactlyOnceWith({
      attemptId: "attempt-1",
      runId: "run-1",
      receivedAt,
      sequence: 1
    });
    expect(store.recordProviderEvent).toHaveBeenCalledExactlyOnceWith({
      attemptId: "attempt-1",
      runId: "run-1",
      receivedAt,
      sequence: 2,
      raw: event.raw,
      normalized: event.normalized
    });
    expect(await readFile(paths.rawLogPath, "utf8")).toBe(
      '{"chunk":"partial"}\n{"done":true}\n'
    );
    expect(await readFile(paths.normalizedLogPath, "utf8")).toBe(
      '{"type":"process_exit","exitCode":0}\n'
    );
  });

  it("redacts copies before JSON serialization and preserves the lifecycle event identity", async () => {
    const paths = await evidencePaths();
    const store = runStore();
    const secret = 'secret"\\\n';
    const writer = createRunProviderEvidenceWriter({
      ...paths,
      attemptId: "attempt-1",
      runId: "run-1",
      runStore: store,
      redactSecrets: [secret, "process", "123456"]
    });
    const normalized = {
      type: "process_exit" as const,
      exitCode: 0,
      message: secret
    };
    const raw = { [secret]: [secret, 123456] };
    expect(await writer.write({ raw, normalized })).toBe(normalized);
    expect(normalized.type).toBe("process_exit");
    expect(normalized.message).toBe(secret);
    expect(raw[secret]).toEqual([secret, 123456]);
    const redacted = {
      type: "[REDACTED]_exit",
      exitCode: 0,
      message: "[REDACTED]"
    };
    expect(store.recordProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        normalized: redacted,
        raw: { "[REDACTED]": ["[REDACTED]", "[REDACTED]"] }
      })
    );
    expect(
      JSON.parse((await readFile(paths.normalizedLogPath, "utf8")).trim())
    ).toEqual(redacted);
    expect(
      JSON.parse((await readFile(paths.rawLogPath, "utf8")).trim())
    ).toEqual({ "[REDACTED]": ["[REDACTED]", "[REDACTED]"] });
  });

  it("uses the current clock only when the provider supplies no receipt timestamp", async () => {
    const paths = await evidencePaths();
    const store = runStore();
    const writer = createRunProviderEvidenceWriter({
      ...paths,
      attemptId: "attempt-1",
      runId: "run-1",
      runStore: store,
      redactSecrets: []
    });
    const before = Date.now();
    expect(await writer.write({ raw: null })).toBeUndefined();
    const receivedAt =
      store.recordProviderStreamReceipt.mock.calls[0]?.[0].receivedAt ?? "";
    expect(Date.parse(receivedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(receivedAt)).toBeLessThanOrEqual(Date.now());
    await expect(readFile(paths.normalizedLogPath)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("propagates an append failure after retaining the synchronous Run Store evidence", async () => {
    const paths = await evidencePaths();
    const store = runStore();
    const writer = createRunProviderEvidenceWriter({
      ...paths,
      rawLogPath: path.join(paths.rawLogPath, "missing", "raw"),
      attemptId: "attempt-1",
      runId: "run-1",
      runStore: store,
      redactSecrets: []
    });
    const pending = writer
      .write({ raw: "raw" })
      .catch((error: unknown) => error);
    expect(store.recordProviderStreamReceipt).toHaveBeenCalledTimes(1);
    expect(await pending).toMatchObject({ code: "ENOENT" });
  });

  it("does not start file appends when the Run Store write throws", async () => {
    const paths = await evidencePaths();
    const store = runStore();
    const error = new Error("receipt failed");
    store.recordProviderStreamReceipt.mockImplementation(() => {
      throw error;
    });
    const writer = createRunProviderEvidenceWriter({
      ...paths,
      attemptId: "attempt-1",
      runId: "run-1",
      runStore: store,
      redactSecrets: []
    });
    await expect(writer.write({ raw: "raw" })).rejects.toBe(error);
    await expect(readFile(paths.rawLogPath)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});

describe("Routine Provider Evidence Writer", () => {
  it("indexes the redacted UTF-8 bytes with normalized-only sequences and remains readable through the existing reader", async () => {
    const paths = await evidencePaths();
    const secret = 'secret"\\\n';
    const redactSecrets = vi.fn(() => [secret]);
    const writer = createRoutineProviderEvidenceWriter({
      ...paths,
      redactSecrets
    });
    expect(await writer.write({ raw: "raw-only" })).toBeUndefined();
    const first = { type: "message" as const, text: `é🦉 ${secret}` };
    expect(await writer.write({ raw: secret, normalized: first })).toBe(first);
    await writer.write({ raw: "another-raw-only" });
    const second = { type: "process_exit" as const, exitCode: 0 };
    await writer.write({ raw: "exit", normalized: second });
    const firstLine = `${JSON.stringify({ type: "message", text: "é🦉 [REDACTED]" })}\n`;
    expect(await readFile(paths.normalizedLogPath, "utf8")).toBe(
      firstLine + JSON.stringify(second) + "\n"
    );
    const index = await readFile(paths.normalizedIndexPath);
    expect(index.length).toBe(32);
    expect(index.readBigUInt64BE(0)).toBe(0n);
    expect(index.readBigUInt64BE(8)).toBe(1n);
    expect(index.readBigUInt64BE(16)).toBe(
      BigInt(Buffer.byteLength(firstLine))
    );
    expect(index.readBigUInt64BE(24)).toBe(2n);
    expect(await readRecentRoutineEvents(paths.normalizedLogPath, 1)).toEqual({
      events: [{ normalized: second, sequence: 2, type: "process_exit" }],
      truncated: true
    });
    expect(await readFile(paths.rawLogPath, "utf8")).toBe(
      '"raw-only"\n"[REDACTED]"\n"another-raw-only"\n"exit"\n'
    );
    expect(redactSecrets).toHaveBeenCalledTimes(4);
  });

  it("resolves a fresh credential inventory once for each event", async () => {
    const paths = await evidencePaths();
    let secret = "old-password";
    const redactSecrets = vi.fn(() => [secret]);
    const writer = createRoutineProviderEvidenceWriter({
      ...paths,
      redactSecrets
    });
    await writer.write({
      raw: secret,
      normalized: { type: "message", text: secret }
    });
    secret = "new-password";
    await writer.write({
      raw: secret,
      normalized: { type: "message", text: secret }
    });
    expect(redactSecrets).toHaveBeenCalledTimes(2);
    expect(await readFile(paths.rawLogPath, "utf8")).toBe(
      '"[REDACTED]"\n"[REDACTED]"\n'
    );
    expect(await readFile(paths.normalizedLogPath, "utf8")).toBe(
      '{"type":"message","text":"[REDACTED]"}\n'.repeat(2)
    );
  });

  it("does not create normalized or index evidence for a raw-only event", async () => {
    const paths = await evidencePaths();
    const writer = createRoutineProviderEvidenceWriter({
      ...paths,
      redactSecrets: () => []
    });
    await writer.write({ raw: { chunk: "partial" } });
    await expect(readFile(paths.normalizedLogPath)).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(paths.normalizedIndexPath)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("propagates an index append failure", async () => {
    const paths = await evidencePaths();
    const writer = createRoutineProviderEvidenceWriter({
      ...paths,
      normalizedIndexPath: path.join(
        paths.normalizedIndexPath,
        "missing",
        "index"
      ),
      redactSecrets: () => []
    });
    await expect(
      writer.write({ raw: "raw", normalized: { type: "message" } })
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
