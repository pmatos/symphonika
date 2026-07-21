import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openRunStore } from "../src/run-store.js";
import {
  renderStatusDashboard,
  renderStatusDashboardRedrawFrame
} from "../src/status-dashboard.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-dashboard-test-"));
  tempRoots.push(root);
  return root;
}

describe("renderStatusDashboard blocked runs", () => {
  it("surfaces a blocked run in the Attention and Recent sections", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.createRun({
        id: "blocked-run",
        issue: {
          body: "",
          created_at: "2026-05-13T08:00:00.000Z",
          id: 271,
          labels: ["agent-ready"],
          number: 271,
          priority: 0,
          state: "open",
          title: "Superseded by other work",
          updated_at: "2026-05-13T08:00:00.000Z",
          url: "https://github.com/pmatos/symphonika/issues/271"
        },
        projectName: "alpha",
        providerCommand: "codex fake",
        providerName: "codex"
      });
      store.recordTerminalReason(
        "blocked-run",
        "no_workspace_changes",
        "deterministic"
      );
      store.updateRunState("blocked-run", "blocked");

      const runs = store.listRuns();
      const dashboard = renderStatusDashboard({
        daemon: "running",
        issueCounts: {
          candidate: 0,
          failed: 0,
          filtered: 0,
          running: 0,
          stale: 0
        },
        lastPollOutcome: "ok",
        latestEvents: new Map(),
        projects: [],
        reload: "ok",
        runs,
        stateRoot
      });

      expect(dashboard).toContain(
        "Runs: active 0 | succeeded 0 | failed 0 | blocked 1 | cancelled 0 | total 1"
      );
      expect(dashboard).toContain("blocked-run");
      expect(dashboard).toContain("#271");
      expect(dashboard).toContain("no_workspace_changes");
    } finally {
      store.close();
    }
  });
});

describe("status dashboard watch redraw frames", () => {
  it("renders the initial frame with cursor home, line erases, and a trailing erase-to-end-of-screen", () => {
    const frame = renderStatusDashboardRedrawFrame("alpha\nbeta\n");

    expect(frame).toEqual({
      lineCount: 2,
      output: "\x1b[Halpha\x1b[K\nbeta\x1b[K\n\x1b[J"
    });
    expect(frame.output).not.toContain("\x1b[2J");
  });

  it("renders a same-height subsequent frame without trailing blank erases", () => {
    const frame = renderStatusDashboardRedrawFrame("gamma\ndelta\n", 2);

    expect(frame).toEqual({
      lineCount: 2,
      output: "\x1b[Hgamma\x1b[K\ndelta\x1b[K\n"
    });
    expect(frame.output).not.toContain("\x1b[2J");
    expect(frame.output).not.toContain("\x1b[J");
  });

  it("clears leftover rows when a subsequent frame is shorter", () => {
    const frame = renderStatusDashboardRedrawFrame("epsilon\n", 3);

    expect(frame).toEqual({
      lineCount: 1,
      output: "\x1b[Hepsilon\x1b[K\n\x1b[K\n\x1b[K\n"
    });
    expect(frame.output).not.toContain("\x1b[2J");
    expect(frame.output).not.toContain("\x1b[J");
  });
});
