import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("Git workspace preparation", () => {
  it("does not start issue-workspace Git after its Run signal is aborted", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "symphonika");
    const controller = new AbortController();
    const timeout = new Error("run timeout");
    controller.abort(timeout);

    await expect(
      prepareIssueWorkspace({
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
        },
        signal: controller.signal
      })
    ).rejects.toBe(timeout);
    await expect(
      git(["-C", path.join(workspaceRoot, ".cache", "repo.git"), "status"])
    ).rejects.toThrow();
  });

  it("creates the repository cache, deterministic issue branch, and issue worktree on first preparation", async () => {
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
      branchName:
        "sym/sym-project/6-prepare-deterministic-git-workspaces-and-issue-branches",
      branchRef:
        "refs/heads/sym/sym-project/6-prepare-deterministic-git-workspaces-and-issue-branches",
      cachePath: path.join(workspaceRoot, ".cache", "repo.git"),
      issueDirectoryName:
        "6-prepare-deterministic-git-workspaces-and-issue-branches",
      reused: false,
      workspacePath: path.join(
        workspaceRoot,
        "issues",
        "6-prepare-deterministic-git-workspaces-and-issue-branches"
      )
    });
    await expect(
      git([
        "-C",
        prepared.cachePath,
        "show-ref",
        "--verify",
        prepared.branchRef
      ])
    ).resolves.toContain(prepared.branchRef);
    await expect(
      git(["-C", prepared.workspacePath, "rev-parse", "--abbrev-ref", "HEAD"])
    ).resolves.toBe(prepared.branchName);
    await expect(
      git(["-C", prepared.workspacePath, "show", "--no-patch", "--format=%s"])
    ).resolves.toBe("Initial commit");
  });

  it("reuses the deterministic issue worktree and branch on later preparations", async () => {
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

  it("preserves dirty issue worktrees during later preparations", async () => {
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
    await writeFile(
      path.join(first.workspacePath, "agent-notes.txt"),
      "keep me\n"
    );

    const second = await prepareIssueWorkspace(input);

    expect(second.reused).toBe(true);
    await expect(
      git(["-C", second.workspacePath, "status", "--short"])
    ).resolves.toContain("?? agent-notes.txt");
  });

  it("allows a retry after the Run deadline aborts worktree creation", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "symphonika");
    const workspacePath = path.join(
      workspaceRoot,
      "issues",
      "642-clean-up-partially-created-worktrees"
    );
    const wrapperRoot = path.join(root, "git-wrapper");
    const wrapperPath = path.join(wrapperRoot, "git");
    const startedPath = path.join(root, "worktree-started");
    const interruptNextAddPath = path.join(root, "interrupt-next-add");
    const { stdout: realGitOutput } = await execFileAsync("which", ["git"]);
    await mkdir(wrapperRoot, { recursive: true });
    await writeFile(interruptNextAddPath, "interrupt\n");
    await writeFile(
      wrapperPath,
      `#!/bin/sh
if [ -f "${interruptNextAddPath}" ] && [ "$3" = "worktree" ] && [ "$4" = "add" ] && [ "$5" = "${workspacePath}" ]; then
  rm -f "${interruptNextAddPath}"
  "${realGitOutput.trim()}" "$@"
  touch "${startedPath}"
  while true; do
    sleep 1
  done
fi
exec "${realGitOutput.trim()}" "$@"
`
    );
    await chmod(wrapperPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperRoot}:${previousPath ?? ""}`;
    const controller = new AbortController();
    const input = {
      issue: {
        number: 642,
        title: "Clean up partially-created worktrees"
      },
      project: {
        name: "symphonika",
        workspace: {
          git: { base_branch: "main", remote: remotePath },
          root: workspaceRoot
        }
      }
    };

    try {
      const preparation = rejectionOf(
        prepareIssueWorkspace({
          ...input,
          signal: controller.signal
        })
      );
      await waitForPath(startedPath);
      controller.abort(new Error("run timeout"));

      await expect(preparation).resolves.toMatchObject({
        code: "ABORT_ERR",
        name: "AbortError"
      });
      await expect(pathExists(workspacePath)).resolves.toBe(false);
      await expect(
        worktreePaths(path.join(workspaceRoot, ".cache", "repo.git"))
      ).resolves.not.toContain(workspacePath);

      const recovered = await prepareIssueWorkspace(input);
      expect(recovered.reused).toBe(false);
      expect(recovered.workspacePath).toBe(workspacePath);
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
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
    await writeFile(
      path.join(occupiedPath, "do-not-delete.txt"),
      "operator state\n"
    );

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

  it("rejects an unrelated Git repository even when it has the deterministic issue branch", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "symphonika");
    const branchName =
      "sym/symphonika/6-prepare-deterministic-git-workspaces-and-issue-branches";
    const workspacePath = path.join(
      workspaceRoot,
      "issues",
      "6-prepare-deterministic-git-workspaces-and-issue-branches"
    );
    await git(["init", "--initial-branch", branchName, workspacePath]);
    await git([
      "-C",
      workspacePath,
      "config",
      "user.email",
      "test@example.com"
    ]);
    await git(["-C", workspacePath, "config", "user.name", "Symphonika Test"]);
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

  it("rejects a nested directory inside the issue branch worktree", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "symphonika");
    const cachePath = path.join(workspaceRoot, ".cache", "repo.git");
    const branchName =
      "sym/symphonika/6-prepare-deterministic-git-workspaces-and-issue-branches";
    const parentWorktreePath = path.join(workspaceRoot, "issues");
    const nestedWorkspacePath = path.join(
      parentWorktreePath,
      "6-prepare-deterministic-git-workspaces-and-issue-branches"
    );
    await mkdir(path.dirname(cachePath), { recursive: true });
    await git(["clone", "--bare", remotePath, cachePath]);
    await git([
      "-C",
      cachePath,
      "fetch",
      "origin",
      "main:refs/remotes/origin/main"
    ]);
    await git(["-C", cachePath, "branch", branchName, "origin/main"]);
    await git([
      "-C",
      cachePath,
      "worktree",
      "add",
      parentWorktreePath,
      branchName
    ]);
    await mkdir(nestedWorkspacePath);

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
      git(["-C", nestedWorkspacePath, "rev-parse", "--show-toplevel"])
    ).resolves.toBe(parentWorktreePath);
  });

  it("surfaces an issue branch checked out elsewhere as a deterministic conflict", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "symphonika");
    const cachePath = path.join(workspaceRoot, ".cache", "repo.git");
    const branchName =
      "sym/symphonika/6-prepare-deterministic-git-workspaces-and-issue-branches";
    const alternateWorktreePath = path.join(workspaceRoot, "manual", "issue-6");
    await mkdir(path.dirname(cachePath), { recursive: true });
    await git(["clone", "--bare", remotePath, cachePath]);
    await git([
      "-C",
      cachePath,
      "fetch",
      "origin",
      "main:refs/remotes/origin/main"
    ]);
    await git(["-C", cachePath, "branch", branchName, "origin/main"]);
    await mkdir(path.dirname(alternateWorktreePath), { recursive: true });
    await git([
      "-C",
      cachePath,
      "worktree",
      "add",
      alternateWorktreePath,
      branchName
    ]);

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
    expect(error.code).toBe("branch_conflict");
    expect(error.message).toContain(alternateWorktreePath);
  });

  it("uses path-safe deterministic slugs for issue branches and worktree directories", async () => {
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function waitForPath(filePath: string): Promise<void> {
  const expiresAt = Date.now() + 2_000;
  while (!(await pathExists(filePath))) {
    if (Date.now() >= expiresAt) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

async function worktreePaths(cachePath: string): Promise<string[]> {
  const output = await git([
    "-C",
    cachePath,
    "worktree",
    "list",
    "--porcelain"
  ]);
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected promise to reject");
}
