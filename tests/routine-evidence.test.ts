import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

type VirtualLog = {
  contents: Buffer<ArrayBufferLike>;
  forwardScanAttempted: boolean;
  indexContents: Buffer<ArrayBufferLike> | undefined;
  indexPath: string;
  path: string;
  reads: { length: number; path: string; position: number }[];
};

const virtualLog = vi.hoisted<VirtualLog>(() => ({
  contents: Buffer.alloc(0),
  forwardScanAttempted: false,
  indexContents: undefined,
  indexPath: "/virtual/provider.normalized.jsonl.idx",
  path: "/virtual/provider.normalized.jsonl",
  reads: []
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (
      filePath: Parameters<typeof actual.createReadStream>[0],
      options?: Parameters<typeof actual.createReadStream>[1]
    ) => {
      if (
        String(filePath) !== virtualLog.indexPath ||
        virtualLog.indexContents === undefined
      ) {
        return actual.createReadStream(filePath, options);
      }
      const start =
        typeof options === "object" && typeof options.start === "number"
          ? options.start
          : 0;
      const end =
        typeof options === "object" && typeof options.end === "number"
          ? options.end + 1
          : virtualLog.indexContents.length;
      const contents = virtualLog.indexContents.subarray(start, end);
      return Readable.from([
        typeof options === "object" && options.encoding === "latin1"
          ? contents.toString("latin1")
          : contents
      ]) as ReturnType<typeof actual.createReadStream>;
    }
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      const filePath = String(args[0]);
      const contents =
        filePath === virtualLog.path
          ? virtualLog.contents
          : filePath === virtualLog.indexPath
            ? virtualLog.indexContents
            : undefined;
      if (contents === undefined) {
        return actual.open(...args);
      }
      return Promise.resolve({
        close: () => Promise.resolve(),
        read: (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null
        ) => {
          const resolvedPosition = position ?? 0;
          virtualLog.reads.push({
            length,
            path: filePath,
            position: resolvedPosition
          });
          const bytesRead = contents.copy(
            buffer,
            offset,
            resolvedPosition,
            resolvedPosition + length
          );
          return Promise.resolve({ buffer, bytesRead });
        },
        readLines: () => ({
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            virtualLog.forwardScanAttempted = true;
            for (const line of contents.toString("utf8").split("\n")) {
              yield line;
            }
          }
        }),
        stat: () => Promise.resolve({ size: contents.length })
      } as unknown as Awaited<ReturnType<typeof actual.open>>);
    },
    stat: (
      filePath: Parameters<typeof actual.stat>[0],
      options?: Parameters<typeof actual.stat>[1]
    ) => {
      if (
        String(filePath) === virtualLog.indexPath &&
        virtualLog.indexContents !== undefined
      ) {
        return Promise.resolve({
          size: virtualLog.indexContents.length
        }) as ReturnType<typeof actual.stat>;
      }
      return actual.stat(filePath, options);
    }
  };
});

import { readRecentRoutineEvents } from "../src/routines/evidence.js";

afterEach(() => {
  virtualLog.contents = Buffer.alloc(0);
  virtualLog.forwardScanAttempted = false;
  virtualLog.indexContents = undefined;
  virtualLog.reads = [];
});

function indexedLog(lines: string[]): { contents: Buffer; index: Buffer } {
  const records: Buffer[] = [];
  let offset = 0;
  for (const [index, line] of lines.entries()) {
    const record = Buffer.alloc(16);
    record.writeBigUInt64BE(BigInt(offset));
    record.writeBigUInt64BE(BigInt(index + 1), 8);
    records.push(record);
    offset += Buffer.byteLength(`${line}\n`, "utf8");
  }
  return {
    contents: Buffer.from(`${lines.join("\n")}\n`, "utf8"),
    index: Buffer.concat(records)
  };
}

