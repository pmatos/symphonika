import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import type { IssueSnapshot } from "../src/issue-polling.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-http-events-test-")
  );
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

function sampleIssue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    body: "",
    created_at: "",
    id: 1,
    labels: [],
    number: 1,
    priority: 99,
    state: "open",
    title: "issue",
    updated_at: "",
    url: "",
    ...overrides
  };
}

type TestSetup = {
  cleanup: () => void;
  runStore: RunStore;
  stateRoot: string;
};

async function setup(): Promise<TestSetup> {
  const stateRoot = await makeTempRoot();
  const runStore = openRunStore({ stateRoot });
  return {
    cleanup: () => runStore.close(),
    runStore,
    stateRoot
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (buffer: string) => boolean,
  timeoutMs = 2_000
): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (!predicate(buffer) && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
  }
  return buffer;
}

describe("HTTP app — GET /events (#305, ADR 0074)", () => {
  it("streams a run-transition event immediately after a mutation", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        runStore: test.runStore,
        sseHeartbeatMs: 60_000,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/events");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream"
      );
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      // Let the SSE handler's synchronous subscribe run before mutating.
      await new Promise((resolve) => setTimeout(resolve, 10));

      test.runStore.createRun({
        id: "run-a",
        issue: sampleIssue({ number: 1 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });

      const buffer = await readUntil(reader!, (text) =>
        text.includes("event: run-transition")
      );
      await reader?.cancel();

      expect(buffer).toContain("event: run-transition");
      expect(buffer).toContain('"runId":"run-a"');
      expect(buffer).toContain('"state":"queued"');
    } finally {
      test.cleanup();
    }
  });

  it("streams a firing-transition event immediately after a mutation", async () => {
    const test = await setup();
    try {
      test.runStore.syncRoutines([
        {
          kind: "report",
          name: "audit",
          prompt: "Audit.",
          provider: "codex",
          projectName: "alpha",
          schedule: { at: "2026-05-22T10:00:00.000Z" },
          sourcePath: "/tmp/audit.md"
        }
      ]);
      const app = createHttpApp({
        runStore: test.runStore,
        sseHeartbeatMs: 60_000,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/events");
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 10));

      test.runStore.createRoutineFiring({
        id: "fire-1",
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex",
        routineName: "audit"
      });

      const buffer = await readUntil(reader!, (text) =>
        text.includes("event: firing-transition")
      );
      await reader?.cancel();

      expect(buffer).toContain("event: firing-transition");
      expect(buffer).toContain('"firingId":"fire-1"');
    } finally {
      test.cleanup();
    }
  });

  it("sends only heartbeats while idle, never inventing state changes", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        runStore: test.runStore,
        sseHeartbeatMs: 15,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/events");
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();

      const buffer = await readUntil(reader!, (text) =>
        text.includes("event: heartbeat")
      );
      await reader?.cancel();

      expect(buffer).toContain("event: heartbeat");
      expect(buffer).not.toContain("run-transition");
      expect(buffer).not.toContain("firing-transition");
    } finally {
      test.cleanup();
    }
  });

  it("unsubscribes from the change bus when the client disconnects", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        runStore: test.runStore,
        sseHeartbeatMs: 60_000,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      expect(test.runStore.changeListenerCount).toBe(0);
      const response = await app.request("/events");
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(test.runStore.changeListenerCount).toBe(1);

      await reader?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(test.runStore.changeListenerCount).toBe(0);
    } finally {
      test.cleanup();
    }
  });

  it("gives each concurrent connection its own independent subscription", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        runStore: test.runStore,
        sseHeartbeatMs: 60_000,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const first = await app.request("/events");
      const second = await app.request("/events");
      const firstReader = first.body?.getReader();
      const secondReader = second.body?.getReader();
      expect(firstReader).toBeDefined();
      expect(secondReader).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(test.runStore.changeListenerCount).toBe(2);

      test.runStore.createRun({
        id: "run-a",
        issue: sampleIssue({ number: 1 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });

      const [firstBuffer, secondBuffer] = await Promise.all([
        readUntil(firstReader!, (text) => text.includes("run-transition")),
        readUntil(secondReader!, (text) => text.includes("run-transition"))
      ]);
      await firstReader?.cancel();
      await secondReader?.cancel();

      expect(firstBuffer).toContain("event: run-transition");
      expect(secondBuffer).toContain("event: run-transition");
    } finally {
      test.cleanup();
    }
  });
});
