import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import { csrfTokenFor, type CsrfSecret } from "../src/http/csrf.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-routine-fire-now-test-")
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

const TEST_SECRET: CsrfSecret = randomBytes(32);
const SESSION_ID = "a".repeat(32);
const VALID_TOKEN = csrfTokenFor(TEST_SECRET, SESSION_ID);
const HOST = "127.0.0.1:4000";

function browserHeaders(
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    cookie: `sym_session=${SESSION_ID}`,
    host: HOST,
    origin: `http://${HOST}`,
    ...extra
  };
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

const VALID_DECLARATION = `---
name: audit
kind: report
schedule:
  at: "2026-05-22T10:00:00.000Z"
---
Audit the codebase.
`;

type TestSetup = {
  cleanup: () => void;
  routinePath: string;
  runStore: RunStore;
  stateRoot: string;
};

async function setup(): Promise<TestSetup> {
  const stateRoot = await makeTempRoot();
  const runStore = openRunStore({ stateRoot });
  const routinePath = path.join(stateRoot, "audit.md");
  await writeFile(routinePath, VALID_DECLARATION, "utf8");
  runStore.syncRoutines([
    {
      kind: "report",
      name: "audit",
      prompt: "Audit the codebase.",
      provider: null,
      projectName: "alpha",
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: routinePath
    }
  ]);
  return {
    cleanup: () => runStore.close(),
    routinePath,
    runStore,
    stateRoot
  };
}

async function setupFanOut(): Promise<TestSetup> {
  const stateRoot = await makeTempRoot();
  const runStore = openRunStore({ stateRoot });
  const routinePath = path.join(stateRoot, "audit.md");
  await writeFile(routinePath, VALID_DECLARATION, "utf8");
  runStore.syncRoutines([
    {
      kind: "report",
      name: "audit",
      prompt: "Audit the codebase.",
      provider: null,
      projectName: "alpha",
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: routinePath
    },
    {
      kind: "report",
      name: "audit",
      prompt: "Audit the codebase.",
      provider: null,
      projectName: "beta",
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: routinePath
    }
  ]);
  return {
    cleanup: () => runStore.close(),
    routinePath,
    runStore,
    stateRoot
  };
}

