import { execFile, spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  planWorkspacePaths,
  type WorkspacePathPlan
} from "./workspace-paths.js";

const execFileAsync = promisify(execFile);
const GIT_ABORT_GRACE_MS = 1_000;
const GIT_GROUP_POLL_MS = 10;
const GIT_MAX_BUFFER_BYTES = 1024 * 1024;

export type WorkspaceProject = {
  name: string;
  workspace: {
    git: {
      base_branch: string;
      remote: string;
    };
    root: string;
  };
};

type WorkspaceIssue = {
  number: number;
  title: string;
};

export type PrepareIssueWorkspaceInput = {
  configDir?: string;
  issue: WorkspaceIssue;
  project: WorkspaceProject;
  signal?: AbortSignal;
};

export type PreparedIssueWorkspace = WorkspacePathPlan & { reused: boolean };

export type WorkspacePreparationErrorCode =
  "branch_conflict" | "cache_conflict" | "workspace_conflict";

export class WorkspacePreparationError extends Error {
  readonly code: WorkspacePreparationErrorCode;

  constructor(
    code: WorkspacePreparationErrorCode,
    message: string,
    cause?: unknown
  ) {
    if (cause === undefined) {
      super(message);
    } else {
      super(message, { cause });
    }
    this.name = "WorkspacePreparationError";
    this.code = code;
  }
}

export class WorkspacePreparationCleanupError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "WorkspacePreparationCleanupError";
  }
}

export async function prepareIssueWorkspace(
  input: PrepareIssueWorkspaceInput
): Promise<PreparedIssueWorkspace> {
  const plan = planWorkspacePaths(input);

  await ensureRepositoryCache(input.project, plan.cachePath, input.signal);
  await ensureIssueBranch(
    input.project,
    plan.cachePath,
    plan.branchName,
    input.signal
  );
  if (await exists(plan.workspacePath)) {
    let currentBranch: string;
    try {
      currentBranch = await git(
        ["-C", plan.workspacePath, "rev-parse", "--abbrev-ref", "HEAD"],
        input.signal
      );
    } catch (error) {
      throw new WorkspacePreparationError(
        "workspace_conflict",
        `workspace path ${plan.workspacePath} exists but is not a reusable Git worktree for ${plan.branchName}`,
        error
      );
    }

    if (currentBranch === plan.branchName) {
      if (!(await isWorktreeRoot(plan.workspacePath, input.signal))) {
        throw new WorkspacePreparationError(
          "workspace_conflict",
          `workspace path ${plan.workspacePath} is checked out on ${plan.branchName} but is not the Git worktree root`
        );
      }

      if (
        !(await isWorktreeForCache(
          plan.workspacePath,
          plan.cachePath,
          input.signal
        ))
      ) {
        throw new WorkspacePreparationError(
          "workspace_conflict",
          `workspace path ${plan.workspacePath} is checked out on ${plan.branchName} but is not linked to cache ${plan.cachePath}`
        );
      }

      return {
        ...plan,
        reused: true
      };
    }

    throw new WorkspacePreparationError(
      "workspace_conflict",
      `workspace path ${plan.workspacePath} is already checked out on ${currentBranch}, expected ${plan.branchName}`
    );
  }

  const conflictingWorktreePath = await worktreePathForBranch(
    plan.cachePath,
    plan.branchName,
    input.signal
  );
  if (conflictingWorktreePath !== undefined) {
    throw new WorkspacePreparationError(
      "branch_conflict",
      `issue branch ${plan.branchName} is already checked out at ${conflictingWorktreePath}`
    );
  }

  await mkdir(path.dirname(plan.workspacePath), { recursive: true });
  await git(
    [
      "-C",
      plan.cachePath,
      "worktree",
      "add",
      plan.workspacePath,
      plan.branchName
    ],
    input.signal
  );

  return {
    ...plan,
    reused: false
  };
}

async function isWorktreeRoot(
  workspacePath: string,
  signal?: AbortSignal
): Promise<boolean> {
  const topLevel = await git(
    ["-C", workspacePath, "rev-parse", "--show-toplevel"],
    signal
  );
  const [actualTopLevel, expectedTopLevel] = await Promise.all([
    realpath(topLevel),
    realpath(workspacePath)
  ]);

  return actualTopLevel === expectedTopLevel;
}

