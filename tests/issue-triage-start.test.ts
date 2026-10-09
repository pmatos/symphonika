import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import { csrfTokenFor, type CsrfSecret } from "../src/http/csrf.js";
import type {
  ProviderStartOutcome,
  ProviderStartPreview,
  ProviderStartService
} from "../src/issues/provider-start.js";
import {
  openRunStore,
  type ProviderPlan,
  type RunStore
} from "../src/run-store.js";

const tempRoots: string[] = [];
const openStores: RunStore[] = [];

afterEach(async () => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

const TEST_SECRET: CsrfSecret = randomBytes(32);
const SESSION_ID = "a".repeat(32);
const VALID_TOKEN = csrfTokenFor(TEST_SECRET, SESSION_ID);
const HOST = "127.0.0.1:4000";
const POLLED_AT = "2026-10-09T10:00:00.000Z";

function browserHeaders(
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    "content-type": "application/x-www-form-urlencoded",
    cookie: `sym_session=${SESSION_ID}`,
    host: HOST,
    origin: `http://${HOST}`,
    ...extra
  };
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

function previewFixture(
  overrides: Partial<ProviderStartPreview> = {}
): ProviderStartPreview {
  return {
    blockers: [],
    context: {
      defaultProvider: "codex",
      graphFingerprint: "sha256:graph-a",
      providers: ["omp", "claude", "codex"],
      readyLabel: "agent-ready",
      repository: { owner: "pmatos", repo: "alpha" },
      workflowName: "default"
    },
    plan: undefined,
    ...overrides
  };
}

function planFixture(overrides: Partial<ProviderPlan> = {}): ProviderPlan {
  return {
    attemptCount: 1,
    consumedRunId: null,
    createdAt: POLLED_AT,
    graphFingerprint: "sha256:graph-a",
    id: "plan-1",
    issueNumber: 7,
    lastError: null,
    projectName: "alpha",
    provider: "omp",
    readyLabel: "agent-ready",
    repository: { owner: "pmatos", repo: "alpha" },
    snapshotPolledAt: POLLED_AT,
    status: "pending",
    updatedAt: POLLED_AT,
    ...overrides
  };
}

async function setup(preview: ProviderStartPreview | undefined) {
  const stateRoot = await mkdtemp(
    path.join(tmpdir(), "symphonika-start-http-")
  );
  tempRoots.push(stateRoot);
  const runStore = openRunStore({ stateRoot });
  openStores.push(runStore);
  runStore.syncProjectStates([
    { name: "alpha", validationState: "valid", weight: 1 }
  ]);
  runStore.replaceProjectIssueSnapshots({
    polledAt: POLLED_AT,
    projectName: "alpha",
    repository: { owner: "pmatos", repo: "alpha" },
    rows: [
      {
        blockedBy: [],
        blockedByTruncated: false,
        issueNumber: 7,
        kind: "filtered",
        labels: ["bug"],
        priority: 1,
        reasons: ["missing required label agent-ready"],
        title: "Startable issue"
      }
    ]
  });
  const ok = (): Promise<ProviderStartOutcome> =>
    Promise.resolve({
      kind: "started",
      plan: planFixture({ status: "label_written" })
    });
  const service = {
    cancel: vi.fn(() =>
      Promise.resolve<ProviderStartOutcome>({ kind: "cancelled" })
    ),
    preview: vi.fn(() => preview),
    retry: vi.fn(ok),
    start: vi.fn(ok)
  } satisfies ProviderStartService;
  const app = createHttpApp({
    csrfSecret: TEST_SECRET,
    providerStart: service,
    runStore,
    stateRoot,
    version: "0.1.0"
  });
  return { app, runStore, service, stateRoot };
}

describe("GET /issues/:project/:number/start (#861)", () => {
  it("shows fingerprint, repository identity, providers, default and a startable verdict", async () => {
    const { app } = await setup(previewFixture());
    const response = await app.request("/issues/alpha/7/start", {
      headers: browserHeaders()
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("sha256:graph-a");
    expect(html).toContain("pmatos/alpha#7");
    expect(html).toContain("startable");
    expect(html).toContain(POLLED_AT);
    expect(html).toContain('name="provider" value="omp"');
    expect(html).toContain('name="provider" value="claude"');
    expect(html).toContain('name="provider" value="codex" checked');
    expect(html).toContain("(Project default)");
    expect(html).toContain('name="graph_fingerprint" value="sha256:graph-a"');
    expect(html).toContain(`name="snapshot_polled_at" value="${POLLED_AT}"`);
    expect(html).toContain('name="snapshot_owner" value="pmatos"');
    expect(html).toContain(`name="csrf_token"`);
    expect(html).toContain("Start work");
  });

  it("lists blockers and withholds the Start form when not startable", async () => {
    const { app } = await setup(
      previewFixture({ blockers: ["blocked by open dependency #3"] })
    );
    const html = await (
      await app.request("/issues/alpha/7/start", { headers: browserHeaders() })
    ).text();

    expect(html).toContain("Cannot be started");
    expect(html).toContain("blocked by open dependency #3");
    expect(html).not.toContain("Start work");
    expect(html).not.toContain('name="provider"');
  });

  it("shows a failed plan with its error and Retry/Cancel forms", async () => {
    const { app } = await setup(
      previewFixture({
        plan: planFixture({
          lastError: "403 forbidden",
          status: "label_failed"
        })
      })
    );
    const html = await (
      await app.request("/issues/alpha/7/start", { headers: browserHeaders() })
    ).text();

    expect(html).toContain("label_failed");
    expect(html).toContain("403 forbidden");
    expect(html).toContain("/issues/alpha/7/start/retry");
    expect(html).toContain("/issues/alpha/7/start/cancel");
    expect(html).toContain('name="plan_id" value="plan-1"');
  });

  it("returns 404 for an unknown issue and when start is unavailable", async () => {
    const known = await setup(previewFixture());
    expect(
      (
        await known.app.request("/issues/alpha/999/start", {
          headers: browserHeaders()
        })
      ).status
    ).toBe(404);

    const unavailable = await setup(undefined);
    expect(
      (
        await unavailable.app.request("/issues/alpha/7/start", {
          headers: browserHeaders()
        })
      ).status
    ).toBe(404);
  });

  it("links to the preview from the issue page", async () => {
    const { app } = await setup(previewFixture());
    const html = await (
      await app.request("/issues/alpha/7", { headers: browserHeaders() })
    ).text();
    expect(html).toContain("/issues/alpha/7/start");
  });
});

describe("POST /issues/:project/:number/start (#861)", () => {
  const fields = {
    csrf_token: VALID_TOKEN,
    graph_fingerprint: "sha256:graph-a",
    provider: "omp",
    snapshot_owner: "pmatos",
    snapshot_polled_at: POLLED_AT,
    snapshot_repo: "alpha"
  };

  it("forwards the form to the service and reports success", async () => {
    const { app, service } = await setup(previewFixture());
    const response = await app.request("/issues/alpha/7/start", {
      body: formBody(fields),
      headers: browserHeaders(),
      method: "POST"
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(service.start).toHaveBeenCalledWith({
      graphFingerprint: "sha256:graph-a",
      issueNumber: 7,
      projectName: "alpha",
      provider: "omp",
      snapshotPolledAt: POLLED_AT,
      snapshotRepository: { owner: "pmatos", repo: "alpha" }
    });
    expect(html).toContain("the Ready Label was added on GitHub");
  });

  it("reports a label write failure without claiming success", async () => {
    const { app, service } = await setup(previewFixture());
    service.start.mockResolvedValueOnce({
      error: "403 forbidden",
      kind: "label_write_failed",
      plan: planFixture({ lastError: "403 forbidden", status: "label_failed" })
    });
    const html = await (
      await app.request("/issues/alpha/7/start", {
        body: formBody(fields),
        headers: browserHeaders(),
        method: "POST"
      })
    ).text();

    expect(html).toContain("The Ready Label write failed");
    expect(html).toContain("403 forbidden");
    expect(html).toContain("The Issue was not started");
    expect(html).not.toContain("the Ready Label was added on GitHub");
  });

  it("reports a refusal", async () => {
    const { app, service } = await setup(previewFixture());
    service.start.mockResolvedValueOnce({
      error: "the workflow changed since this preview was rendered",
      kind: "refused"
    });
    const html = await (
      await app.request("/issues/alpha/7/start", {
        body: formBody(fields),
        headers: browserHeaders(),
        method: "POST"
      })
    ).text();

    expect(html).toContain("Start refused");
    expect(html).toContain("workflow changed");
    expect(html).toContain("Nothing was written");
  });

  it("routes retry and cancel to their service calls", async () => {
    const { app, service } = await setup(previewFixture());
    const body = formBody({
      csrf_token: VALID_TOKEN,
      plan_id: "plan-1",
      snapshot_owner: "pmatos",
      snapshot_repo: "alpha"
    });
    await app.request("/issues/alpha/7/start/retry", {
      body,
      headers: browserHeaders(),
      method: "POST"
    });
    const cancelHtml = await (
      await app.request("/issues/alpha/7/start/cancel", {
        body,
        headers: browserHeaders(),
        method: "POST"
      })
    ).text();

    const expected = {
      issueNumber: 7,
      planId: "plan-1",
      projectName: "alpha",
      snapshotRepository: { owner: "pmatos", repo: "alpha" }
    };
    expect(service.retry).toHaveBeenCalledWith(expected);
    expect(service.cancel).toHaveBeenCalledWith(expected);
    expect(cancelHtml).toContain("Provider plan cancelled");
  });

  it.each([
    ["/issues/alpha/7/start"],
    ["/issues/alpha/7/start/retry"],
    ["/issues/alpha/7/start/cancel"]
  ])(
    "rejects %s without a valid CSRF token or from another origin",
    async (route) => {
      const { app, service } = await setup(previewFixture());
      const noToken = await app.request(route, {
        body: formBody({ ...fields, csrf_token: "bogus" }),
        headers: browserHeaders(),
        method: "POST"
      });
      const crossOrigin = await app.request(route, {
        body: formBody(fields),
        headers: browserHeaders({ origin: "http://evil.example" }),
        method: "POST"
      });

      expect(noToken.status).toBe(403);
      expect(crossOrigin.status).toBe(403);
      expect(service.start).not.toHaveBeenCalled();
      expect(service.retry).not.toHaveBeenCalled();
      expect(service.cancel).not.toHaveBeenCalled();
    }
  );
});
