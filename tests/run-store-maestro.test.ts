import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openRunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-run-store-maestro-")
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

describe("RunStore Maestro conversation persistence (#865)", () => {
  it("has no dashboard conversation before any message is posted", async () => {
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    try {
      expect(runStore.findDashboardMaestroConversation()).toBeUndefined();
    } finally {
      runStore.close();
    }
  });

  it("creates the dashboard conversation once and reuses it on later calls", async () => {
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    try {
      const firstId = runStore.ensureDashboardMaestroConversation({
        id: "conv-1"
      });
      const secondId = runStore.ensureDashboardMaestroConversation({
        id: "conv-2"
      });
      expect(firstId).toBe("conv-1");
      expect(secondId).toBe("conv-1");
      expect(runStore.findDashboardMaestroConversation()).toEqual({
        id: "conv-1"
      });
    } finally {
      runStore.close();
    }
  });

  it("appends messages in order with their citations", async () => {
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    try {
      const conversationId = runStore.ensureDashboardMaestroConversation({
        id: "conv-1"
      });
      runStore.appendMaestroMessage({
        citations: [],
        content: "What's eligible right now?",
        conversationId,
        id: "msg-1",
        role: "user"
      });
      runStore.appendMaestroMessage({
        citations: [
          {
            href: "/issues/symphonika/42",
            kind: "issue",
            label: "symphonika#42",
            observedAt: "2026-10-06T12:00:00.000Z"
          }
        ],
        content: "symphonika#42 is eligible as of the last poll.",
        conversationId,
        id: "msg-2",
        role: "assistant"
      });

      const messages = runStore.listMaestroMessages(conversationId);
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        content: "What's eligible right now?",
        role: "user"
      });
      expect(messages[0]?.citations).toEqual([]);
      expect(messages[1]).toMatchObject({
        content: "symphonika#42 is eligible as of the last poll.",
        role: "assistant"
      });
      expect(messages[1]?.citations).toEqual([
        {
          href: "/issues/symphonika/42",
          kind: "issue",
          label: "symphonika#42",
          observedAt: "2026-10-06T12:00:00.000Z"
        }
      ]);
    } finally {
      runStore.close();
    }
  });

  it("survives a daemon restart: history persists on the same state root across store instances", async () => {
    const stateRoot = await makeTempRoot();
    const firstStore = openRunStore({ stateRoot });
    const conversationId = firstStore.ensureDashboardMaestroConversation({
      id: "conv-1"
    });
    firstStore.appendMaestroMessage({
      citations: [],
      content: "What's eligible right now?",
      conversationId,
      id: "msg-1",
      role: "user"
    });
    firstStore.close();

    const reopenedStore = openRunStore({ stateRoot });
    try {
      expect(reopenedStore.findDashboardMaestroConversation()).toEqual({
        id: "conv-1"
      });
      const messages = reopenedStore.listMaestroMessages(conversationId);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        content: "What's eligible right now?",
        role: "user"
      });
    } finally {
      reopenedStore.close();
    }
  });

  it("keeps Maestro conversations out of run listings and counts", async () => {
    const stateRoot = await makeTempRoot();
    const runStore = openRunStore({ stateRoot });
    try {
      const conversationId = runStore.ensureDashboardMaestroConversation({
        id: "conv-1"
      });
      runStore.appendMaestroMessage({
        citations: [],
        content: "hello",
        conversationId,
        id: "msg-1",
        role: "user"
      });

      expect(runStore.listRuns()).toEqual([]);
    } finally {
      runStore.close();
    }
  });
});