async function isWorktreeForCache(
  workspacePath: string,
  cachePath: string,
  signal?: AbortSignal
): Promise<boolean> {
  const commonDirectory = await git(
    [
      "-C",
      workspacePath,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir"
    ],
    signal
  );
  const [actualCommonDirectory, expectedCommonDirectory] = await Promise.all([
    realpath(commonDirectory),
    realpath(cachePath)
  ]);

  return actualCommonDirectory === expectedCommonDirectory;
}

async function worktreePathForBranch(
  cachePath: string,
  branchName: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  const output = await git(
    ["-C", cachePath, "worktree", "list", "--porcelain"],
    signal
  );
  let currentWorktreePath: string | undefined;
  const expectedBranchLine = `branch refs/heads/${branchName}`;

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      currentWorktreePath = line.slice("worktree ".length);
      continue;
    }

    if (line === expectedBranchLine) {
      return currentWorktreePath;
    }
  }

  return undefined;
}

// Per-cache-path serialization for ensureRepositoryCache. `git fetch` on the
// same bare repo is not safe under concurrent invocations — git tries to
// create the same packed-refs.lock and one of the two fetches fails. Once a
// project sets max_in_flight > 1, two prepareIssueWorkspace calls hit the
// same cachePath, so we serialize them per-cache-path here. Per-issue
// worktree creation (the rest of prepareIssueWorkspace) remains concurrent.
// See ADR 0053.
const fetchLocks = new Map<string, Promise<unknown>>();

export async function ensureRepositoryCache(
  project: WorkspaceProject,
  cachePath: string,
  signal?: AbortSignal
): Promise<void> {
  const prior = fetchLocks.get(cachePath) ?? Promise.resolve();
  let markTurnStarted = (): void => undefined;
  const turnStarted = new Promise<void>((resolve) => {
    markTurnStarted = resolve;
  });
  const next = prior
    .catch(() => undefined)
    .then(async () => {
      markTurnStarted();
      signal?.throwIfAborted();
      if (!(await exists(cachePath))) {
        await createRepositoryCache(project, cachePath, signal);
      } else {
        await ensureRepositoryCacheRemote(project, cachePath, signal);
      }
      signal?.throwIfAborted();
      await git(
        [
          "-C",
          cachePath,
          "fetch",
          "origin",
          `${project.workspace.git.base_branch}:refs/remotes/origin/${project.workspace.git.base_branch}`
        ],
        signal
      );
    });
  fetchLocks.set(cachePath, next);
  const releaseLock = (): void => {
    // Only clear the slot if no later caller has overwritten it.
    if (fetchLocks.get(cachePath) === next) {
      fetchLocks.delete(cachePath);
    }
  };
  // Keep `next` as the serialization tail even when this caller stops
  // waiting. Once the predecessor settles, the aborted callback exits before
  // Git and then releases the tail. Clearing it at caller-abort time would let
  // a third fetch bypass a predecessor that still owns the cache.
  void next.then(releaseLock, releaseLock);
  await waitForAbortableOperation(turnStarted, signal);
  // Once this invocation owns the cache turn, await its Git process-group
  // teardown and staging-path cleanup rather than returning on signal alone.
  await next;
}

async function waitForAbortableOperation<T>(
  operation: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (signal === undefined) {
    return await operation;
  }
  signal.throwIfAborted();
  let removeAbortListener = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      const reason: unknown = signal.reason;
      reject(
        reason instanceof Error
          ? reason
          : new Error("Workspace preparation aborted", { cause: reason })
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    removeAbortListener();
  }
}