describe("readRecentRoutineEvents", () => {
  it("reads only a bounded suffix when the evidence log has no index", async () => {
    virtualLog.contents = Buffer.from(
      [
        JSON.stringify({ message: "x".repeat(256 * 1_024), type: "message" }),
        JSON.stringify({ message: "recent", type: "message" }),
        JSON.stringify({ exitCode: 0, type: "process_exit" })
      ].join("\n") + "\n",
      "utf8"
    );

    const tail = await readRecentRoutineEvents(virtualLog.path, 2);

    expect(virtualLog.forwardScanAttempted).toBe(false);
    expect(tail).toEqual({
      events: [
        {
          normalized: { message: "recent", type: "message" },
          sequence: null,
          type: "message"
        },
        {
          normalized: { exitCode: 0, type: "process_exit" },
          sequence: null,
          type: "process_exit"
        }
      ],
      truncated: true
    });
    expect(virtualLog.reads.length).toBeGreaterThan(0);
    expect(
      virtualLog.reads.every(
        ({ path, position }) => path !== virtualLog.path || position > 0
      )
    ).toBe(true);
    expect(
      virtualLog.reads.reduce((total, { length }) => total + length, 0)
    ).toBeLessThan(virtualLog.contents.length);
  });

  it("uses the offset index to preserve global event sequences", async () => {
    const oldEvents = Array.from({ length: 100 }, (_, index) =>
      JSON.stringify({ message: `old ${index + 1}`, type: "message" })
    );
    const persisted = indexedLog([
      ...oldEvents,
      JSON.stringify({ message: "recent", type: "message" }),
      JSON.stringify({ exitCode: 0, type: "process_exit" })
    ]);
    virtualLog.contents = persisted.contents;
    virtualLog.indexContents = persisted.index;

    const tail = await readRecentRoutineEvents(virtualLog.path, 2);

    expect(tail).toEqual({
      events: [
        {
          normalized: { message: "recent", type: "message" },
          sequence: 101,
          type: "message"
        },
        {
          normalized: { exitCode: 0, type: "process_exit" },
          sequence: 102,
          type: "process_exit"
        }
      ],
      truncated: true
    });
    expect(
      virtualLog.reads.every(
        ({ path, position }) => path !== virtualLog.path || position > 0
      )
    ).toBe(true);
    expect(
      virtualLog.reads
        .filter(({ path }) => path === virtualLog.path)
        .reduce((total, { length }) => total + length, 0)
    ).toBeLessThan(virtualLog.contents.length);
  });

  it("uses the bounded fallback when a complete index record is not a log boundary", async () => {
    const persisted = indexedLog([
      JSON.stringify({ message: "x".repeat(256 * 1_024), type: "message" }),
      JSON.stringify({ message: "recent", type: "message" }),
      JSON.stringify({ exitCode: 0, type: "process_exit" })
    ]);
    persisted.index.writeBigUInt64BE(1n, 16);
    virtualLog.contents = persisted.contents;
    virtualLog.indexContents = persisted.index;

    const tail = await readRecentRoutineEvents(virtualLog.path, 2);

    expect(tail).toEqual({
      events: [
        {
          normalized: { message: "recent", type: "message" },
          sequence: null,
          type: "message"
        },
        {
          normalized: { exitCode: 0, type: "process_exit" },
          sequence: null,
          type: "process_exit"
        }
      ],
      truncated: true
    });
    const logBytesRead = virtualLog.reads
      .filter(({ path }) => path === virtualLog.path)
      .reduce((total, { length }) => total + length, 0);
    expect(logBytesRead).toBeLessThan(virtualLog.contents.length / 2);
  });

  it("rejects an indexed offset that repeats a neighboring log boundary", async () => {
    const persisted = indexedLog([
      JSON.stringify({ message: "old", type: "message" }),
      JSON.stringify({ message: "x".repeat(256 * 1_024), type: "message" }),
      JSON.stringify({ message: "recent", type: "message" }),
      JSON.stringify({ exitCode: 0, type: "process_exit" })
    ]);
    const previousOffset = persisted.index.readBigUInt64BE(16);
    persisted.index.writeBigUInt64BE(previousOffset, 32);
    virtualLog.contents = persisted.contents;
    virtualLog.indexContents = persisted.index;

    const tail = await readRecentRoutineEvents(virtualLog.path, 2);

    expect(
      tail.events.map(({ sequence, type }) => ({ sequence, type }))
    ).toEqual([
      { sequence: null, type: "message" },
      { sequence: null, type: "process_exit" }
    ]);
    const logBytesRead = virtualLog.reads
      .filter(({ path }) => path === virtualLog.path)
      .reduce((total, { length }) => total + length, 0);
    expect(logBytesRead).toBeLessThan(virtualLog.contents.length / 2);
  });
});