describe("routine fire-now controls (#469, ADR 0075/0069)", () => {
  it("shows a single Fire now button posting to the target's project for a single-target routine", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/routines/audit", { headers: browserHeaders() })
      ).text();
      expect(html).toContain('action="/api/routines/audit/fire?project=alpha"');
      expect(html).toContain("Fire now</button>");
      expect(html).not.toContain("Fire now — alpha");
    } finally {
      test.cleanup();
    }
  });

  it("shows one labeled Fire now button per target for a fanned-out routine", async () => {
    const test = await setupFanOut();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/routines/audit", { headers: browserHeaders() })
      ).text();
      expect(html).toContain('action="/api/routines/audit/fire?project=alpha"');
      expect(html).toContain('action="/api/routines/audit/fire?project=beta"');
      expect(html).toContain("Fire now — alpha");
      expect(html).toContain("Fire now — beta");
    } finally {
      test.cleanup();
    }
  });

  it("does not offer a Fire now button for a routine removed from config", async () => {
    const test = await setup();
    try {
      test.runStore.syncRoutines([], { projects: ["alpha"] });
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/routines/audit", { headers: browserHeaders() })
      ).text();
      expect(html).not.toContain("Fire now");
    } finally {
      test.cleanup();
    }
  });

  it("hides just the removed target's button in a fan-out, keeping the other", async () => {
    const test = await setupFanOut();
    try {
      // Removal-detection is scoped per project (ADR 0069): re-syncing with
      // only alpha's declaration, but running detection for both projects,
      // soft-disables beta's target alone.
      test.runStore.syncRoutines(
        [
          {
            kind: "report",
            name: "audit",
            prompt: "Audit the codebase.",
            provider: null,
            projectName: "alpha",
            schedule: { at: "2026-05-22T10:00:00.000Z" },
            sourcePath: test.routinePath
          }
        ],
        { projects: ["alpha", "beta"] }
      );
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/routines/audit", { headers: browserHeaders() })
      ).text();
      expect(html).toContain('action="/api/routines/audit/fire?project=alpha"');
      expect(html).not.toContain(
        'action="/api/routines/audit/fire?project=beta"'
      );
    } finally {
      test.cleanup();
    }
  });

  it("routes a fan-out target's own project through to fireRoutine", async () => {
    const test = await setupFanOut();
    try {
      const requests: unknown[] = [];
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        fireRoutine: (request) => {
          requests.push(request);
          return {
            firingId: "fire-1",
            kind: "accepted",
            projectName: "beta",
            routineName: "audit",
            state: "queued"
          };
        },
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request(
        "/api/routines/audit/fire?project=beta",
        {
          body: formBody({ csrf_token: VALID_TOKEN }),
          headers: {
            ...browserHeaders(),
            "content-type": "application/x-www-form-urlencoded"
          },
          method: "POST",
          redirect: "manual"
        }
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(
        "/routines/audit?fire=accepted&fire_project=beta"
      );
      expect(requests).toEqual([
        { force: false, projectName: "beta", routineName: "audit" }
      ]);
    } finally {
      test.cleanup();
    }
  });

  it("mentions #364's stale-declaration caveat alongside the control", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const html = await (
        await app.request("/routines/audit", { headers: browserHeaders() })
      ).text();
      expect(html).toContain("#364");
    } finally {
      test.cleanup();
    }
  });

  it.each([
    "toString",
    "constructor",
    "valueOf",
    "hasOwnProperty",
    "__proto__"
  ])(
    "falls back to the generic refusal message for an inherited-property fire_reason (%s), not a crash",
    async (reason) => {
      const test = await setup();
      try {
        const app = createHttpApp({
          csrfSecret: TEST_SECRET,
          runStore: test.runStore,
          stateRoot: test.stateRoot,
          version: "0.1.0"
        });
        const response = await app.request(
          `/routines/audit?fire=refused&fire_reason=${encodeURIComponent(reason)}`,
          { headers: browserHeaders() }
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Fire refused");
        expect(html).toContain("the routine is not currently eligible to fire");
      } finally {
        test.cleanup();
      }
    }
  );

  async function postFire(app: ReturnType<typeof createHttpApp>) {
    return app.request("/api/routines/audit/fire?project=alpha", {
      body: formBody({ csrf_token: VALID_TOKEN }),
      headers: {
        ...browserHeaders(),
        "content-type": "application/x-www-form-urlencoded"
      },
      method: "POST",
      redirect: "manual"
    });
  }

  it("redirects to /routines/:name with an accepted notice", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        fireRoutine: () => ({
          firingId: "fire-1",
          kind: "accepted",
          projectName: "alpha",
          routineName: "audit",
          state: "queued"
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await postFire(app);
      expect(response.status).toBe(303);
      const location = response.headers.get("location") ?? "";
      expect(location).toBe("/routines/audit?fire=accepted&fire_project=alpha");
      const page = await (
        await app.request(location, { headers: browserHeaders() })
      ).text();
      expect(page).toContain("Fire accepted");
      expect(page).toContain("alpha");
    } finally {
      test.cleanup();
    }
  });

  it("redirects with a refused notice naming the reason", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        fireRoutine: () => ({
          error: "concurrency cap reached",
          kind: "refused",
          reason: "concurrency_cap"
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await postFire(app);
      expect(response.status).toBe(303);
      const location = response.headers.get("location") ?? "";
      expect(location).toBe(
        "/routines/audit?fire=refused&fire_project=alpha&fire_reason=concurrency_cap"
      );
      const page = await (
        await app.request(location, { headers: browserHeaders() })
      ).text();
      expect(page).toContain("Fire refused");
      expect(page).toContain("concurrency cap");
    } finally {
      test.cleanup();
    }
  });

  it("keeps an inactive Routine reachable after a Fire now refusal", async () => {
    const test = await setup();
    try {
      test.runStore.markRoutinesInactiveForProject("alpha");
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        fireRoutine: () => ({
          error: "routine is inactive",
          kind: "refused",
          reason: "inactive"
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const detail = await (
        await app.request("/routines/audit?include_inactive=true", {
          headers: browserHeaders()
        })
      ).text();
      expect(detail).toContain(
        'action="/api/routines/audit/fire?project=alpha&amp;include_inactive=true"'
      );

      const response = await app.request(
        "/api/routines/audit/fire?project=alpha&include_inactive=true",
        {
          body: formBody({ csrf_token: VALID_TOKEN }),
          headers: {
            ...browserHeaders(),
            "content-type": "application/x-www-form-urlencoded"
          },
          method: "POST",
          redirect: "manual"
        }
      );
      expect(response.status).toBe(303);
      const location = response.headers.get("location") ?? "";
      expect(location).toContain("include_inactive=true");

      const returned = await app.request(location, {
        headers: browserHeaders()
      });
      expect(returned.status).toBe(200);
      expect(await returned.text()).toContain("Fire refused");
    } finally {
      test.cleanup();
    }
  });

  it("redirects with a not_found notice", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        fireRoutine: () => ({ error: "no such routine", kind: "not_found" }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await postFire(app);
      expect(response.status).toBe(303);
      const location = response.headers.get("location") ?? "";
      expect(location).toBe(
        "/routines/audit?fire=not_found&fire_project=alpha"
      );
      const page = await (
        await app.request(location, { headers: browserHeaders() })
      ).text();
      expect(page).toContain("Fire target not found");
    } finally {
      test.cleanup();
    }
  });

  it("redirects with an ambiguous notice", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        fireRoutine: () => ({
          candidates: [
            { projectName: "alpha", routineName: "audit" },
            { projectName: "beta", routineName: "audit" }
          ],
          error: "ambiguous",
          kind: "ambiguous"
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await postFire(app);
      expect(response.status).toBe(303);
      const page = await (
        await app.request(response.headers.get("location") ?? "", {
          headers: browserHeaders()
        })
      ).text();
      expect(page).toContain("Fire request was ambiguous");
    } finally {
      test.cleanup();
    }
  });

  it("redirects with an unavailable notice when manual firing isn't wired up", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await postFire(app);
      expect(response.status).toBe(303);
      const location = response.headers.get("location") ?? "";
      expect(location).toBe(
        "/routines/audit?fire=unavailable&fire_project=alpha"
      );
      const page = await (
        await app.request(location, { headers: browserHeaders() })
      ).text();
      expect(page).toContain("Manual firing unavailable");
    } finally {
      test.cleanup();
    }
  });

  it("still returns plain JSON, not a redirect, for a non-form caller", async () => {
    const test = await setup();
    try {
      const app = createHttpApp({
        csrfSecret: TEST_SECRET,
        fireRoutine: () => ({
          firingId: "fire-1",
          kind: "accepted",
          projectName: "alpha",
          routineName: "audit",
          state: "queued"
        }),
        runStore: test.runStore,
        stateRoot: test.stateRoot,
        version: "0.1.0"
      });
      const response = await app.request(
        "/api/routines/audit/fire?project=alpha",
        { method: "POST" }
      );
      expect(response.status).toBe(202);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.json()).toEqual({
        firingId: "fire-1",
        kind: "accepted",
        projectName: "alpha",
        routineName: "audit",
        state: "queued"
      });
    } finally {
      test.cleanup();
    }
  });
});
