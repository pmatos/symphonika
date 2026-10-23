import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import Database from "better-sqlite3";

import {
  databasePath,
  openRunStore,
  type CreateProviderInterventionInput,
  type RunStore
} from "../src/run-store.js";

const tempRoots: string[] = [];

async function openTempStore(): Promise<{ root: string; store: RunStore }> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-intervention-"));
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

function seedRun(
  store: RunStore,
  id: string,
  options: { issueNumber?: number; parentRunId?: string } = {}
): void {
  const issueNumber = options.issueNumber ?? 7;
  const issue = {
    body: "",
    created_at: "2026-10-09T09:00:00Z",
    id: issueNumber,
    labels: [],
    number: issueNumber,
    priority: 0,
    state: "open" as const,
    title: "Issue",
    updated_at: "2026-10-09T09:00:00Z",
    url: `https://github.com/Acme/Widgets/issues/${issueNumber}`
  };
  const base = {
    id,
    issue,
    projectName: "widgets",
    providerCommand: "echo",
    providerName: "codex" as const
  };
  if (options.parentRunId === undefined) {
    store.createRun(base);
  } else {
    store.createContinuationRun({
      ...base,
      parentRunId: options.parentRunId
    });
  }
}

function interventionInput(
  overrides: Partial<CreateProviderInterventionInput> = {}
): CreateProviderInterventionInput {
  return {
    fromProvider: "codex",
    fromRunId: "run-2",
    id: "int-1",
    issueNumber: 7,
    kind: "recovery",
    projectName: "widgets",
    repository: { owner: "Acme", repo: "Widgets" },
    requestedVia: "http",
    stateId: "autofix",
    toProvider: "claude",
    ...overrides
  };
}

function rows(root: string): Array<Record<string, unknown>> {
  const database = new Database(databasePath(root), { readonly: true });
  try {
    return database
      .prepare("select * from chain_provider_interventions order by rowid")
      .all() as Array<Record<string, unknown>>;
  } finally {
    database.close();
  }
}

