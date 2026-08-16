import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import {
  emptyIssuePollStatus,
  type IssueSnapshot
} from "../src/issue-polling.js";
import { openRunStore, type RunStore } from "../src/run-store.js";
import { buildStatusSnapshot } from "../src/status.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-http-fragments-test-")
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

describe("HTTP app — dashboard live-update fragments (#305 part 2, ADR 0074)", () => {
  it("GET /fragments/active-band renders the same content the dashboard embeds, without layout", async () => {
    const test = await setup();
    try {
      test.runStore.createRun({
        id: "run-a",
        issue: sampleIssue({ number: 1 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      test.runStore.updateRunState("run-a", "running");

      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const dashboard = await app.request("/");
      const dashboardHtml = await dashboard.text();
      expect(dashboardHtml).toContain('id="active-now-band"');

      const fragment = await app.request("/fragments/active-band");
      expect(fragment.status).toBe(200);
      const fragmentHtml = await fragment.text();

      expect(fragmentHtml).not.toContain("<html");
      expect(fragmentHtml).not.toContain('id="active-now-band"');
      expect(fragmentHtml).toContain("run-a");
      expect(dashboardHtml).toContain(fragmentHtml);
    } finally {
      test.cleanup();
    }
  });

  it("GET /fragments/projects-section renders the same content the dashboard embeds, without layout", async () => {
    const test = await setup();
    try {
      test.runStore.syncProjectStates([{ name: "alpha", weight: 1 }]);

      const app = createHttpApp({
        getStatusSnapshot: () =>
          buildStatusSnapshot({
            configPath: "/tmp/symphonika.yml",
            issuePollStatus: emptyIssuePollStatus(),
            runStore: test.runStore,
            stateRoot: test.stateRoot
          }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const dashboard = await app.request("/");
      const dashboardHtml = await dashboard.text();
      expect(dashboardHtml).toContain('id="projects-section"');

      const fragment = await app.request("/fragments/projects-section");
      expect(fragment.status).toBe(200);
      const fragmentHtml = await fragment.text();

      expect(fragmentHtml).not.toContain("<html");
      expect(fragmentHtml).not.toContain('id="projects-section"');
      expect(fragmentHtml).toContain("alpha");
      expect(dashboardHtml).toContain(fragmentHtml);
    } finally {
      test.cleanup();
    }
  });

  it("the dashboard embeds the stream-down banner (hidden) and the live-update script", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });

      const response = await app.request("/");
      const html = await response.text();

      expect(html).toContain('id="live-stream-banner"');
      expect(html).toContain("display:none");
      expect(html).toContain('new EventSource("/events")');
    } finally {
      test.cleanup();
    }
  });
});