async function createRepositoryCache(
  project: WorkspaceProject,
  cachePath: string,
  signal: AbortSignal | undefined
): Promise<void> {
  const cacheParent = path.dirname(cachePath);
  await mkdir(cacheParent, { recursive: true });
  signal?.throwIfAborted();
  // The shared cache path is published only after clone completion. An
  // interrupted first clone can therefore remove its owned staging path
  // without deleting a cache that may already own live worktrees.
  const stagingPath = await mkdtemp(
    path.join(cacheParent, `.${path.basename(cachePath)}.clone-`)
  );
  let operationError: unknown;
  let operationFailed = false;
  try {
    // mkdtemp always creates its directory 0700, unlike a direct `git clone
    // --bare` into a not-yet-existing path, which follows the process umask.
    // Restore that parity before publishing, including group-sharing umasks.
    await chmod(stagingPath, 0o777 & ~process.umask());
    await git(
      ["clone", "--bare", project.workspace.git.remote, stagingPath],
      signal
    );
    signal?.throwIfAborted();
    try {
      await rename(stagingPath, cachePath);
    } catch (error) {
      if (!(await exists(cachePath))) {
        throw error;
      }
      await ensureRepositoryCacheRemote(project, cachePath, signal);
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  // A no-op after a successful rename: the staging path is already gone
  // and `force` swallows the resulting ENOENT.
  try {
    await rm(stagingPath, { force: true, recursive: true });
  } catch (cleanupError) {
    throw new WorkspacePreparationCleanupError(
      `failed to clean repository cache staging directory ${stagingPath}`,
      operationFailed
        ? new AggregateError([operationError, cleanupError])
        : cleanupError
    );
  }
  if (operationFailed) {
    throw operationError;
  }
}

async function ensureRepositoryCacheRemote(
  project: WorkspaceProject,
  cachePath: string,
  signal?: AbortSignal
): Promise<void> {
  let originUrl: string;
  try {
    originUrl = await git(
      ["-C", cachePath, "config", "--get", "remote.origin.url"],
      signal
    );
  } catch (error) {
    if (
      isAbortError(error) ||
      error instanceof WorkspacePreparationCleanupError
    ) {
      throw error;
    }
    throw new WorkspacePreparationError(
      "cache_conflict",
      `repository cache ${cachePath} is not a reusable Git repository with origin ${project.workspace.git.remote}`,
      error
    );
  }

  if (originUrl !== project.workspace.git.remote) {
    throw new WorkspacePreparationError(
      "cache_conflict",
      `repository cache ${cachePath} has origin ${originUrl}, expected ${project.workspace.git.remote}`
    );
  }
}

async function ensureIssueBranch(
  project: WorkspaceProject,
  cachePath: string,
  branchName: string,
  signal?: AbortSignal
): Promise<void> {
  if (
    await gitSucceeds(
      ["-C", cachePath, "show-ref", "--verify", `refs/heads/${branchName}`],
      signal
    )
  ) {
    return;
  }

  await git(
    [
      "-C",
      cachePath,
      "branch",
      branchName,
      `origin/${project.workspace.git.base_branch}`
    ],
    signal
  );
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export async function git(
  args: string[],
  signal?: AbortSignal
): Promise<string> {
  if (signal !== undefined && process.platform !== "win32") {
    return await gitInProcessGroup(args, signal);
  }
  const { stdout } =
    signal === undefined
      ? await execFileAsync("git", args)
      : await execFileAsync("git", args, { signal });
  return stdout.trim();
}

async function gitInProcessGroup(
  args: string[],
  signal: AbortSignal
): Promise<string> {
  const child = spawn("git", args, {
    detached: true,
    signal,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = new BoundedGitOutput();
  const stderr = new BoundedGitOutput();
  let settled = false;
  let groupShutdown: Promise<void> | undefined;
  let rejectGroupShutdownFailure: ((reason?: unknown) => void) | undefined;
  const groupShutdownFailure = new Promise<never>((_resolve, reject) => {
    rejectGroupShutdownFailure = reject;
  });
  let outputError: Error | undefined;
  const stopGroup = (): void => {
    if (!settled && groupShutdown === undefined) {
      groupShutdown = terminateGitProcessGroup(child.pid);
      void groupShutdown.catch((error: unknown) => {
        rejectGroupShutdownFailure?.(error);
      });
    }
  };
  const captureOutput = (
    stream: "stdout" | "stderr",
    output: BoundedGitOutput,
    chunk: Buffer
  ): void => {
    if (outputError !== undefined || !output.append(chunk)) {
      return;
    }
    outputError = Object.assign(
      new RangeError(`${stream} maxBuffer length exceeded`),
      {
        cmd: `git ${args.join(" ")}`,
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      }
    );
    stopGroup();
  };
  child.stdout.on("data", (chunk: Buffer) => {
    captureOutput("stdout", stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    captureOutput("stderr", stderr, chunk);
  });
  signal.addEventListener("abort", stopGroup, { once: true });
  if (signal.aborted) {
    stopGroup();
  }

  let processError: unknown;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, exitSignal) => {
          settled = true;
          if (code === 0) {
            resolve();
            return;
          }
          reject(
            Object.assign(
              new Error(
                `Command failed: git ${args.join(" ")}\n${stderr.toString()}`
              ),
              { code, killed: child.killed, signal: exitSignal }
            )
          );
        });
      }),
      groupShutdownFailure
    ]);
  } catch (error) {
    processError = error;
  } finally {
    settled = true;
    signal.removeEventListener("abort", stopGroup);
  }

  try {
    await groupShutdown;
  } catch (cleanupError) {
    throw new WorkspacePreparationCleanupError(
      "failed to stop aborted Git process group",
      cleanupError
    );
  }
  if (outputError !== undefined) {
    throw outputError;
  }
  if (processError !== undefined) {
    if (processError instanceof Error) {
      throw processError;
    }
    throw new Error("Git process failed with a non-error value", {
      cause: processError
    });
  }
  return stdout.toString().trim();
}

