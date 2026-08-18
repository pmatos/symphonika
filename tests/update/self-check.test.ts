import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runSelfCheck } from "../../src/update/self-check.js";
import { openRunStore } from "../../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-self-check-"));
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

describe("runSelfCheck", () => {
  it("opens and migrates a fresh SQLite database at the given throwaway state root", async () => {
    const stateRoot = path.join(await makeTempRoot(), "self-check-root");

    const result = await runSelfCheck({ stateRoot });

    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("never touches a pre-existing live state root's database", async () => {
    const liveRoot = await makeTempRoot();
    const liveStore = openRunStore({ stateRoot: liveRoot });
    try {
      const throwawayRoot = path.join(await makeTempRoot(), "throwaway");

      const result = await runSelfCheck({ stateRoot: throwawayRoot });

      expect(result.ok).toBe(true);
      expect(throwawayRoot).not.toBe(liveRoot);
      // The live store's own connection is still usable -- runSelfCheck
      // opened and closed an entirely separate database, not this one.
      expect(() => liveStore.listRuns({})).not.toThrow();
    } finally {
      liveStore.close();
    }
  });
});
