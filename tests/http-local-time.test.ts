import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Window } from "happy-dom";
import type { Document as HappyDomDocument } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import { openRunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

function unwrappedIsoTimestamps(root: HappyDomDocument): (string | null)[] {
  return Array.from(root.querySelectorAll("code"))
    .filter(
      (element) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
          element.textContent ?? ""
        ) && element.querySelector("time[data-local-time]") === null
    )
    .map((element) => element.textContent);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

it("renders Run timestamps in the viewer's local time with the UTC value as a fallback", async () => {
  const stateRoot = await mkdtemp(
    path.join(tmpdir(), "symphonika-http-local-time-test-")
  );
  tempRoots.push(stateRoot);
  const runStore = openRunStore({ stateRoot });

  try {
    runStore.createRun({
      id: "run-local-time",
      issue: {
        body: "",
        created_at: "2026-08-20T14:00:00.000Z",
        id: 544,
        labels: [],
        number: 544,
        priority: 99,
        state: "open",
        title: "Local timestamps",
        updated_at: "2026-08-20T14:00:00.000Z",
        url: ""
      },
      projectName: "symphonika",
      providerCommand: "codex",
      providerName: "codex"
    });
    runStore.updateRunState("run-local-time", "running");
    runStore.createAttempt({
      attemptNumber: 1,
      branchName: "sym/symphonika/544-local-timestamps",
      branchRef: "refs/heads/sym/symphonika/544-local-timestamps",
      id: "run-local-time-attempt-1",
      issueSnapshotPath: "",
      metadataPath: "",
      normalizedLogPath: "",
      promptPath: "",
      providerCommand: "codex",
      providerName: "codex",
      rawLogPath: "",
      runId: "run-local-time",
      state: "running",
      workflowGraphPath: "",
      workspacePath: stateRoot
    });
    runStore.recordProviderEvent({
      attemptId: "run-local-time-attempt-1",
      normalized: { message: "working", type: "message" },
      raw: { message: "working", type: "message" },
      receivedAt: new Date().toISOString(),
      runId: "run-local-time",
      sequence: 1
    });
    runStore.upsertWatchdogSample({
      idleSince: "2026-08-20T14:00:00.000Z",
      lastMessageAt: null,
      lastProgressAt: null,
      lastToolCallAt: null,
      normalizedLogOffset: 0,
      normalizedLogPath: "",
      outputTokensTotal: 0,
      runId: "run-local-time",
      sampledAt: "2026-08-20T14:01:00.000Z",
      turnIdSetSize: 0,
      workspaceDigest: "",
      workspaceMtimeMax: 0
    });
    const detail = runStore.getRun("run-local-time");
    expect(detail).toBeDefined();

    const app = createHttpApp({
      runStore,
      stateRoot,
      version: "0.1.0"
    });
    const response = await app.request("/runs/run-local-time");
    const html = await response.text();
    const browser = new Window();
    const parsed = new browser.DOMParser().parseFromString(html, "text/html");

    const started = Array.from(
      parsed.querySelectorAll("time[data-local-time]")
    ).find((element) => element.getAttribute("datetime") === detail?.createdAt);
    expect(started?.textContent).toBe(detail?.createdAt);
    expect(unwrappedIsoTimestamps(parsed)).toEqual([]);

    const script = parsed.querySelector(
      "script[data-local-time-client]"
    )?.textContent;
    expect(script).toBeDefined();
    vi.spyOn(Date.prototype, "toLocaleString").mockReturnValue(
      "8/20/2026, 4:00:00 PM"
    );

    // Execute the exact progressive-enhancement source returned by the
    // public HTTP page, as a browser would at the end of <body>.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
    new Function("document", "MutationObserver", script ?? "")(
      parsed,
      browser.MutationObserver
    );

    expect(started?.textContent).toBe("8/20/2026, 4:00:00 PM");
    expect(started?.getAttribute("datetime")).toBe(detail?.createdAt);

    const runsHtml = await (await app.request("/runs")).text();
    const runsPage = new browser.DOMParser().parseFromString(
      runsHtml,
      "text/html"
    );
    expect(unwrappedIsoTimestamps(runsPage)).toEqual([]);

    const liveFragment = parsed.createElement("div");
    parsed.body.append(liveFragment);
    liveFragment.innerHTML = await (
      await app.request("/fragments/active-band")
    ).text();
    const liveStarted = Array.from(
      liveFragment.querySelectorAll("time[data-local-time]")
    ).find((element) => element.getAttribute("datetime") === detail?.createdAt);
    await vi.waitFor(() => {
      expect(liveStarted?.textContent).toBe("8/20/2026, 4:00:00 PM");
    });
  } finally {
    runStore.close();
  }
});

it("renders Routine and Firing timestamps through the same local-time enhancement", async () => {
  const stateRoot = await mkdtemp(
    path.join(tmpdir(), "symphonika-http-routine-local-time-test-")
  );
  tempRoots.push(stateRoot);
  const runStore = openRunStore({ stateRoot });

  try {
    runStore.syncRoutines([
      {
        kind: "report",
        name: "local-time-audit",
        prompt: "Audit local timestamp rendering.",
        provider: "codex",
        projectName: "symphonika",
        schedule: { at: "2026-08-20T16:00:00.000Z" },
        sourcePath: "/tmp/local-time-audit.md"
      }
    ]);
    runStore.createRoutineFiring({
      id: "firing-local-time",
      projectName: "symphonika",
      providerCommand: "codex",
      providerName: "codex",
      routineName: "local-time-audit",
      scheduledAt: "2026-08-20T16:00:00.000Z"
    });
    runStore.updateRoutineFiringState("firing-local-time", "running");

    const app = createHttpApp({
      runStore,
      stateRoot,
      version: "0.1.0"
    });
    const browser = new Window();

    for (const route of [
      "/",
      "/routines/local-time-audit",
      "/firings/firing-local-time"
    ]) {
      const response = await app.request(route);
      expect(response.status).toBe(200);
      const page = new browser.DOMParser().parseFromString(
        await response.text(),
        "text/html"
      );
      expect(unwrappedIsoTimestamps(page), route).toEqual([]);
    }
  } finally {
    runStore.close();
  }
});
