import { describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";

describe("HTTP app", () => {
  it("returns daemon health details", async () => {
    const app = createHttpApp({
      stateRoot: "/tmp/symphonika-state",
      startedAtMs: 1_000,
      version: "0.1.0",
      now: () => 1_250
    });

    const response = await app.request("/health");
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      service: "symphonika",
      version: "0.1.0",
      stateRoot: "/tmp/symphonika-state",
      uptimeMs: 250
    });
  });

  it("surfaces filteredIssues carrying sym:stale in a dedicated staleIssues array", async () => {
    const baseIssue = {
      body: "",
      created_at: "2025-01-01T00:00:00Z",
      id: 1,
      number: 1,
      priority: 0,
      state: "open",
      title: "stale fixture",
      updated_at: "2025-01-01T00:00:00Z",
      url: "https://example/1"
    };
    const stale = {
      issue: { ...baseIssue, labels: ["agent-ready", "sym:claimed", "sym:stale"], number: 9 },
      project: "p",
      reasons: ["has operational label sym:stale"]
    };
    const claimed = {
      issue: { ...baseIssue, labels: ["agent-ready", "sym:claimed"], number: 10 },
      project: "p",
      reasons: ["has operational label sym:claimed"]
    };

    const app = createHttpApp({
      issuePollStatus: {
        candidateIssues: [],
        errors: [],
        filteredIssues: [stale, claimed],
        projects: []
      },
      stateRoot: "/tmp/symphonika-state",
      startedAtMs: 1_000,
      version: "0.1.0",
      now: () => 1_001
    });

    const response = await app.request("/api/status");
    const body = (await response.json()) as { staleIssues: typeof claimed[] };
    expect(body.staleIssues).toEqual([stale]);
  });

  it("reports an idle non-dispatching status", async () => {
    const app = createHttpApp({
      stateRoot: "/tmp/symphonika-state",
      startedAtMs: 2_000,
      version: "0.1.0",
      now: () => 2_100
    });

    const response = await app.request("/api/status");
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      active: [],
      candidateIssues: [],
      dispatching: false,
      filteredIssues: [],
      issuePolling: {
        errors: [],
        projects: []
      },
      runs: [],
      scheduled: [],
      service: "symphonika",
      staleIssues: [],
      state: "idle",
      stateRoot: "/tmp/symphonika-state",
      uptimeMs: 100
    });
  });
});
