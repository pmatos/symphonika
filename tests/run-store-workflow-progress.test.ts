import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openRunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-workflow-progress-")
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

const edge = {
  fromStateId: "wait_for_pr",
  issueNumber: 42,
  projectName: "symphonika",
  toStateId: "autofix"
};

describe("RunStore workflow progress claims", () => {
  it("grants a first claim and refuses a repeat on the same observation", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      expect(store.claimProgressEdge(edge, "abc")).toBe("claimed");
      expect(store.claimProgressEdge(edge, "abc")).toBe("unchanged");
      expect(store.claimProgressEdge(edge, "abc")).toBe("unchanged");
    } finally {
      store.close();
    }
  });

  it("grants again once the observation changes", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      expect(store.claimProgressEdge(edge, "abc")).toBe("claimed");
      expect(store.claimProgressEdge(edge, "def")).toBe("claimed");
      // The new observation is now the one being guarded against.
      expect(store.claimProgressEdge(edge, "def")).toBe("unchanged");
      // The superseded one is not remembered, so it reads as new again.
      expect(store.claimProgressEdge(edge, "abc")).toBe("claimed");
    } finally {
      store.close();
    }
  });

  it("tracks each edge, issue and project independently", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      expect(store.claimProgressEdge(edge, "abc")).toBe("claimed");

      // Same park, different target: its own history.
      expect(
        store.claimProgressEdge({ ...edge, toStateId: "merge" }, "abc")
      ).toBe("claimed");
      // Same edge shape, different issue.
      expect(store.claimProgressEdge({ ...edge, issueNumber: 43 }, "abc")).toBe(
        "claimed"
      );
      // Same edge shape, different project.
      expect(
        store.claimProgressEdge({ ...edge, projectName: "other" }, "abc")
      ).toBe("claimed");

      // ...and the original is still guarded.
      expect(store.claimProgressEdge(edge, "abc")).toBe("unchanged");
    } finally {
      store.close();
    }
  });

  it("clears every edge for one issue without touching its neighbours", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.claimProgressEdge(edge, "abc");
      store.claimProgressEdge({ ...edge, toStateId: "merge" }, "def");
      store.claimProgressEdge({ ...edge, issueNumber: 43 }, "ghi");

      store.clearProgressFingerprints({
        issueNumber: 42,
        projectName: "symphonika"
      });

      // Cleared history reads as never claimed.
      expect(store.claimProgressEdge(edge, "abc")).toBe("claimed");
      expect(
        store.claimProgressEdge({ ...edge, toStateId: "merge" }, "def")
      ).toBe("claimed");
      // The neighbouring issue kept its own.
      expect(store.claimProgressEdge({ ...edge, issueNumber: 43 }, "ghi")).toBe(
        "unchanged"
      );
    } finally {
      store.close();
    }
  });
});
