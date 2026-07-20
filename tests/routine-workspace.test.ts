import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { prepareRoutineWorkspace } from "../src/routines/workspace.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-routine-workspace-")
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

describe("Routine workspace preparation", () => {
  it("creates a deterministic kind: git branch from the project base", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "alpha");

    const prepared = await prepareRoutineWorkspace({
      configDir: root,
      firingId: "01JABCDEFGHJKMNPQRSTVWXYZ12",
      kind: "git",
      project: {
        name: "alpha",
        workspace: {
          git: { base_branch: "main", remote: remotePath },
          root: workspaceRoot
        }
      },
      routineName: "dependency-update"
    });

    expect(prepared).toMatchObject({
      branchName: "sym/alpha/routine/dependency-update/01JABCDEFG",
      branchRef: "refs/heads/sym/alpha/routine/dependency-update/01JABCDEFG",
      reused: false,
      workspacePath: path.join(
        workspaceRoot,
        "routines",
        "dependency-update",
        "01JABCDEFGHJKMNPQRSTVWXYZ12"
      )
    });
    await expect(
      git(["-C", prepared.workspacePath, "rev-parse", "--abbrev-ref", "HEAD"])
    ).resolves.toBe(prepared.branchName);
    await expect(
      git(["-C", prepared.workspacePath, "show", "--no-patch", "--format=%s"])
    ).resolves.toBe("Initial commit");
  });

  it("slugifies git-ref-hostile routine names into valid branch refs", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "alpha");

    const prepared = await prepareRoutineWorkspace({
      configDir: root,
      firingId: "01JABCDEFGHJKMNPQRSTVWXYZ12",
      kind: "git",
      project: {
        name: "alpha",
        workspace: {
          git: { base_branch: "main", remote: remotePath },
          root: workspaceRoot
        }
      },
      routineName: "deps..update"
    });

    expect(prepared.branchName).toBe(
      "sym/alpha/routine/deps-update/01JABCDEFG"
    );
    expect(prepared.branchRef).toBe(
      "refs/heads/sym/alpha/routine/deps-update/01JABCDEFG"
    );
    await expect(git(["check-ref-format", prepared.branchRef])).resolves.toBe(
      ""
    );
    await expect(
      git(["-C", prepared.workspacePath, "rev-parse", "--abbrev-ref", "HEAD"])
    ).resolves.toBe(prepared.branchName);
  });
});

async function createRemoteRepository(root: string): Promise<string> {
  const remotePath = path.join(root, "remote.git");
  const seedPath = path.join(root, "seed");

  await git(["init", "--bare", remotePath]);
  await git(["init", "--initial-branch=main", seedPath]);
  await git(["-C", seedPath, "config", "user.email", "test@example.com"]);
  await git(["-C", seedPath, "config", "user.name", "Symphonika Test"]);
  await writeFile(path.join(seedPath, "README.md"), "# Symphonika\n");
  await git(["-C", seedPath, "add", "README.md"]);
  await git(["-C", seedPath, "commit", "-m", "Initial commit"]);
  await git(["-C", seedPath, "remote", "add", "origin", remotePath]);
  await git(["-C", seedPath, "push", "origin", "main"]);
  return remotePath;
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args);
  return stdout.trim();
}
