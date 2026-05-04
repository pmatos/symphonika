import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  prepareIssueWorkspace,
  WorkspacePreparationError
} from "../src/workspace.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-workspace-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true })
    )
  );
});

describe("Git workspace preparation", () => {
  it("creates the repository cache, deterministic issue branch, and issue clone on first preparation", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "Sym Project");

    const prepared = await prepareIssueWorkspace({
      issue: {
        number: 6,
        title: "Prepare deterministic Git workspaces and issue branches"
      },
      project: {
        name: "Sym Project",
        workspace: {
          git: {
            base_branch: "main",
            remote: remotePath
          },
          root: workspaceRoot
        }
      }
    });

    expect(prepared).toEqual({
      branchName: "sym/sym-project/6-prepare-deterministic-git-workspaces-and-issue-branches",
      branchRef:
        "refs/heads/sym/sym-project/6-prepare-deterministic-git-workspaces-and-issue-branches",
      cachePath: path.join(workspaceRoot, ".cache", "repo.git"),
      issueDirectoryName: "6-prepare-deterministic-git-workspaces-and-issue-branches",
      reused: false,
      workspacePath: path.join(
        workspaceRoot,
        "issues",
        "6-prepare-deterministic-git-workspaces-and-issue-branches"
      )
    });
    await expect(
      git(["-C", prepared.cachePath, "show-ref", "--verify", prepared.branchRef])
    ).resolves.toContain(prepared.branchRef);
    await expect(
      git(["-C", prepared.workspacePath, "rev-parse", "--abbrev-ref", "HEAD"])
    ).resolves.toBe(prepared.branchName);
    await expect(
      git(["-C", prepared.workspacePath, "show", "--no-patch", "--format=%s"])
    ).resolves.toBe("Initial commit");
    await expect(
      stat(path.join(prepared.workspacePath, ".git")).then((s) => s.isDirectory())
    ).resolves.toBe(true);
    await expect(
      git(["-C", prepared.workspacePath, "config", "--get", "remote.origin.url"])
    ).resolves.toBe(remotePath);
    await expect(
      git(["-C", prepared.workspacePath, "rev-parse", "--show-toplevel"]).then(
        (top) => realpath(top)
      )
    ).resolves.toBe(await realpath(prepared.workspacePath));
  });

  it("reuses the deterministic issue clone and branch on later preparations", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "symphonika");
    const input = {
      issue: {
        number: 6,
        title: "Prepare deterministic Git workspaces and issue branches"
      },
      project: {
        name: "symphonika",
        workspace: {
          git: {
            base_branch: "main",
            remote: remotePath
          },
          root: workspaceRoot
        }
      }
    };

    const first = await prepareIssueWorkspace(input);
    const second = await prepareIssueWorkspace(input);

    expect(second).toEqual({
      ...first,
      reused: true
    });
    await expect(
      git(["-C", second.workspacePath, "rev-parse", "--abbrev-ref", "HEAD"])
    ).resolves.toBe(second.branchName);
  });

  it("preserves dirty issue clones during later preparations", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "symphonika");
    const input = {
      issue: {
        number: 6,
        title: "Prepare deterministic Git workspaces and issue branches"
      },
      project: {
        name: "symphonika",
        workspace: {
          git: {
            base_branch: "main",
            remote: remotePath
          },
          root: workspaceRoot
        }
      }
    };
    const first = await prepareIssueWorkspace(input);
    await writeFile(path.join(first.workspacePath, "agent-notes.txt"), "keep me\n");

    const second = await prepareIssueWorkspace(input);

    expect(second.reused).toBe(true);
    await expect(
      git(["-C", second.workspacePath, "status", "--short"])
    ).resolves.toContain("?? agent-notes.txt");
  });

  it("surfaces an occupied issue workspace path as a deterministic conflict", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "symphonika");
    const occupiedPath = path.join(
      workspaceRoot,
      "issues",
      "6-prepare-deterministic-git-workspaces-and-issue-branches"
    );
    await mkdir(occupiedPath, { recursive: true });
    await writeFile(path.join(occupiedPath, "do-not-delete.txt"), "operator state\n");

    const preparation = prepareIssueWorkspace({
      issue: {
        number: 6,
        title: "Prepare deterministic Git workspaces and issue branches"
      },
      project: {
        name: "symphonika",
        workspace: {
          git: {
            base_branch: "main",
            remote: remotePath
          },
          root: workspaceRoot
        }
      }
    });

    const error = await rejectionOf(preparation);
    expect(error).toBeInstanceOf(WorkspacePreparationError);
    if (!(error instanceof WorkspacePreparationError)) {
      throw new Error("expected workspace preparation error");
    }
    expect(error.code).toBe("workspace_conflict");
    await expect(
      git(["-C", occupiedPath, "status", "--short"])
    ).rejects.toThrow();
  });

  it("rejects an unrelated Git clone whose origin does not match the project remote", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root, "expected");
    const wrongRemotePath = await createRemoteRepository(root, "wrong");
    const workspaceRoot = path.join(root, "workspaces", "symphonika");
    const branchName =
      "sym/symphonika/6-prepare-deterministic-git-workspaces-and-issue-branches";
    const workspacePath = path.join(
      workspaceRoot,
      "issues",
      "6-prepare-deterministic-git-workspaces-and-issue-branches"
    );
    await git(["init", "--initial-branch", branchName, workspacePath]);
    await git(["-C", workspacePath, "config", "user.email", "test@example.com"]);
    await git(["-C", workspacePath, "config", "user.name", "Symphonika Test"]);
    await git(["-C", workspacePath, "remote", "add", "origin", wrongRemotePath]);
    await writeFile(path.join(workspacePath, "README.md"), "# Wrong repo\n");
    await git(["-C", workspacePath, "add", "README.md"]);
    await git(["-C", workspacePath, "commit", "-m", "Wrong repo"]);

    const preparation = prepareIssueWorkspace({
      issue: {
        number: 6,
        title: "Prepare deterministic Git workspaces and issue branches"
      },
      project: {
        name: "symphonika",
        workspace: {
          git: {
            base_branch: "main",
            remote: remotePath
          },
          root: workspaceRoot
        }
      }
    });

    const error = await rejectionOf(preparation);
    expect(error).toBeInstanceOf(WorkspacePreparationError);
    if (!(error instanceof WorkspacePreparationError)) {
      throw new Error("expected workspace preparation error");
    }
    expect(error.code).toBe("workspace_conflict");
    expect(error.message).toContain(wrongRemotePath);
    await expect(
      git(["-C", workspacePath, "show", "--no-patch", "--format=%s"])
    ).resolves.toBe("Wrong repo");
  });

  it("rejects an existing repository cache with a mismatched origin remote", async () => {
    const root = await makeTempRoot();
    const expectedRemotePath = await createRemoteRepository(root, "expected");
    const wrongRemotePath = await createRemoteRepository(root, "wrong");
    const workspaceRoot = path.join(root, "workspaces", "symphonika");
    const cachePath = path.join(workspaceRoot, ".cache", "repo.git");
    await mkdir(path.dirname(cachePath), { recursive: true });
    await git(["clone", "--bare", wrongRemotePath, cachePath]);

    const preparation = prepareIssueWorkspace({
      issue: {
        number: 6,
        title: "Prepare deterministic Git workspaces and issue branches"
      },
      project: {
        name: "symphonika",
        workspace: {
          git: {
            base_branch: "main",
            remote: expectedRemotePath
          },
          root: workspaceRoot
        }
      }
    });

    const error = await rejectionOf(preparation);
    expect(error).toBeInstanceOf(WorkspacePreparationError);
    if (!(error instanceof WorkspacePreparationError)) {
      throw new Error("expected workspace preparation error");
    }
    expect(error.code).toBe("cache_conflict");
    await expect(
      git(["-C", cachePath, "config", "--get", "remote.origin.url"])
    ).resolves.toBe(wrongRemotePath);
  });

  it("uses path-safe deterministic slugs for issue branches and clone directories", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "project");

    const prepared = await prepareIssueWorkspace({
      issue: {
        number: 42,
        title: "../Fix: Codex & Claude / workspace prep?!"
      },
      project: {
        name: "../Sym Phonika!",
        workspace: {
          git: {
            base_branch: "main",
            remote: remotePath
          },
          root: workspaceRoot
        }
      }
    });

    expect(prepared.branchName).toBe(
      "sym/sym-phonika/42-fix-codex-claude-workspace-prep"
    );
    expect(prepared.issueDirectoryName).toBe(
      "42-fix-codex-claude-workspace-prep"
    );
    expect(prepared.workspacePath).toBe(
      path.join(workspaceRoot, "issues", "42-fix-codex-claude-workspace-prep")
    );
    expect(prepared.issueDirectoryName).not.toContain("/");
    expect(prepared.issueDirectoryName).not.toContain("..");
  });

  it("keeps the agent's commit tip inside the workspace's own .git, not the cache", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "symphonika");

    const prepared = await prepareIssueWorkspace({
      issue: {
        number: 64,
        title: "Use per-issue clones not worktrees"
      },
      project: {
        name: "symphonika",
        workspace: {
          git: {
            base_branch: "main",
            remote: remotePath
          },
          root: workspaceRoot
        }
      }
    });

    await git([
      "-C",
      prepared.workspacePath,
      "config",
      "user.email",
      "agent@example.com"
    ]);
    await git([
      "-C",
      prepared.workspacePath,
      "config",
      "user.name",
      "Agent"
    ]);
    await writeFile(path.join(prepared.workspacePath, "agent-output.txt"), "work\n");
    await git(["-C", prepared.workspacePath, "add", "agent-output.txt"]);
    await git(["-C", prepared.workspacePath, "commit", "-m", "agent commit"]);

    const sha = await git(["-C", prepared.workspacePath, "rev-parse", "HEAD"]);

    await expect(
      git(["-C", prepared.workspacePath, "cat-file", "-e", sha])
    ).resolves.toBe("");
    await expect(
      git(["-C", prepared.cachePath, "cat-file", "-e", sha])
    ).rejects.toThrow();
  });

  it("supports git push -u origin <branch> against the project upstream after an agent commit", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "symphonika");

    const prepared = await prepareIssueWorkspace({
      issue: {
        number: 64,
        title: "Use per-issue clones not worktrees"
      },
      project: {
        name: "symphonika",
        workspace: {
          git: {
            base_branch: "main",
            remote: remotePath
          },
          root: workspaceRoot
        }
      }
    });

    await git(["-C", prepared.workspacePath, "config", "user.email", "agent@example.com"]);
    await git(["-C", prepared.workspacePath, "config", "user.name", "Agent"]);
    await writeFile(path.join(prepared.workspacePath, "agent-output.txt"), "work\n");
    await git(["-C", prepared.workspacePath, "add", "agent-output.txt"]);
    await git(["-C", prepared.workspacePath, "commit", "-m", "agent commit"]);
    const sha = await git(["-C", prepared.workspacePath, "rev-parse", "HEAD"]);

    await git([
      "-C",
      prepared.workspacePath,
      "push",
      "-u",
      "origin",
      prepared.branchName
    ]);

    await expect(
      git(["-C", remotePath, "rev-parse", `refs/heads/${prepared.branchName}`])
    ).resolves.toBe(sha);
  });

  it("treats `rm -rf <workspace>` as sufficient cleanup with no worktree bookkeeping to prune", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "symphonika");
    const input = {
      issue: {
        number: 64,
        title: "Use per-issue clones not worktrees"
      },
      project: {
        name: "symphonika",
        workspace: {
          git: {
            base_branch: "main",
            remote: remotePath
          },
          root: workspaceRoot
        }
      }
    };

    const first = await prepareIssueWorkspace(input);
    await rm(first.workspacePath, { recursive: true, force: true });

    const second = await prepareIssueWorkspace(input);
    expect(second.reused).toBe(false);
    expect(second.workspacePath).toBe(first.workspacePath);

    const worktreeListing = await git([
      "-C",
      first.cachePath,
      "worktree",
      "list",
      "--porcelain"
    ]);
    const worktreeLines = worktreeListing
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "));
    expect(worktreeLines).toHaveLength(1);
    expect(worktreeLines[0]).toContain(first.cachePath);
  });

  it("rejects a legacy worktree-shape workspace (.git is a gitdir file, not a directory)", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "symphonika");
    const cachePath = path.join(workspaceRoot, ".cache", "repo.git");
    const branchName =
      "sym/symphonika/64-use-per-issue-clones-not-worktrees";
    const workspacePath = path.join(
      workspaceRoot,
      "issues",
      "64-use-per-issue-clones-not-worktrees"
    );

    await mkdir(path.dirname(cachePath), { recursive: true });
    await git(["clone", "--bare", remotePath, cachePath]);
    await git(["-C", cachePath, "fetch", "origin", "main:refs/remotes/origin/main"]);
    await git(["-C", cachePath, "branch", branchName, "origin/main"]);
    await mkdir(path.dirname(workspacePath), { recursive: true });
    await git(["-C", cachePath, "worktree", "add", workspacePath, branchName]);

    const dotGitStat = await stat(path.join(workspacePath, ".git"));
    expect(dotGitStat.isDirectory()).toBe(false);

    const preparation = prepareIssueWorkspace({
      issue: {
        number: 64,
        title: "Use per-issue clones not worktrees"
      },
      project: {
        name: "symphonika",
        workspace: {
          git: {
            base_branch: "main",
            remote: remotePath
          },
          root: workspaceRoot
        }
      }
    });

    const error = await rejectionOf(preparation);
    expect(error).toBeInstanceOf(WorkspacePreparationError);
    if (!(error instanceof WorkspacePreparationError)) {
      throw new Error("expected workspace preparation error");
    }
    expect(error.code).toBe("workspace_conflict");
    expect(error.message).toContain(workspacePath);
  });
});

async function createRemoteRepository(
  root: string,
  name = "remote"
): Promise<string> {
  const remotePath = path.join(root, `${name}.git`);
  const seedPath = path.join(root, `${name}-seed`);

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

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected promise to reject");
}
