import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
  it("cancels in-flight clone and fetch work without poisoning the shared cache", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const cachePath = path.join(workspaceRoot, ".cache", "repo.git");
    const workspacePath = path.join(
      workspaceRoot,
      "routines",
      "dependency-update",
      "01JABCDEFGHJKMNPQRSTVWXYZ12"
    );
    const sshPath = path.join(root, "delayed-ssh");
    const startedPath = path.join(root, "ssh-started");
    const releasePath = path.join(root, "ssh-release");
    await writeFile(
      sshPath,
      `#!/bin/sh
touch "${startedPath}"
while [ ! -f "${releasePath}" ]; do
  sleep 0.01
done
for candidate in "$@"; do
  command="$candidate"
done
exec /bin/sh -c "$command"
`
    );
    await chmod(sshPath, 0o755);
    const previousGitSshCommand = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = sshPath;
    const controller = new AbortController();
    const input = {
      configDir: root,
      firingId: "01JABCDEFGHJKMNPQRSTVWXYZ12",
      kind: "git" as const,
      project: {
        name: "alpha",
        workspace: {
          git: {
            base_branch: "main",
            remote: `ssh://test-host${remotePath}`
          },
          root: workspaceRoot
        }
      },
      routineName: "dependency-update"
    };

    try {
      const preparation = rejectionOf(
        prepareRoutineWorkspace({
          ...input,
          signal: controller.signal
        })
      );
      await waitForPath(startedPath);
      controller.abort();
      await writeFile(releasePath, "release\n");

      const error = await preparation;
      expect(error).toMatchObject({ code: "ABORT_ERR", name: "AbortError" });
      await expect(pathExists(cachePath)).resolves.toBe(false);
      await expect(pathExists(workspacePath)).resolves.toBe(false);

      const prepared = await prepareRoutineWorkspace(input);
      expect(prepared.reused).toBe(false);
      await expect(
        git(["-C", prepared.workspacePath, "rev-parse", "--abbrev-ref", "HEAD"])
      ).resolves.toBe(prepared.branchName);

      await rm(startedPath, { force: true });
      await rm(releasePath, { force: true });
      const fetchController = new AbortController();
      const fetchInput = {
        ...input,
        firingId: "01KABCDEFGHJKMNPQRSTVWXYZ12"
      };
      const interruptedFetch = rejectionOf(
        prepareRoutineWorkspace({
          ...fetchInput,
          signal: fetchController.signal
        })
      );
      await waitForPath(startedPath);
      fetchController.abort();
      await writeFile(releasePath, "release\n");

      const fetchError = await interruptedFetch;
      expect(fetchError).toMatchObject({
        code: "ABORT_ERR",
        name: "AbortError"
      });
      await expect(pathExists(cachePath)).resolves.toBe(true);
      await expect(
        pathExists(
          path.join(
            workspaceRoot,
            "routines",
            "dependency-update",
            fetchInput.firingId
          )
        )
      ).resolves.toBe(false);

      const recovered = await prepareRoutineWorkspace({
        ...fetchInput,
        firingId: "01LABCDEFGHJKMNPQRSTVWXYZ12"
      });
      expect(recovered.reused).toBe(false);
    } finally {
      await writeFile(releasePath, "release\n");
      if (previousGitSshCommand === undefined) {
        delete process.env.GIT_SSH_COMMAND;
      } else {
        process.env.GIT_SSH_COMMAND = previousGitSshCommand;
      }
    }
  });

  it("removes only the firing-owned worktree path when worktree creation is aborted", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const project = {
      name: "alpha",
      workspace: {
        git: { base_branch: "main", remote: remotePath },
        root: workspaceRoot
      }
    };
    const existing = await prepareRoutineWorkspace({
      configDir: root,
      firingId: "01JABCDEFGHJKMNPQRSTVWXYZ12",
      kind: "git",
      project,
      routineName: "dependency-update"
    });
    const firingId = "01KABCDEFGHJKMNPQRSTVWXYZ12";
    const workspacePath = path.join(
      workspaceRoot,
      "routines",
      "dependency-update",
      firingId
    );
    const wrapperRoot = path.join(root, "git-wrapper");
    const wrapperPath = path.join(wrapperRoot, "git");
    const startedPath = path.join(root, "worktree-started");
    const releasePath = path.join(root, "worktree-release");
    const { stdout: realGitOutput } = await execFileAsync("which", ["git"]);
    await mkdir(wrapperRoot, { recursive: true });
    await writeFile(
      wrapperPath,
      `#!/bin/sh
if [ "$5" = "${workspacePath}" ]; then
  mkdir -p "${workspacePath}"
  touch "${startedPath}"
  while [ ! -f "${releasePath}" ]; do
    sleep 0.01
  done
fi
exec "${realGitOutput.trim()}" "$@"
`
    );
    await chmod(wrapperPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperRoot}:${previousPath ?? ""}`;
    const controller = new AbortController();

    try {
      const preparation = rejectionOf(
        prepareRoutineWorkspace({
          configDir: root,
          firingId,
          kind: "git",
          project,
          routineName: "dependency-update",
          signal: controller.signal
        })
      );
      await waitForPath(startedPath);
      controller.abort();
      await writeFile(releasePath, "release\n");

      const error = await preparation;
      expect(error).toMatchObject({ code: "ABORT_ERR", name: "AbortError" });
      await expect(pathExists(workspacePath)).resolves.toBe(false);
      await expect(pathExists(existing.workspacePath)).resolves.toBe(true);

      const recovered = await prepareRoutineWorkspace({
        configDir: root,
        firingId: "01LABCDEFGHJKMNPQRSTVWXYZ12",
        kind: "git",
        project,
        routineName: "dependency-update"
      });
      expect(recovered.reused).toBe(false);
    } finally {
      await writeFile(releasePath, "release\n");
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  it("isolates overlapping git firings by firing id", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const project = {
      name: "alpha",
      workspace: {
        git: { base_branch: "main", remote: remotePath },
        root: workspaceRoot
      }
    };

    const first = await prepareRoutineWorkspace({
      configDir: root,
      firingId: "01JABCDEFGHJKMNPQRSTVWXYZ12",
      kind: "git",
      project,
      routineName: "dependency-update"
    });
    const second = await prepareRoutineWorkspace({
      configDir: root,
      firingId: "01KLMNOPQRJKMNPQRSTVWXYZ12",
      kind: "git",
      project,
      routineName: "dependency-update"
    });

    expect(first.workspacePath).not.toBe(second.workspacePath);
    expect(first.branchName).not.toBe(second.branchName);
    await expect(
      git(["-C", first.workspacePath, "rev-parse", "--abbrev-ref", "HEAD"])
    ).resolves.toBe(first.branchName);
    await expect(
      git(["-C", second.workspacePath, "rev-parse", "--abbrev-ref", "HEAD"])
    ).resolves.toBe(second.branchName);
  });

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
      setTimeout(resolve, 5);
    });
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}
