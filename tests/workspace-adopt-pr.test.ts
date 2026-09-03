import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  prepareAdoptedPrWorkspace,
  WorkspacePreparationError,
  type WorkspaceProject
} from "../src/workspace.js";
import { planWorkspacePaths } from "../src/workspace-paths.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-workspace-adopt-pr-")
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

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args);
  return stdout.trim();
}

async function createRemoteRepository(
  root: string
): Promise<{ remotePath: string; seedPath: string }> {
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
  return { remotePath, seedPath };
}

async function branchExists(
  repoPath: string,
  branchName: string
): Promise<boolean> {
  try {
    await git(["-C", repoPath, "rev-parse", "--verify", "--quiet", branchName]);
    return true;
  } catch {
    return false;
  }
}

// Creates or advances `branchName` in the seed clone with one new commit,
// pushes it to origin, and returns the new head SHA.
async function pushBranchCommit(
  seedPath: string,
  branchName: string,
  fileName: string,
  content: string
): Promise<string> {
  if (await branchExists(seedPath, branchName)) {
    await git(["-C", seedPath, "checkout", branchName]);
  } else {
    await git(["-C", seedPath, "checkout", "-b", branchName, "main"]);
  }
  await writeFile(path.join(seedPath, fileName), content);
  await git(["-C", seedPath, "add", fileName]);
  await git(["-C", seedPath, "commit", "-m", `update ${fileName}`]);
  await git(["-C", seedPath, "push", "origin", branchName]);
  const sha = await git(["-C", seedPath, "rev-parse", "HEAD"]);
  await git(["-C", seedPath, "checkout", "main"]);
  return sha;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

function makeProject(
  remotePath: string,
  workspaceRoot: string
): WorkspaceProject {
  return {
    name: "alpha",
    workspace: {
      git: { base_branch: "main", remote: remotePath },
      root: workspaceRoot
    }
  };
}

const issue = { number: 246, title: "Fix login" };

describe("prepareAdoptedPrWorkspace (ADR-2026-09-03-1158)", () => {
  it("creates a fresh branch and worktree when the project's cache predates the PR's branch", async () => {
    const root = await makeTempRoot();
    const { remotePath, seedPath } = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const project = makeProject(remotePath, workspaceRoot);
    const plan = planWorkspacePaths({ issue, project });

    // The cache is created (bare-cloned) BEFORE the PR branch exists on the
    // remote, so its mirror genuinely has no refs/heads/<branchName> --
    // the common "existing project, new PR" case.
    await mkdir(path.dirname(plan.cachePath), { recursive: true });
    await git(["clone", "--bare", remotePath, plan.cachePath]);
    const prSha = await pushBranchCommit(
      seedPath,
      plan.branchName,
      "login.txt",
      "fix v1\n"
    );

    const result = await prepareAdoptedPrWorkspace({
      expectedHeadSha: prSha,
      issue,
      project
    });

    expect(result.reused).toBe(false);
    expect(await git(["-C", result.workspacePath, "rev-parse", "HEAD"])).toBe(
      prSha
    );
    expect(
      await readFile(path.join(result.workspacePath, "login.txt"), "utf8")
    ).toBe("fix v1\n");
  });

  it("force-updates a stale cache-side branch ref when no worktree exists for it", async () => {
    const root = await makeTempRoot();
    const { remotePath, seedPath } = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const project = makeProject(remotePath, workspaceRoot);
    const plan = planWorkspacePaths({ issue, project });

    // The PR branch already exists on the remote when the cache is bare-
    // cloned, so the clone mirrors refs/heads/<branchName> at the OLD sha
    // -- but no worktree was ever created for it.
    await pushBranchCommit(seedPath, plan.branchName, "login.txt", "v1\n");
    await mkdir(path.dirname(plan.cachePath), { recursive: true });
    await git(["clone", "--bare", remotePath, plan.cachePath]);

    const newSha = await pushBranchCommit(
      seedPath,
      plan.branchName,
      "login.txt",
      "v2\n"
    );

    const result = await prepareAdoptedPrWorkspace({
      expectedHeadSha: newSha,
      issue,
      project
    });

    expect(result.reused).toBe(false);
    expect(
      await git(["-C", plan.cachePath, "rev-parse", plan.branchName])
    ).toBe(newSha);
    expect(await git(["-C", result.workspacePath, "rev-parse", "HEAD"])).toBe(
      newSha
    );
  });

  it("reuses an already-in-sync worktree left behind by an orphaned Run", async () => {
    const root = await makeTempRoot();
    const { remotePath, seedPath } = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const project = makeProject(remotePath, workspaceRoot);
    const sha = await pushBranchCommit(
      seedPath,
      planWorkspacePaths({ issue, project }).branchName,
      "login.txt",
      "v1\n"
    );

    // First adoption creates the worktree (git branch -f cannot force-update
    // a branch checked out in a linked worktree, so a second orphaned-Run
    // adoption must sync in place instead -- this primes that scenario).
    const first = await prepareAdoptedPrWorkspace({
      expectedHeadSha: sha,
      issue,
      project
    });
    expect(first.reused).toBe(false);

    const second = await prepareAdoptedPrWorkspace({
      expectedHeadSha: sha,
      issue,
      project
    });

    expect(second.reused).toBe(true);
    expect(second.workspacePath).toBe(first.workspacePath);
    expect(await git(["-C", second.workspacePath, "rev-parse", "HEAD"])).toBe(
      sha
    );
    expect(
      await git(["-C", second.workspacePath, "status", "--porcelain"])
    ).toBe("");
  });

  it("resets an orphaned Run's worktree to the PR's new head when the remote has moved", async () => {
    const root = await makeTempRoot();
    const { remotePath, seedPath } = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const project = makeProject(remotePath, workspaceRoot);
    const branchName = planWorkspacePaths({ issue, project }).branchName;
    const firstSha = await pushBranchCommit(
      seedPath,
      branchName,
      "login.txt",
      "v1\n"
    );

    const first = await prepareAdoptedPrWorkspace({
      expectedHeadSha: firstSha,
      issue,
      project
    });
    expect(
      await readFile(path.join(first.workspacePath, "login.txt"), "utf8")
    ).toBe("v1\n");

    const secondSha = await pushBranchCommit(
      seedPath,
      branchName,
      "login.txt",
      "v2\n"
    );

    const second = await prepareAdoptedPrWorkspace({
      expectedHeadSha: secondSha,
      issue,
      project
    });

    expect(second.reused).toBe(true);
    expect(await git(["-C", second.workspacePath, "rev-parse", "HEAD"])).toBe(
      secondSha
    );
    expect(
      await readFile(path.join(second.workspacePath, "login.txt"), "utf8")
    ).toBe("v2\n");
  });

  it("refuses with workspace_dirty rather than discarding an orphaned Run's uncommitted changes", async () => {
    const root = await makeTempRoot();
    const { remotePath, seedPath } = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const project = makeProject(remotePath, workspaceRoot);
    const sha = await pushBranchCommit(
      seedPath,
      planWorkspacePaths({ issue, project }).branchName,
      "login.txt",
      "v1\n"
    );

    const first = await prepareAdoptedPrWorkspace({
      expectedHeadSha: sha,
      issue,
      project
    });
    await writeFile(
      path.join(first.workspacePath, "login.txt"),
      "uncommitted local edit\n"
    );

    const error = await rejectionOf(
      prepareAdoptedPrWorkspace({ expectedHeadSha: sha, issue, project })
    );
    expect(error).toBeInstanceOf(WorkspacePreparationError);
    if (!(error instanceof WorkspacePreparationError)) {
      throw new Error("expected workspace preparation error");
    }
    expect(error.code).toBe("workspace_dirty");
    expect(
      await readFile(path.join(first.workspacePath, "login.txt"), "utf8")
    ).toBe("uncommitted local edit\n");
  });

  it("refuses with workspace_dirty rather than discarding an orphaned Run's unpushed local commits", async () => {
    const root = await makeTempRoot();
    const { remotePath, seedPath } = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const project = makeProject(remotePath, workspaceRoot);
    const sha = await pushBranchCommit(
      seedPath,
      planWorkspacePaths({ issue, project }).branchName,
      "login.txt",
      "v1\n"
    );

    const first = await prepareAdoptedPrWorkspace({
      expectedHeadSha: sha,
      issue,
      project
    });
    // Simulates the orphaned-Run scenario adopt-pr exists to recover: the
    // agent committed locally, then the process died before `git push` --
    // the working tree is clean, but local HEAD is now ahead of
    // origin/<branch>.
    await writeFile(
      path.join(first.workspacePath, "login.txt"),
      "unpushed local commit\n"
    );
    // The workspace worktree is created from the project's own cache clone,
    // not from seedPath, so it never inherits seedPath's local identity
    // config -- and CI runners have no global git identity configured.
    await git([
      "-C",
      first.workspacePath,
      "config",
      "user.email",
      "test@example.com"
    ]);
    await git([
      "-C",
      first.workspacePath,
      "config",
      "user.name",
      "Symphonika Test"
    ]);
    await git(["-C", first.workspacePath, "add", "login.txt"]);
    await git(["-C", first.workspacePath, "commit", "-m", "unpushed work"]);
    const unpushedSha = await git([
      "-C",
      first.workspacePath,
      "rev-parse",
      "HEAD"
    ]);

    const error = await rejectionOf(
      prepareAdoptedPrWorkspace({ expectedHeadSha: sha, issue, project })
    );
    expect(error).toBeInstanceOf(WorkspacePreparationError);
    if (!(error instanceof WorkspacePreparationError)) {
      throw new Error("expected workspace preparation error");
    }
    expect(error.code).toBe("workspace_dirty");
    expect(await git(["-C", first.workspacePath, "rev-parse", "HEAD"])).toBe(
      unpushedSha
    );
  });

  it("refuses with head_mismatch when expectedHeadSha does not match the fetched remote head", async () => {
    const root = await makeTempRoot();
    const { remotePath, seedPath } = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const project = makeProject(remotePath, workspaceRoot);
    await pushBranchCommit(
      seedPath,
      planWorkspacePaths({ issue, project }).branchName,
      "login.txt",
      "v1\n"
    );

    const staleSha = "0".repeat(40);
    const error = await rejectionOf(
      prepareAdoptedPrWorkspace({ expectedHeadSha: staleSha, issue, project })
    );
    expect(error).toBeInstanceOf(WorkspacePreparationError);
    if (!(error instanceof WorkspacePreparationError)) {
      throw new Error("expected workspace preparation error");
    }
    expect(error.code).toBe("head_mismatch");
  });

  it("refuses with branch_conflict when the deterministic branch is checked out at a different path", async () => {
    const root = await makeTempRoot();
    const { remotePath, seedPath } = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const project = makeProject(remotePath, workspaceRoot);
    const plan = planWorkspacePaths({ issue, project });
    const prSha = await pushBranchCommit(
      seedPath,
      plan.branchName,
      "login.txt",
      "v1\n"
    );

    // The PR branch already exists on the remote, so the bare clone mirrors
    // it directly as refs/heads/<branchName> -- no separate `git branch`
    // needed here (see the "force-updates a stale cache-side branch ref"
    // test above for the same mirroring behavior).
    await mkdir(path.dirname(plan.cachePath), { recursive: true });
    await git(["clone", "--bare", remotePath, plan.cachePath]);
    const alternatePath = path.join(workspaceRoot, "manual", "elsewhere");
    await mkdir(path.dirname(alternatePath), { recursive: true });
    await git([
      "-C",
      plan.cachePath,
      "worktree",
      "add",
      alternatePath,
      plan.branchName
    ]);

    const error = await rejectionOf(
      prepareAdoptedPrWorkspace({ expectedHeadSha: prSha, issue, project })
    );
    expect(error).toBeInstanceOf(WorkspacePreparationError);
    if (!(error instanceof WorkspacePreparationError)) {
      throw new Error("expected workspace preparation error");
    }
    expect(error.code).toBe("branch_conflict");
    expect(error.message).toContain(alternatePath);
  });
});
