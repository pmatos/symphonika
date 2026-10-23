import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  reclaimIssueWorkspace,
  reclaimRoutineWorkspace
} from "../src/workspace-reclamation.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const kinds = ["issue", "routine"] as const;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe.each(kinds)("%s workspace reclamation", (kind) => {
  it("removes dirty worktrees without touching an unrelated missing registration", async () => {
    const target = await makeWorktree(kind);
    const unrelated = path.join(target.root, "unrelated");
    await git(
      target.cachePath,
      "worktree",
      "add",
      "--detach",
      unrelated,
      "HEAD"
    );
    await rm(unrelated, { recursive: true });
    await writeFile(
      path.join(target.workspacePath, "untracked.txt"),
      "agent output"
    );

    await target.reclaim();

    await expect(access(target.workspacePath)).rejects.toThrow();
    const registrations = await git(
      target.cachePath,
      "worktree",
      "list",
      "--porcelain"
    );
    expect(registrations).not.toContain(`worktree ${target.workspacePath}\n`);
    expect(registrations).toContain(`worktree ${unrelated}\n`);
    expect(await branchExists(target.cachePath, target.branchRef)).toBe(
      kind === "issue"
    );
  });

  it.each([false, true])(
    "preserves a locked candidate and its registration (directory missing: %s)",
    async (missing) => {
      const target = await makeWorktree(kind);
      await git(target.cachePath, "worktree", "lock", target.workspacePath);
      if (missing) await rm(target.workspacePath, { recursive: true });

      await expect(target.reclaim()).rejects.toThrow(/locked/);

      expect(
        await git(target.cachePath, "worktree", "list", "--porcelain")
      ).toContain(`worktree ${target.workspacePath}\n`);
      expect(await branchExists(target.cachePath, target.branchRef)).toBe(true);
      if (!missing)
        await expect(access(target.workspacePath)).resolves.toBeUndefined();
    }
  );

  it.each(["missing", "invalid"] as const)(
    "accepts an absent planned workspace with a %s cache",
    async (cacheState) => {
      const root = await tempRoot();
      const target = plannedTarget(kind, root);
      if (cacheState === "invalid") {
        await mkdir(target.cachePath, { recursive: true });
        await writeFile(
          path.join(target.cachePath, "partial-clone"),
          "incomplete"
        );
      }
      await expect(target.reclaim()).resolves.toBeUndefined();
    }
  );

  it("retains an existing directory when the cache is unusable, preserving error precedence", async () => {
    const root = await tempRoot();
    const target = plannedTarget(kind, root);
    await mkdir(target.workspacePath, { recursive: true });
    await writeFile(path.join(target.workspacePath, "keep.txt"), "evidence");

    await expect(target.reclaim()).rejects.toThrow(
      kind === "issue" ? "worktree remove" : "worktree list"
    );
    await expect(
      access(path.join(target.workspacePath, "keep.txt"))
    ).resolves.toBeUndefined();
  });

  it("accepts an already reclaimed registration on repeated calls", async () => {
    const target = await makeWorktree(kind);
    await target.reclaim();
    await expect(target.reclaim()).resolves.toBeUndefined();
    expect(await branchExists(target.cachePath, target.branchRef)).toBe(
      kind === "issue"
    );
  });
});

describe("workspace reclamation ownership", () => {
  it("preserves branches for report and historical Routine Firings", async () => {
    for (const kind of ["report", null] as const) {
      const target = await makeWorktree("routine");
      await reclaimRoutineWorkspace({ ...target.firing, kind });
      expect(await branchExists(target.cachePath, target.branchRef)).toBe(true);
    }
  });

  it.each(["", "refs/heads/", "refs/tags/release"])(
    "does not derive a branch to delete from %j",
    async (branchRef) => {
      const target = await makeWorktree("routine");
      await reclaimRoutineWorkspace({ ...target.firing, branchRef });
      expect(await branchExists(target.cachePath, target.branchRef)).toBe(true);
    }
  );

  it("preserves a Routine branch checked out by another live worktree", async () => {
    const target = await makeWorktree("routine");
    const live = path.join(target.root, "live");
    await git(
      target.cachePath,
      "worktree",
      "add",
      "--force",
      live,
      "candidate"
    );

    await target.reclaim();

    await expect(access(target.workspacePath)).rejects.toThrow();
    await expect(access(live)).resolves.toBeUndefined();
    expect(await branchExists(target.cachePath, target.branchRef)).toBe(true);
  });

  it("refuses Issue paths outside the managed layout before invoking Git", async () => {
    const root = await tempRoot();
    const outside = path.join(root, "other", "candidate");
    await mkdir(outside, { recursive: true });
    for (const workspacePath of ["", outside]) {
      await expect(reclaimIssueWorkspace({ workspacePath })).rejects.toThrow(
        "path does not match <root>/issues/<issue-dir>"
      );
    }
    await expect(access(outside)).resolves.toBeUndefined();
  });

  it("requires the Routine name and firing id in the managed layout", async () => {
    const root = await tempRoot();
    const target = plannedTarget("routine", root);
    for (const firing of [
      { ...target.firing, workspacePath: "" },
      { ...target.firing, id: "different-id" },
      { ...target.firing, routineName: "different-name" },
      {
        ...target.firing,
        workspacePath: path.join(root, "other", "audit", "firing")
      }
    ]) {
      await expect(reclaimRoutineWorkspace(firing)).rejects.toThrow(
        "workspace path does not match <root>/routines/<routine>/<firing-id>"
      );
    }
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-reclamation-"));
  roots.push(root);
  return root;
}

function plannedTarget(kind: "issue" | "routine", root: string) {
  const workspacePath =
    kind === "issue"
      ? path.join(root, "issues", "42-candidate")
      : path.join(root, "routines", "audit", "firing");
  const firing = {
    id: "firing",
    routineName: "audit",
    kind: "git" as const,
    branchRef: "refs/heads/candidate",
    workspacePath
  };
  return {
    root,
    cachePath: path.join(root, ".cache", "repo.git"),
    workspacePath,
    branchRef: firing.branchRef,
    firing,
    reclaim: () =>
      kind === "issue"
        ? reclaimIssueWorkspace({ workspacePath })
        : reclaimRoutineWorkspace(firing)
  };
}

async function makeWorktree(kind: "issue" | "routine") {
  const root = await tempRoot();
  const target = plannedTarget(kind, root);
  await mkdir(path.dirname(target.cachePath), { recursive: true });
  await execFileAsync("git", [
    "init",
    "--bare",
    "--initial-branch=main",
    target.cachePath
  ]);
  const emptyFile = path.join(root, "empty-tree");
  await writeFile(emptyFile, "");
  const tree = await git(
    target.cachePath,
    "hash-object",
    "-w",
    "-t",
    "tree",
    emptyFile
  );
  const { stdout } = await execFileAsync("git", [
    "-C",
    target.cachePath,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit-tree",
    tree,
    "-m",
    "initial"
  ]);
  await git(target.cachePath, "update-ref", "refs/heads/main", stdout.trim());
  await git(
    target.cachePath,
    "worktree",
    "add",
    "-b",
    "candidate",
    target.workspacePath,
    "HEAD"
  );
  return target;
}

async function git(cachePath: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cachePath, ...args]);
  return stdout.trim();
}

async function branchExists(
  cachePath: string,
  branchRef: string
): Promise<boolean> {
  const refs = await git(
    cachePath,
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads/"
  );
  return refs.split("\n").includes(branchRef);
}
