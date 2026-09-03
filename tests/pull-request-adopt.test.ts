import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp, type AdoptPullRequestResult } from "../src/http/app.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-pr-adopt-test-"));
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

type TestSetup = {
  cleanup: () => void;
  runStore: RunStore;
  stateRoot: string;
};

async function setup(): Promise<TestSetup> {
  const stateRoot = await makeTempRoot();
  const runStore = openRunStore({ stateRoot });
  return { cleanup: () => runStore.close(), runStore, stateRoot };
}

describe("POST /api/prs/:project/:number/adopt (ADR-2026-09-03-1158)", () => {
  it("returns 200 and the new run id on success", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        adoptPullRequest: (input) => {
          expect(input).toEqual({
            entryStateId: "wait_for_pr",
            issueNumber: 246,
            prNumber: 12,
            projectName: "alpha"
          });
          return Promise.resolve({ kind: "adopted", runId: "adopted-run-1" });
        },
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/api/prs/alpha/12/adopt", {
        body: JSON.stringify({ entryStateId: "wait_for_pr", issueNumber: 246 }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as AdoptPullRequestResult;
      expect(body).toEqual({ kind: "adopted", runId: "adopted-run-1" });
    } finally {
      test.cleanup();
    }
  });

  it("maps each refusal kind to its documented HTTP status", async () => {
    const test = await setup();
    try {
      const cases: Array<{ result: AdoptPullRequestResult; status: number }> = [
        {
          result: {
            kind: "invalid-entry-state",
            validStateIds: ["wait_for_pr"]
          },
          status: 422
        },
        { result: { kind: "not-pr-aware-workflow" }, status: 422 },
        { result: { kind: "not-issue-branch" }, status: 422 },
        {
          result: { kind: "live-run-conflict", runId: "live-1" },
          status: 409
        },
        { result: { kind: "error", error: "boom" }, status: 500 }
      ];

      for (const { result, status } of cases) {
        const app = createHttpApp({
          adoptPullRequest: () => Promise.resolve(result),
          runStore: test.runStore,
          stateRoot: test.stateRoot,
          version: "0.1.0"
        });
        const response = await app.request("/api/prs/alpha/12/adopt", {
          body: JSON.stringify({
            entryStateId: "wait_for_pr",
            issueNumber: 246
          }),
          headers: { "content-type": "application/json" },
          method: "POST"
        });
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual(result);
      }
    } finally {
      test.cleanup();
    }
  });

  it("returns 503 when adoptPullRequest is not wired", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/api/prs/alpha/12/adopt", {
        body: JSON.stringify({
          entryStateId: "wait_for_pr",
          issueNumber: 246
        }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ kind: "unavailable" });
    } finally {
      test.cleanup();
    }
  });

  it("returns 400 for a malformed JSON body", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        adoptPullRequest: () => {
          throw new Error("should not be called");
        },
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/api/prs/alpha/12/adopt", {
        body: "not json",
        headers: { "content-type": "application/json" },
        method: "POST"
      });

      expect(response.status).toBe(400);
    } finally {
      test.cleanup();
    }
  });

  it("returns 400 when the body is missing required fields", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        adoptPullRequest: () => {
          throw new Error("should not be called");
        },
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/api/prs/alpha/12/adopt", {
        body: JSON.stringify({ issueNumber: 246 }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });

      expect(response.status).toBe(400);
    } finally {
      test.cleanup();
    }
  });
});
