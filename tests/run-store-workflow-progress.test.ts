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

describe("RunStore workflow progress fingerprints", () => {
  it("reads back a recorded fingerprint for an edge", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.recordProgressFingerprint({ ...edge, fingerprint: "abc" });
      expect(store.readProgressFingerprint(edge)).toBe("abc");
    } finally {
      store.close();
    }
  });

  it("returns undefined for an edge that has never been taken", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.recordProgressFingerprint({ ...edge, fingerprint: "abc" });
      expect(
        store.readProgressFingerprint({ ...edge, toStateId: "merge" })
      ).toBeUndefined();
      expect(
        store.readProgressFingerprint({ ...edge, issueNumber: 43 })
      ).toBeUndefined();
      expect(
        store.readProgressFingerprint({ ...edge, projectName: "other" })
      ).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("overwrites the fingerprint in place rather than accumulating rows", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.recordProgressFingerprint({ ...edge, fingerprint: "abc" });
      store.recordProgressFingerprint({ ...edge, fingerprint: "def" });
      expect(store.readProgressFingerprint(edge)).toBe("def");
    } finally {
      store.close();
    }
  });

  it("keeps separate fingerprints per edge out of the same park state", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.recordProgressFingerprint({ ...edge, fingerprint: "abc" });
      store.recordProgressFingerprint({
        ...edge,
        fingerprint: "def",
        toStateId: "merge"
      });
      expect(store.readProgressFingerprint(edge)).toBe("abc");
      expect(
        store.readProgressFingerprint({ ...edge, toStateId: "merge" })
      ).toBe("def");
    } finally {
      store.close();
    }
  });

  it("clears every edge for one issue without touching its neighbours", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.recordProgressFingerprint({ ...edge, fingerprint: "abc" });
      store.recordProgressFingerprint({
        ...edge,
        fingerprint: "def",
        toStateId: "merge"
      });
      store.recordProgressFingerprint({
        ...edge,
        fingerprint: "ghi",
        issueNumber: 43
      });

      store.clearProgressFingerprints({
        issueNumber: 42,
        projectName: "symphonika"
      });

      expect(store.readProgressFingerprint(edge)).toBeUndefined();
      expect(
        store.readProgressFingerprint({ ...edge, toStateId: "merge" })
      ).toBeUndefined();
      expect(store.readProgressFingerprint({ ...edge, issueNumber: 43 })).toBe(
        "ghi"
      );
    } finally {
      store.close();
    }
  });
});
