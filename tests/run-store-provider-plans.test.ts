import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";

import { databasePath, openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function openTempStore(): Promise<{ store: RunStore; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-provider-plan-"));
  tempRoots.push(root);
  return { root, store: openRunStore({ stateRoot: root }) };
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

const repository = { owner: "Acme", repo: "Widgets" };

function planInput(overrides: Record<string, unknown> = {}) {
  return {
    graphFingerprint: "sha256:graph",
    id: "plan-1",
    issueNumber: 7,
    projectName: "widgets",
    provider: "omp" as const,
    readyLabel: "agent-ready",
    repository,
    snapshotPolledAt: "2026-10-09T10:00:00.000Z",
    ...overrides
  };
}

function seedRun(
  store: RunStore,
  id: string,
  parentRunId: string | null = null
): void {
  const issue = {
    body: "",
    created_at: "2026-10-09T09:00:00Z",
    id: 7,
    labels: [],
    number: 7,
    priority: 0,
    state: "open",
    title: "Issue",
    updated_at: "2026-10-09T09:00:00Z",
    url: "https://github.com/Acme/Widgets/issues/7"
  };
  if (parentRunId === null) {
    store.createRun({
      id,
      issue,
      projectName: "widgets",
      providerCommand: "echo",
      providerName: "omp"
    });
  } else {
    store.createContinuationRun({
      id,
      issue,
      parentRunId,
      projectName: "widgets",
      providerCommand: "echo",
      providerName: "omp"
    });
  }
}

describe("RunStore provider plans", () => {
  it("persists a pending plan keyed by repository and issue", async () => {
    const { store } = await openTempStore();
    try {
      const plan = store.createProviderPlan(planInput());
      expect(plan).toMatchObject({
        attemptCount: 1,
        graphFingerprint: "sha256:graph",
        provider: "omp",
        status: "pending"
      });
      const found = store.getActiveProviderPlan({
        issueNumber: 7,
        repository: { owner: "acme", repo: "WIDGETS" }
      });
      expect(found?.id).toBe("plan-1");
      expect(
        store.getActiveProviderPlan({ issueNumber: 8, repository })
      ).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("supersedes the older live plan for the same repository issue", async () => {
    const { store } = await openTempStore();
    try {
      store.createProviderPlan(planInput());
      store.createProviderPlan(
        planInput({ id: "plan-2", provider: "codex", projectName: "alias" })
      );
      expect(store.getProviderPlan("plan-1")?.status).toBe("superseded");
      expect(
        store.getActiveProviderPlan({ issueNumber: 7, repository })?.id
      ).toBe("plan-2");
    } finally {
      store.close();
    }
  });

  it("applies label results only while the plan is still pending", async () => {
    const { store } = await openTempStore();
    try {
      store.createProviderPlan(planInput());
      expect(store.markProviderPlanLabelResult("plan-1", { ok: true })).toBe(
        true
      );
      expect(store.getProviderPlan("plan-1")?.status).toBe("label_written");
      expect(
        store.markProviderPlanLabelResult("plan-1", {
          error: "boom",
          ok: false
        })
      ).toBe(false);
      expect(store.getProviderPlan("plan-1")?.status).toBe("label_written");
    } finally {
      store.close();
    }
  });

  it("records a label failure, keeps the plan live, and reopens it for retry", async () => {
    const { store } = await openTempStore();
    try {
      store.createProviderPlan(planInput());
      expect(
        store.markProviderPlanLabelResult("plan-1", {
          error: "403 forbidden",
          ok: false
        })
      ).toBe(true);
      const failed = store.getActiveProviderPlan({
        issueNumber: 7,
        repository
      });
      expect(failed).toMatchObject({
        lastError: "403 forbidden",
        status: "label_failed"
      });
      expect(store.reopenProviderPlan("plan-1")).toBe(true);
      expect(store.getProviderPlan("plan-1")).toMatchObject({
        attemptCount: 2,
        lastError: null,
        status: "pending"
      });
      expect(store.reopenProviderPlan("plan-1")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("expires a stale pending plan lazily but never a label_written one", async () => {
    const { store } = await openTempStore();
    try {
      store.createProviderPlan(planInput());
      const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
      expect(
        store.getActiveProviderPlan({ issueNumber: 7, repository }, later)
          ?.status
      ).toBe("expired");
      expect(store.reopenProviderPlan("plan-1")).toBe(true);
      store.markProviderPlanLabelResult("plan-1", { ok: true });
      expect(
        store.getActiveProviderPlan({ issueNumber: 7, repository }, later)
          ?.status
      ).toBe("label_written");
    } finally {
      store.close();
    }
  });

  it("consumes a plan onto the chain root run and finds it from descendants", async () => {
    const { store } = await openTempStore();
    try {
      store.createProviderPlan(planInput());
      store.markProviderPlanLabelResult("plan-1", { ok: true });
      seedRun(store, "run-root");
      expect(store.consumeProviderPlan("plan-1", "run-root")).toBe(true);
      expect(store.getProviderPlan("plan-1")).toMatchObject({
        consumedRunId: "run-root",
        status: "consumed"
      });
      expect(
        store.getActiveProviderPlan({ issueNumber: 7, repository })
      ).toBeUndefined();

      seedRun(store, "run-child", "run-root");
      seedRun(store, "run-grandchild", "run-child");
      expect(store.getChainProviderPlan("run-grandchild")?.id).toBe("plan-1");
      expect(store.getChainProviderPlan("run-root")?.provider).toBe("omp");
      expect(store.consumeProviderPlan("plan-1", "run-child")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("does not consume a cancelled, expired or label_failed plan", async () => {
    const { store } = await openTempStore();
    try {
      seedRun(store, "run-a");
      store.createProviderPlan(planInput());
      expect(store.cancelProviderPlan("plan-1")).toBe(true);
      expect(store.consumeProviderPlan("plan-1", "run-a")).toBe(false);
      expect(store.getChainProviderPlan("run-a")).toBeUndefined();

      store.createProviderPlan(planInput({ id: "plan-2" }));
      store.markProviderPlanLabelResult("plan-2", { error: "x", ok: false });
      expect(store.consumeProviderPlan("plan-2", "run-a")).toBe(false);
    } finally {
      store.close();
    }
  });

  it("returns no plan for a chain that never had one", async () => {
    const { store } = await openTempStore();
    try {
      seedRun(store, "run-plain");
      expect(store.getChainProviderPlan("run-plain")).toBeUndefined();
      expect(store.getChainProviderPlan("missing")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("round-trips per-state choices and defaults to none (#862)", async () => {
    const { store } = await openTempStore();
    try {
      expect(store.createProviderPlan(planInput()).stateProviders).toEqual({});
      const plan = store.createProviderPlan(
        planInput({
          id: "plan-2",
          stateProviders: { implement: "claude", review: "codex" }
        })
      );
      expect(plan.stateProviders).toEqual({
        implement: "claude",
        review: "codex"
      });
      seedRun(store, "root");
      store.consumeProviderPlan("plan-2", "root");
      seedRun(store, "child", "root");
      expect(store.getChainProviderPlan("child")?.stateProviders).toEqual({
        implement: "claude",
        review: "codex"
      });
    } finally {
      store.close();
    }
  });

  it("records the provider source on a Run (#862)", async () => {
    const { store } = await openTempStore();
    try {
      store.createRun({
        id: "sourced",
        issue: {
          body: "",
          created_at: "2026-10-09T09:00:00Z",
          id: 7,
          labels: [],
          number: 7,
          priority: 0,
          state: "open",
          title: "Issue",
          updated_at: "2026-10-09T09:00:00Z",
          url: "https://github.com/Acme/Widgets/issues/7"
        },
        projectName: "widgets",
        providerCommand: "echo",
        providerName: "omp",
        providerSource: "operator_state"
      });
      seedRun(store, "unsourced");
      expect(store.getRun("sourced")?.providerSource).toBe("operator_state");
      expect(store.getRun("unsourced")?.providerSource).toBeNull();
    } finally {
      store.close();
    }
  });

  it.each([
    ["not json", {}],
    ['["codex"]', {}],
    ["null", {}],
    ['{"review":"codex","plan":"gpt","x":3}', { review: "codex" }]
  ])(
    "reads a hand-edited state_providers_json %s defensively (#862)",
    async (json, expected) => {
      const { store, root } = await openTempStore();
      try {
        store.createProviderPlan(planInput());
        const db = new Database(databasePath(root));
        try {
          db.prepare(
            "update run_chain_provider_plans set state_providers_json = ? where id = 'plan-1'"
          ).run(json);
        } finally {
          db.close();
        }
        expect(store.getProviderPlan("plan-1")?.stateProviders).toEqual(
          expected
        );
      } finally {
        store.close();
      }
    }
  );

  describe("recorded state definitions (#864)", () => {
    const evidence = {
      definition: {
        action: { kind: "agent", prompt: "prompts/review.md" },
        completeWhen: {},
        terminal: null,
        transitions: []
      },
      digest: "state-def-v1:sha256:abc"
    };

    function rawStateProviders(root: string, json: string): void {
      const db = new Database(databasePath(root));
      try {
        db.prepare(
          "update run_chain_provider_plans set state_providers_json = ? where id = 'plan-1'"
        ).run(json);
      } finally {
        db.close();
      }
    }

    it("round-trips a per-state choice with the definition it was made against", async () => {
      const { store } = await openTempStore();
      try {
        const plan = store.createProviderPlan(
          planInput({
            stateDefinitions: { review: evidence },
            stateProviders: { review: "codex" }
          })
        );
        expect(plan.stateProviders).toEqual({ review: "codex" });
        expect(plan.stateDefinitions).toEqual({ review: evidence });
      } finally {
        store.close();
      }
    });

    it("stores a choice with no definition in the legacy bare shape", async () => {
      const { store, root } = await openTempStore();
      try {
        store.createProviderPlan(
          planInput({ stateProviders: { review: "codex" } })
        );
        const db = new Database(databasePath(root), { readonly: true });
        try {
          expect(
            db
              .prepare(
                "select state_providers_json as json from run_chain_provider_plans"
              )
              .get()
          ).toEqual({ json: '{"review":"codex"}' });
        } finally {
          db.close();
        }
      } finally {
        store.close();
      }
    });

    it("reads a pre-#864 bare-string row as a choice with no recorded definition", async () => {
      const { store, root } = await openTempStore();
      try {
        store.createProviderPlan(planInput());
        rawStateProviders(root, '{"review":"codex"}');
        const plan = store.getProviderPlan("plan-1");
        expect(plan?.stateProviders).toEqual({ review: "codex" });
        expect(plan?.stateDefinitions).toEqual({});
      } finally {
        store.close();
      }
    });

    it.each([
      [
        '{"review":{"provider":"gpt","definitionDigest":"d","definition":{}}}',
        {}
      ],
      ['{"review":{"provider":"codex"}}', { review: "codex" }],
      ['{"review":{"definitionDigest":"d","definition":{}}}', {}],
      ['{"review":["codex"]}', {}]
    ])(
      "reads a malformed object entry %s defensively",
      async (json, expectedProviders) => {
        const { store, root } = await openTempStore();
        try {
          store.createProviderPlan(planInput());
          rawStateProviders(root, json);
          const plan = store.getProviderPlan("plan-1");
          expect(plan?.stateDefinitions).toEqual({});
          expect(plan?.stateProviders).toEqual(expectedProviders);
        } finally {
          store.close();
        }
      }
    );
  });

  it("ignores an unknown recorded provider source (#862)", async () => {
    const { store, root } = await openTempStore();
    try {
      seedRun(store, "run-odd");
      const db = new Database(databasePath(root));
      try {
        db.prepare(
          "update runs set provider_source = 'mystery' where id = 'run-odd'"
        ).run();
      } finally {
        db.close();
      }
      expect(store.getRun("run-odd")?.providerSource).toBeNull();
    } finally {
      store.close();
    }
  });

  it("survives reopening the database", async () => {
    const { store, root } = await openTempStore();
    store.createProviderPlan(planInput());
    store.close();
    const reopened = openRunStore({ stateRoot: root });
    try {
      expect(reopened.getProviderPlan("plan-1")?.status).toBe("pending");
    } finally {
      reopened.close();
    }
  });
});
