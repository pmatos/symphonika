import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { promises as fsPromises } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
  it("cancels clone and fetch helper process trees without poisoning the shared cache", async () => {
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
    const helperPidPath = path.join(root, "ssh-pid");
    const passthroughPath = path.join(root, "ssh-passthrough");
    await writeFile(
      sshPath,
      `#!/bin/sh
if [ -f "${passthroughPath}" ]; then
  for candidate in "$@"; do
    command="$candidate"
  done
  exec /bin/sh -c "$command"
fi
echo $$ > "${helperPidPath}"
touch "${startedPath}"
trap '' TERM
while true; do
  sleep 1
done
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
      const cloneHelperPid = await readPid(helperPidPath);
      controller.abort();

      const error = await settleWithin(preparation, 2_000);
      expect(error).toMatchObject({ code: "ABORT_ERR", name: "AbortError" });
      await waitForProcessExit(cloneHelperPid);
      await expect(pathExists(cachePath)).resolves.toBe(false);
      await expect(pathExists(workspacePath)).resolves.toBe(false);

      await writeFile(passthroughPath, "enabled\n");
      const prepared = await prepareRoutineWorkspace(input);
      expect(prepared.reused).toBe(false);
      await expect(
        git(["-C", prepared.workspacePath, "rev-parse", "--abbrev-ref", "HEAD"])
      ).resolves.toBe(prepared.branchName);

      await rm(startedPath, { force: true });
      await rm(helperPidPath, { force: true });
      await rm(passthroughPath, { force: true });
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
      const fetchHelperPid = await readPid(helperPidPath);
      fetchController.abort();

      const fetchError = await settleWithin(interruptedFetch, 2_000);
      expect(fetchError).toMatchObject({
        code: "ABORT_ERR",
        name: "AbortError"
      });
      await waitForProcessExit(fetchHelperPid);
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

      await writeFile(passthroughPath, "enabled\n");
      const recovered = await prepareRoutineWorkspace({
        ...fetchInput,
        firingId: "01LABCDEFGHJKMNPQRSTVWXYZ12"
      });
      expect(recovered.reused).toBe(false);
    } finally {
      await killRecordedProcess(helperPidPath);
      if (previousGitSshCommand === undefined) {
        delete process.env.GIT_SSH_COMMAND;
      } else {
        process.env.GIT_SSH_COMMAND = previousGitSshCommand;
      }
    }
  });

  it("treats a zombie-only Git process group as stopped after escalation", async () => {
    const root = await makeTempRoot();
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const wrapperRoot = path.join(root, "git-wrapper");
    const wrapperPath = path.join(wrapperRoot, "git");
    const startedPath = path.join(root, "clone-started");
    const helperPidPath = path.join(root, "clone-pid");
    const { stdout: realGitOutput } = await execFileAsync("which", ["git"]);
    await mkdir(wrapperRoot, { recursive: true });
    await writeFile(
      wrapperPath,
      `#!/bin/sh
if [ "$1" = "clone" ]; then
  echo $$ > "${helperPidPath}"
  touch "${startedPath}"
  trap '' TERM
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
    const originalKill = process.kill.bind(process);

    try {
      const preparation = rejectionOf(
        prepareRoutineWorkspace({
          configDir: root,
          firingId: "01JABCDEFGHJKMNPQRSTVWXYZ12",
          kind: "git",
          project: {
            name: "alpha",
            workspace: {
              git: { base_branch: "main", remote: path.join(root, "remote") },
              root: workspaceRoot
            }
          },
          routineName: "dependency-update",
          signal: controller.signal
        })
      );
      await waitForPath(startedPath);
      const helperPid = await readPid(helperPidPath);
      let groupWasKilled = false;
      process.kill = (pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === -helperPid && signal === "SIGKILL") {
          groupWasKilled = true;
        }
        if (pid === -helperPid && signal === 0 && groupWasKilled) {
          // Linux kill(2) continues to report a process group whose only
          // remaining member is a zombie. Simulate that kernel probe while
          // the real group has already stopped so the assertion is stable on
          // hosts whose PID 1 eagerly reaps orphaned helpers.
          return true;
        }
        return signal === undefined
          ? originalKill(pid)
          : originalKill(pid, signal);
      };
      controller.abort();

      const error = await settleWithin(preparation, 2_000);
      expect(error).toMatchObject({ code: "ABORT_ERR", name: "AbortError" });
    } finally {
      process.kill = originalKill;
      await killRecordedProcess(helperPidPath);
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  it("surfaces failed Git process-group shutdown as a cleanup error", async () => {
    const root = await makeTempRoot();
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const wrapperRoot = path.join(root, "git-wrapper");
    const wrapperPath = path.join(wrapperRoot, "git");
    const startedPath = path.join(root, "clone-started");
    const helperPidPath = path.join(root, "clone-pid");
    const { stdout: realGitOutput } = await execFileAsync("which", ["git"]);
    await mkdir(wrapperRoot, { recursive: true });
    await writeFile(
      wrapperPath,
      `#!/bin/sh
if [ "$1" = "clone" ]; then
  echo $$ > "${helperPidPath}"
  touch "${startedPath}"
  while true; do
    sleep 0.1
  done
fi
exec "${realGitOutput.trim()}" "$@"
`
    );
    await chmod(wrapperPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${wrapperRoot}:${previousPath ?? ""}`;
    const controller = new AbortController();
    const originalKill = process.kill.bind(process);

    try {
      const preparation = rejectionOf(
        prepareRoutineWorkspace({
          configDir: root,
          firingId: "01JABCDEFGHJKMNPQRSTVWXYZ12",
          kind: "git",
          project: {
            name: "alpha",
            workspace: {
              git: { base_branch: "main", remote: path.join(root, "remote") },
              root: workspaceRoot
            }
          },
          routineName: "dependency-update",
          signal: controller.signal
        })
      );
      await waitForPath(startedPath);
      const helperPid = await readPid(helperPidPath);
      process.kill = (pid: number, signal?: NodeJS.Signals | number) => {
        if (pid === -helperPid && signal === "SIGTERM") {
          throw Object.assign(new Error("group signaling denied"), {
            code: "EPERM"
          });
        }
        return signal === undefined
          ? originalKill(pid)
          : originalKill(pid, signal);
      };
      controller.abort();

      const error = await settleWithin(preparation, 2_000);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) {
        throw new Error("expected group cleanup to reject with an Error");
      }
      expect(error.name).toBe("WorkspacePreparationCleanupError");
      expect(error.message).toContain(
        "failed to stop aborted Git process group"
      );
    } finally {
      process.kill = originalKill;
      await killRecordedProcess(helperPidPath);
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  it("preserves the process umask on an atomically published cache", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const previousUmask = process.umask(0o002);

    try {
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

      const cache = await stat(prepared.cachePath);
      expect(cache.mode & 0o777).toBe(0o775);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("removes its owned clone staging directory when mode adjustment fails", async () => {
    const root = await makeTempRoot();
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const cacheParent = path.join(workspaceRoot, ".cache");
    const originalChmod = fsPromises.chmod;
    fsPromises.chmod = async (filePath, mode) => {
      if (String(filePath).includes(".repo.git.clone-")) {
        throw Object.assign(new Error("chmod is unsupported"), {
          code: "ENOTSUP"
        });
      }
      await originalChmod(filePath, mode);
    };
    syncBuiltinESMExports();

    try {
      await expect(
        prepareRoutineWorkspace({
          configDir: root,
          firingId: "01JABCDEFGHJKMNPQRSTVWXYZ12",
          kind: "git",
          project: {
            name: "alpha",
            workspace: {
              git: { base_branch: "main", remote: path.join(root, "remote") },
              root: workspaceRoot
            }
          },
          routineName: "dependency-update"
        })
      ).rejects.toThrow("chmod is unsupported");
      await expect(readdir(cacheParent)).resolves.toEqual([]);
    } finally {
      fsPromises.chmod = originalChmod;
      syncBuiltinESMExports();
    }
  });

  it("surfaces failed cleanup of an aborted clone staging directory", async () => {
    const root = await makeTempRoot();
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const wrapperRoot = path.join(root, "git-wrapper");
    const wrapperPath = path.join(wrapperRoot, "git");
    const startedPath = path.join(root, "clone-started");
    const helperPidPath = path.join(root, "clone-pid");
    const { stdout: realGitOutput } = await execFileAsync("which", ["git"]);
    await mkdir(wrapperRoot, { recursive: true });
    await writeFile(
      wrapperPath,
      `#!/bin/sh
if [ "$1" = "clone" ]; then
  echo $$ > "${helperPidPath}"
  touch "${startedPath}"
  trap '' TERM
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
    const originalRm = fsPromises.rm;

    try {
      const preparation = rejectionOf(
        prepareRoutineWorkspace({
          configDir: root,
          firingId: "01JABCDEFGHJKMNPQRSTVWXYZ12",
          kind: "git",
          project: {
            name: "alpha",
            workspace: {
              git: { base_branch: "main", remote: path.join(root, "remote") },
              root: workspaceRoot
            }
          },
          routineName: "dependency-update",
          signal: controller.signal
        })
      );
      await waitForPath(startedPath);
      fsPromises.rm = async (filePath, options) => {
        if (String(filePath).includes(".repo.git.clone-")) {
          throw Object.assign(new Error("staging removal denied"), {
            code: "EACCES"
          });
        }
        await originalRm(filePath, options);
      };
      syncBuiltinESMExports();
      controller.abort();

      const error = await settleWithin(preparation, 2_500);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) {
        throw new Error("expected staging cleanup to reject with an Error");
      }
      expect(error.name).toBe("WorkspacePreparationCleanupError");
      expect(error.message).toContain(
        "failed to clean repository cache staging directory"
      );
    } finally {
      fsPromises.rm = originalRm;
      syncBuiltinESMExports();
      await killRecordedProcess(helperPidPath);
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  it("removes a firing-owned branch when branch creation is aborted after the ref is written", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const cachePath = path.join(workspaceRoot, ".cache", "repo.git");
    const branchRef =
      "refs/heads/sym/alpha/routine/dependency-update/01JABCDEFG";
    const wrapperRoot = path.join(root, "git-wrapper");
    const wrapperPath = path.join(wrapperRoot, "git");
    const startedPath = path.join(root, "branch-started");
    const helperPidPath = path.join(root, "branch-pid");
    const { stdout: realGitOutput } = await execFileAsync("which", ["git"]);
    await mkdir(wrapperRoot, { recursive: true });
    await writeFile(
      wrapperPath,
      `#!/bin/sh
if [ "$3" = "branch" ]; then
  "${realGitOutput.trim()}" "$@"
  echo $$ > "${helperPidPath}"
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

    try {
      const preparation = rejectionOf(
        prepareRoutineWorkspace({
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
          routineName: "dependency-update",
          signal: controller.signal
        })
      );
      await waitForPath(startedPath);
      controller.abort();

      const error = await settleWithin(preparation, 2_000);
      expect(error).toMatchObject({ code: "ABORT_ERR", name: "AbortError" });
      await expect(
        git(["-C", cachePath, "show-ref", "--verify", branchRef])
      ).rejects.toThrow();
    } finally {
      await killRecordedProcess(helperPidPath);
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  it("removes only the firing-owned worktree and branch when creation is aborted", async () => {
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
    const helperPidPath = path.join(root, "worktree-pid");
    const { stdout: realGitOutput } = await execFileAsync("which", ["git"]);
    await mkdir(wrapperRoot, { recursive: true });
    await writeFile(
      wrapperPath,
      `#!/bin/sh
if [ "$5" = "${workspacePath}" ]; then
  mkdir -p "${workspacePath}"
  echo $$ > "${helperPidPath}"
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
      const helperPid = await readPid(helperPidPath);
      const timeoutReason = Object.assign(new Error("firing timed out"), {
        name: "RoutineFiringTimeoutError"
      });
      controller.abort(timeoutReason);

      const error = await settleWithin(preparation, 2_000);
      expect(error).toMatchObject({ code: "ABORT_ERR", name: "AbortError" });
      await waitForProcessExit(helperPid);
      await expect(pathExists(workspacePath)).resolves.toBe(false);
      await expect(pathExists(existing.workspacePath)).resolves.toBe(true);
      await expect(
        git([
          "-C",
          existing.cachePath,
          "show-ref",
          "--verify",
          "refs/heads/sym/alpha/routine/dependency-update/01KABCDEFG"
        ])
      ).rejects.toThrow();

      const recovered = await prepareRoutineWorkspace({
        configDir: root,
        firingId: "01LABCDEFGHJKMNPQRSTVWXYZ12",
        kind: "git",
        project,
        routineName: "dependency-update"
      });
      expect(recovered.reused).toBe(false);
    } finally {
      await killRecordedProcess(helperPidPath);
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  it("surfaces incomplete cleanup of an aborted firing-owned worktree", async () => {
    const root = await makeTempRoot();
    const remotePath = await createRemoteRepository(root);
    const workspaceRoot = path.join(root, "workspaces", "alpha");
    const firingId = "01JABCDEFGHJKMNPQRSTVWXYZ12";
    const workspacePath = path.join(
      workspaceRoot,
      "routines",
      "dependency-update",
      firingId
    );
    const wrapperRoot = path.join(root, "git-wrapper");
    const wrapperPath = path.join(wrapperRoot, "git");
    const startedPath = path.join(root, "worktree-started");
    const helperPidPath = path.join(root, "worktree-pid");
    const { stdout: realGitOutput } = await execFileAsync("which", ["git"]);
    await mkdir(wrapperRoot, { recursive: true });
    await writeFile(
      wrapperPath,
      `#!/bin/sh
if [ "$5" = "${workspacePath}" ]; then
  mkdir -p "${workspacePath}"
  echo $$ > "${helperPidPath}"
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
    const originalRm = fsPromises.rm;

    try {
      const preparation = rejectionOf(
        prepareRoutineWorkspace({
          configDir: root,
          firingId,
          kind: "git",
          project: {
            name: "alpha",
            workspace: {
              git: { base_branch: "main", remote: remotePath },
              root: workspaceRoot
            }
          },
          routineName: "dependency-update",
          signal: controller.signal
        })
      );
      await waitForPath(startedPath);
      fsPromises.rm = async (filePath, options) => {
        if (path.resolve(String(filePath)) === path.resolve(workspacePath)) {
          throw Object.assign(new Error("worktree removal denied"), {
            code: "EACCES"
          });
        }
        await originalRm(filePath, options);
      };
      syncBuiltinESMExports();
      controller.abort();

      const error = await settleWithin(preparation, 2_000);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) {
        throw new Error("expected workspace cleanup to reject with an Error");
      }
      expect(error.message).toContain(
        "failed to clean aborted routine worktree"
      );
    } finally {
      fsPromises.rm = originalRm;
      syncBuiltinESMExports();
      await killRecordedProcess(helperPidPath);
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

async function readPid(filePath: string): Promise<number> {
  const pid = Number.parseInt(await readFile(filePath, "utf8"), 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`invalid process id in ${filePath}`);
  }
  return pid;
}

async function killRecordedProcess(filePath: string): Promise<void> {
  if (!(await pathExists(filePath))) {
    return;
  }
  const pid = await readPid(filePath);
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ESRCH")) {
      return;
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`failed to kill test process ${pid}`, { cause: error });
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const expiresAt = Date.now() + 2_000;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (isNodeErrorWithCode(error, "ESRCH")) {
        return;
      }
      throw error;
    }
    if (await processIsZombie(pid)) {
      return;
    }
    if (Date.now() >= expiresAt) {
      throw new Error(`timed out waiting for process ${pid} to exit`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

async function processIsZombie(pid: number): Promise<boolean> {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const statContents = await readFile(`/proc/${pid}/stat`, "utf8");
    const commandEnd = statContents.lastIndexOf(")");
    return statContents
      .slice(commandEnd + 1)
      .trimStart()
      .startsWith("Z ");
  } catch {
    return false;
  }
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error(`promise did not settle within ${timeoutMs}ms`));
      }, timeoutMs);
    })
  ]);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}