class BoundedGitOutput {
  readonly #chunks: Buffer[] = [];
  #length = 0;

  append(chunk: Buffer): boolean {
    const remaining = GIT_MAX_BUFFER_BYTES - this.#length;
    if (chunk.length <= remaining) {
      this.#chunks.push(chunk);
      this.#length += chunk.length;
      return false;
    }
    if (remaining > 0) {
      this.#chunks.push(chunk.subarray(0, remaining));
      this.#length = GIT_MAX_BUFFER_BYTES;
    }
    return true;
  }

  toString(): string {
    return Buffer.concat(this.#chunks, this.#length).toString("utf8");
  }
}

async function terminateGitProcessGroup(
  pid: number | undefined
): Promise<void> {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
    return;
  }
  if (!signalProcessGroup(pid, "SIGTERM")) {
    return;
  }
  if (await waitForProcessGroupExit(pid, GIT_ABORT_GRACE_MS)) {
    return;
  }
  signalProcessGroup(pid, "SIGKILL");
  if (!(await waitForProcessGroupExit(pid, GIT_ABORT_GRACE_MS, true))) {
    throw new Error(`Git process group ${pid} survived SIGKILL`);
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMs: number,
  acceptZombieOnly = false
): Promise<boolean> {
  const expiresAt = Date.now() + timeoutMs;
  while (await processGroupCanExecute(pid, acceptZombieOnly)) {
    if (Date.now() >= expiresAt) {
      return false;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, GIT_GROUP_POLL_MS);
    });
  }
  return true;
}

async function processGroupCanExecute(
  pid: number,
  acceptZombieOnly: boolean
): Promise<boolean> {
  if (!processGroupExists(pid)) {
    return false;
  }
  if (!acceptZombieOnly || process.platform !== "linux") {
    return true;
  }
  return await linuxProcessGroupHasNonZombieMember(pid);
}

async function linuxProcessGroupHasNonZombieMember(
  processGroupId: number
): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    // A host without a readable procfs cannot distinguish zombies from
    // executable members, so retain the conservative process-group probe.
    return true;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    let statContents: string;
    try {
      statContents = await readFile(`/proc/${entry}/stat`, "utf8");
    } catch {
      // Processes can disappear between readdir and readFile.
      continue;
    }
    const processStat = parseLinuxProcessStat(statContents);
    if (
      processStat?.processGroupId === processGroupId &&
      processStat.state !== "Z" &&
      processStat.state !== "X"
    ) {
      return true;
    }
  }
  return false;
}

function parseLinuxProcessStat(
  statContents: string
): { processGroupId: number; state: string } | undefined {
  // /proc/<pid>/stat wraps comm in parentheses; comm itself may contain a
  // closing parenthesis, so field parsing must begin after the final one.
  const commandEnd = statContents.lastIndexOf(")");
  if (commandEnd < 0) {
    return undefined;
  }
  const fields = statContents
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const processGroupId = Number.parseInt(fields[2] ?? "", 10);
  const state = fields[0];
  if (state === undefined || !Number.isSafeInteger(processGroupId)) {
    return undefined;
  }
  return { processGroupId, state };
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function gitSucceeds(
  args: string[],
  signal?: AbortSignal
): Promise<boolean> {
  try {
    await git(args, signal);
    return true;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

// Distinguishes an execFile rejection actually caused by `signal` firing from
// an unrelated failure that happens to land after the signal was aborted for
// some other reason (e.g. a real Git error racing the deadline). Node's
// execFile rejects with this shape specifically for signal-driven aborts.
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