describe("RunStore provider interventions", () => {
  it("round-trips an intervention with its chain root and survives a reopen", async () => {
    const { root, store } = await openTempStore();
    try {
      seedRun(store, "run-1");
      seedRun(store, "run-2", { parentRunId: "run-1" });
      store.createProviderIntervention(interventionInput());
    } finally {
      store.close();
    }

    const reopened = openRunStore({ stateRoot: root });
    reopened.close();
    expect(rows(root)).toMatchObject([
      {
        chain_root_run_id: "run-1",
        from_provider: "codex",
        from_run_id: "run-2",
        id: "int-1",
        issue_number: 7,
        kind: "recovery",
        last_error: null,
        outcome: "scheduled",
        repository_name: "Widgets",
        repository_owner: "Acme",
        requested_via: "http",
        state_id: "autofix",
        to_provider: "claude",
        to_run_id: null
      }
    ]);
  });

  it("settles a scheduled intervention once, by id or by from-run", async () => {
    const { root, store } = await openTempStore();
    try {
      seedRun(store, "run-1");
      store.createProviderIntervention(
        interventionInput({ fromRunId: "run-1" })
      );

      expect(
        store.settleProviderIntervention(
          { id: "int-1" },
          { outcome: "launched", toRunId: "run-2" }
        )
      ).toBe(true);
      expect(
        store.settleProviderIntervention(
          { fromRunId: "run-1", kind: "recovery" },
          { error: "late", outcome: "failed" }
        )
      ).toBe(false);
      expect(rows(root)).toMatchObject([
        { last_error: null, outcome: "launched", to_run_id: "run-2" }
      ]);

      store.createProviderIntervention(
        interventionInput({ fromRunId: "run-1", id: "int-2" })
      );
      expect(
        store.settleProviderIntervention(
          { fromRunId: "run-1", kind: "recovery" },
          { error: "provider missing", outcome: "failed", toRunId: "run-3" }
        )
      ).toBe(true);
      expect(rows(root)[1]).toMatchObject({
        last_error: "provider missing",
        outcome: "failed",
        to_run_id: "run-3"
      });
    } finally {
      store.close();
    }
  });

  it("allows one scheduled intervention per from-run and kind", async () => {
    const { store } = await openTempStore();
    try {
      seedRun(store, "run-1");
      store.createProviderIntervention(
        interventionInput({ fromRunId: "run-1" })
      );

      expect(() =>
        store.createProviderIntervention(
          interventionInput({ fromRunId: "run-1", id: "int-2" })
        )
      ).toThrow();
      expect(() =>
        store.createProviderIntervention(
          interventionInput({
            fromRunId: "run-1",
            id: "int-3",
            kind: "override_review"
          })
        )
      ).not.toThrow();

      store.settleProviderIntervention(
        { id: "int-1" },
        { error: "x", outcome: "dropped" }
      );
      expect(() =>
        store.createProviderIntervention(
          interventionInput({ fromRunId: "run-1", id: "int-4" })
        )
      ).not.toThrow();
    } finally {
      store.close();
    }
  });

  it("refuses an intervention for a Run that does not exist", async () => {
    const { store } = await openTempStore();
    try {
      expect(() =>
        store.createProviderIntervention(interventionInput())
      ).toThrow(/does not exist/);
    } finally {
      store.close();
    }
  });

  it("drops every unsettled intervention at startup and leaves settled ones", async () => {
    const { root, store } = await openTempStore();
    try {
      seedRun(store, "run-1");
      seedRun(store, "run-2", { issueNumber: 8 });
      store.createProviderIntervention(
        interventionInput({ fromRunId: "run-1" })
      );
      store.createProviderIntervention(
        interventionInput({ fromRunId: "run-2", id: "int-2" })
      );
      store.settleProviderIntervention(
        { id: "int-2" },
        { outcome: "launched", toRunId: "run-3" }
      );

      expect(store.dropUnsettledProviderInterventions("restarted")).toBe(1);
      expect(
        rows(root).map((row) => [row.id, row.outcome, row.last_error])
      ).toEqual([
        ["int-1", "dropped", "restarted"],
        ["int-2", "launched", null]
      ]);
    } finally {
      store.close();
    }
  });

  it("finds the provider a launched recovery chose, for that Run and state only", async () => {
    const { store } = await openTempStore();
    try {
      seedRun(store, "run-1");
      store.createProviderIntervention(
        interventionInput({ fromRunId: "run-1" })
      );
      expect(store.findRecoveryProvider("run-2", "autofix")).toBeUndefined();

      store.settleProviderIntervention(
        { id: "int-1" },
        { outcome: "launched", toRunId: "run-2" }
      );

      expect(store.findRecoveryProvider("run-2", "autofix")).toBe("claude");
      expect(store.findRecoveryProvider("run-2", "review")).toBeUndefined();
      expect(store.findRecoveryProvider("run-9", "autofix")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("finds the chain root and recognises only the head Run of an Issue", async () => {
    const { store } = await openTempStore();
    try {
      seedRun(store, "run-1");
      seedRun(store, "run-2", { parentRunId: "run-1" });
      seedRun(store, "run-3", { parentRunId: "run-2" });
      seedRun(store, "other-issue", { issueNumber: 9 });

      expect(store.getChainRootRunId("run-3")).toBe("run-1");
      expect(store.getChainRootRunId("run-1")).toBe("run-1");
      expect(store.getChainRootRunId("missing")).toBeUndefined();
      expect(store.isIssueHeadRun("run-3")).toBe(true);
      expect(store.isIssueHeadRun("run-2")).toBe(false);
      expect(store.isIssueHeadRun("run-1")).toBe(false);
      expect(store.isIssueHeadRun("other-issue")).toBe(true);

      seedRun(store, "run-fresh");
      expect(store.isIssueHeadRun("run-3")).toBe(false);
      expect(store.isIssueHeadRun("run-fresh")).toBe(true);
    } finally {
      store.close();
    }
  });
});
