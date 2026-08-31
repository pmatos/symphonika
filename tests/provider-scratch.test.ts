import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createProviderScratch,
  providerScratchEnvironment,
  providerScratchPath,
  providerScratchRoot,
  removeProviderScratch,
  sweepProviderScratch
} from "../src/lifecycle/provider-scratch.js";

const tempRoots: string[] = [];

async function makeStateRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-scratch-"));
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

describe("providerScratchPath", () => {
  it("keys the directory on run id and attempt", () => {
    const scratchPath = providerScratchPath("/state", {
      attempt: 2,
      id: "run-a"
    });

    expect(scratchPath).toBe(path.resolve("/state/scratch/run-a-attempt-2"));
  });

  it("gives separate attempts of the same run separate directories", () => {
    // A retry must not inherit the previous attempt's half-written temp state.
    expect(providerScratchPath("/state", { attempt: 1, id: "run-a" })).not.toBe(
      providerScratchPath("/state", { attempt: 2, id: "run-a" })
    );
  });

  it("keeps a traversal-shaped id inside the scratch root", () => {
    const scratchPath = providerScratchPath("/state", {
      attempt: 1,
      id: "../../etc"
    });

    expect(scratchPath.startsWith(providerScratchRoot("/state"))).toBe(true);
    expect(scratchPath).not.toContain("..");
  });

  it("falls back to a placeholder segment for an id with nothing usable", () => {
    expect(providerScratchPath("/state", { attempt: 1, id: "///" })).toBe(
      path.resolve("/state/scratch/run-attempt-1")
    );
  });
});

describe("providerScratchEnvironment", () => {
  it("points TMPDIR, TMP and TEMP at the scratch directory", () => {
    expect(
      providerScratchEnvironment("/state/scratch/run-a-attempt-1")
    ).toEqual({
      TEMP: "/state/scratch/run-a-attempt-1",
      TMP: "/state/scratch/run-a-attempt-1",
      TMPDIR: "/state/scratch/run-a-attempt-1"
    });
  });

  it("sets nothing when no scratch directory was allocated", () => {
    // An unset TMPDIR must be left alone rather than blanked, so the provider
    // keeps the daemon's own inherited value.
    expect(providerScratchEnvironment(undefined)).toEqual({});
  });
});

describe("createProviderScratch / removeProviderScratch", () => {
  it("creates the directory and returns its path", async () => {
    const stateRoot = await makeStateRoot();

    const scratchPath = await createProviderScratch(stateRoot, {
      attempt: 1,
      id: "run-a"
    });

    expect(scratchPath).toBe(
      providerScratchPath(stateRoot, { attempt: 1, id: "run-a" })
    );
    expect((await stat(scratchPath)).isDirectory()).toBe(true);
  });

  it("removes the directory and everything the provider wrote into it", async () => {
    const stateRoot = await makeStateRoot();
    const scratchPath = await createProviderScratch(stateRoot, {
      attempt: 1,
      id: "run-a"
    });
    await mkdir(path.join(scratchPath, "cargo", "target"), { recursive: true });
    await writeFile(path.join(scratchPath, "cargo", "target", "big"), "x");

    await removeProviderScratch(stateRoot, { attempt: 1, id: "run-a" });

    expect(await readdir(providerScratchRoot(stateRoot))).toEqual([]);
  });

  it("removing a directory that was never created is not an error", async () => {
    const stateRoot = await makeStateRoot();

    await expect(
      removeProviderScratch(stateRoot, { attempt: 1, id: "never-ran" })
    ).resolves.toBeUndefined();
  });

  it("leaves a sibling attempt's directory intact", async () => {
    const stateRoot = await makeStateRoot();
    await createProviderScratch(stateRoot, { attempt: 1, id: "run-a" });
    await createProviderScratch(stateRoot, { attempt: 2, id: "run-a" });

    await removeProviderScratch(stateRoot, { attempt: 1, id: "run-a" });

    expect(await readdir(providerScratchRoot(stateRoot))).toEqual([
      "run-a-attempt-2"
    ]);
  });
});

describe("sweepProviderScratch", () => {
  it("removes every directory left by a previous daemon instance", async () => {
    const stateRoot = await makeStateRoot();
    await createProviderScratch(stateRoot, { attempt: 1, id: "run-a" });
    await createProviderScratch(stateRoot, { attempt: 3, id: "run-b" });

    const report = await sweepProviderScratch(stateRoot);

    expect(report.failures).toEqual([]);
    expect(report.removed).toHaveLength(2);
    expect(await readdir(providerScratchRoot(stateRoot))).toEqual([]);
  });

  it("reports nothing when the scratch root does not exist yet", async () => {
    const stateRoot = await makeStateRoot();

    const report = await sweepProviderScratch(stateRoot);

    expect(report).toEqual({ failures: [], removed: [] });
    // The sweep must not create the directory as a side effect.
    await expect(stat(providerScratchRoot(stateRoot))).rejects.toThrow();
  });

  it("leaves the scratch root itself in place", async () => {
    const stateRoot = await makeStateRoot();
    await createProviderScratch(stateRoot, { attempt: 1, id: "run-a" });

    await sweepProviderScratch(stateRoot);

    expect((await stat(providerScratchRoot(stateRoot))).isDirectory()).toBe(
      true
    );
  });
});
