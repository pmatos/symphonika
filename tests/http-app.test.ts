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
      candidateIssues: [],
      dispatching: false,
      filteredIssues: [],
      issuePolling: {
        errors: [],
        projects: []
      },
      service: "symphonika",
      state: "idle",
      stateRoot: "/tmp/symphonika-state",
      uptimeMs: 100
    });
  });
});
