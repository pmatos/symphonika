import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Octokit } from "@octokit/rest";

import { redactAll } from "../redaction.js";
import type { MaestroRepositoryContent } from "./config.js";

// The Maestro Workspace: a bare git mirror, under the state root and
// separate from every Coding Agent Workspace, that holds fetched GitHub
// repository content for Maestro to read. Nothing is ever checked out, so no
// local Project file, secret environment file, or Coding Agent Workspace is
// reachable through it; every read goes through `git` object lookups with a
// fixed argv. Model-supplied values only ever appear as a validated
// `<sha>:<path>` operand, an `-e` pattern, or a `--`-separated literal
// pathspec.

const execFileAsync = promisify(execFile);

const FETCH_TIMEOUT_MS = 60_000;
const READ_TIMEOUT_MS = 20_000;
const MAX_READ_BYTES = 100_000;
const MAX_BLOB_BYTES = 8_000_000;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_MATCHES = 50;
const MAX_SEARCH_LINE_CHARS = 300;
const MAX_GIT_OUTPUT_BYTES = 16_000_000;

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_PATTERN = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_PATH_CHARS = 500;
const MAX_PATTERN_CHARS = 200;

// Committed secrets are not harmless just because they are in git history,
// and Maestro's output goes to a third-party model provider.
const SECRET_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)[^/]*$/i,
  /(^|\/)\.(npmrc|netrc|pypirc)$/i,
  /(^|\/)credentials[^/]*$/i
];

export type RepositoryInfo = { defaultBranch: string; private: boolean };

export type RevisionTarget =
  | { kind: "default_branch" }
  | { branch: string; kind: "branch" }
  | { branch?: string; kind: "sha"; sha: string };

export type MaestroRevisionSource =
  "default_branch" | "branch_tip" | "recorded_head_sha";

export type MaestroRevision = {
  fetchedAt: string;
  owner: string;
  ref: string;
  repo: string;
  repository: string;
  sha: string;
  source: MaestroRevisionSource;
  visibility: "private" | "public";
};

export type MaestroUnavailable = { kind: "unavailable"; reason: string };

export type MaestroResolveResult =
  { kind: "ok"; revision: MaestroRevision } | MaestroUnavailable;

export type MaestroFileListing = {
  files: string[];
  truncated: boolean;
  withheld: number;
};

export type MaestroFileContent = {
  content: string;
  path: string;
  size: number;
  truncated: boolean;
};

export type MaestroSearchMatch = { line: number; path: string; text: string };

export type MaestroSearchResult = {
  matches: MaestroSearchMatch[];
  truncated: boolean;
  withheld: number;
};

export type MaestroWorkspaceSession = {
  listFiles(
    revision: MaestroRevision,
    prefix: string | undefined
  ): Promise<{ kind: "ok"; listing: MaestroFileListing } | MaestroUnavailable>;
  readFile(
    revision: MaestroRevision,
    filePath: string
  ): Promise<
    | { content: MaestroFileContent; kind: "ok" }
    | { kind: "withheld"; path: string }
    | MaestroUnavailable
  >;
  resolve(input: {
    owner: string;
    repo: string;
    target: RevisionTarget;
  }): Promise<MaestroResolveResult>;
  search(
    revision: MaestroRevision,
    input: { pathspec: string | undefined; pattern: string }
  ): Promise<{ kind: "ok"; result: MaestroSearchResult } | MaestroUnavailable>;
};

export type MaestroWorkspace = {
  session(repositoryContent: MaestroRepositoryContent): MaestroWorkspaceSession;
};

export type GitRunOptions = {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  timeoutMs: number;
};

export type GitRunner = (
  args: string[],
  options: GitRunOptions
) => Promise<Buffer>;

export type MaestroWorkspaceDeps = {
  now?: () => Date;
  redactSecrets?: () => string[];
  remoteUrl?: (owner: string, repo: string) => string;
  repositoryInfo: (
    owner: string,
    repo: string,
    token: string
  ) => Promise<RepositoryInfo | undefined>;
  runGit?: GitRunner;
  stateRoot: string;
  tokenFor: (owner: string, repo: string) => Promise<string | undefined>;
};

const defaultGitRunner: GitRunner = async (args, options) => {
  const { stdout } = await execFileAsync("git", args, {
    encoding: "buffer",
    env: options.env,
    maxBuffer: options.maxBuffer,
    timeout: options.timeoutMs,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd })
  });
  return stdout;
};

export function createGitHubRepositoryInfoLookup(): MaestroWorkspaceDeps["repositoryInfo"] {
  return async (owner, repo, token) => {
    const octokit = new Octokit({
      auth: token,
      log: {
        debug: () => undefined,
        error: () => undefined,
        info: () => undefined,
        warn: () => undefined
      }
    });
    try {
      const { data } = await octokit.rest.repos.get({ owner, repo });
      return { defaultBranch: data.default_branch, private: data.private };
    } catch {
      return undefined;
    }
  };
}

function isSecretPath(filePath: string): boolean {
  return SECRET_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

function unavailable(reason: string): MaestroUnavailable {
  return { kind: "unavailable", reason };
}

function validRepoPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_PATH_CHARS &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.includes("\0") &&
    !value.includes("\n") &&
    !value.split("/").includes("..")
  );
}

function hasNul(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

function isBufferOverflow(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
  );
}

function exitCode(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}

export function createMaestroWorkspace(
  deps: MaestroWorkspaceDeps
): MaestroWorkspace {
  const runGit = deps.runGit ?? defaultGitRunner;
  const now = deps.now ?? ((): Date => new Date());
  const remoteUrl =
    deps.remoteUrl ??
    ((owner: string, repo: string): string =>
      `https://github.com/${owner}/${repo}.git`);
  const scrub = (text: string): string =>
    redactAll(text, deps.redactSecrets?.() ?? []);

  const baseEnv = (): NodeJS.ProcessEnv => ({
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_TERMINAL_PROMPT: "0",
    LANG: "C",
    PATH: process.env.PATH ?? "/usr/bin:/bin"
  });

  const mirrorPath = (owner: string, repo: string): string =>
    path.join(
      deps.stateRoot,
      "maestro-workspace",
      owner.toLowerCase(),
      `${repo.toLowerCase()}.git`
    );

  async function ensureMirror(owner: string, repo: string): Promise<string> {
    const mirror = mirrorPath(owner, repo);
    try {
      await access(path.join(mirror, "HEAD"));
    } catch {
      await mkdir(mirror, { recursive: true });
      await runGit(["init", "--bare", "--quiet", mirror], {
        env: baseEnv(),
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        timeoutMs: READ_TIMEOUT_MS
      });
    }
    return mirror;
  }

  async function fetchRevision(input: {
    owner: string;
    refspec: string;
    repo: string;
    token: string;
  }): Promise<string> {
    const mirror = await ensureMirror(input.owner, input.repo);
    const url = remoteUrl(input.owner, input.repo);
    const credentials = Buffer.from(`x-access-token:${input.token}`).toString(
      "base64"
    );
    const env: NodeJS.ProcessEnv = url.startsWith("https://")
      ? {
          ...baseEnv(),
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: `Authorization: basic ${credentials}`
        }
      : baseEnv();
    await runGit(
      [
        `--git-dir=${mirror}`,
        "fetch",
        "--quiet",
        "--no-tags",
        "--depth=1",
        url,
        input.refspec
      ],
      { env, maxBuffer: MAX_GIT_OUTPUT_BYTES, timeoutMs: FETCH_TIMEOUT_MS }
    );
    const sha = (
      await runGit(
        [`--git-dir=${mirror}`, "rev-parse", "--verify", "FETCH_HEAD^{commit}"],
        {
          env: baseEnv(),
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
          timeoutMs: READ_TIMEOUT_MS
        }
      )
    )
      .toString("utf8")
      .trim();
    return sha;
  }

  async function resolve(
    repositoryContent: MaestroRepositoryContent,
    input: { owner: string; repo: string; target: RevisionTarget }
  ): Promise<MaestroResolveResult> {
    const { owner, repo, target } = input;
    if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) {
      return unavailable(`"${owner}/${repo}" is not a valid GitHub repository`);
    }
    if (repo === "." || repo === "..") {
      return unavailable(`"${owner}/${repo}" is not a valid GitHub repository`);
    }
    if (repositoryContent === "none") {
      return unavailable("repository content disclosure is disabled");
    }
    if (
      (target.kind === "branch" ||
        (target.kind === "sha" && target.branch !== undefined)) &&
      !BRANCH_PATTERN.test(
        target.kind === "branch" ? target.branch : (target.branch ?? "")
      )
    ) {
      return unavailable("branch name is not valid");
    }
    if (target.kind === "sha" && !SHA_PATTERN.test(target.sha)) {
      return unavailable("revision is not a full 40-character commit sha");
    }

    const token = await deps.tokenFor(owner, repo);
    if (token === undefined) {
      return unavailable("gh is not authenticated for this repository");
    }
    const info = await deps.repositoryInfo(owner, repo, token);
    if (info === undefined) {
      return unavailable(
        `repository ${owner}/${repo} was not found or is not accessible through gh`
      );
    }
    if (info.private && repositoryContent !== "public_and_private") {
      return unavailable("private repository content disclosure not enabled");
    }

    let ref: string;
    let refspec: string;
    let source: MaestroRevisionSource;
    if (target.kind === "default_branch") {
      ref = info.defaultBranch;
      refspec = `refs/heads/${info.defaultBranch}`;
      source = "default_branch";
    } else if (target.kind === "branch") {
      ref = target.branch;
      refspec = `refs/heads/${target.branch}`;
      source = "branch_tip";
    } else {
      ref = target.branch ?? target.sha;
      refspec = target.sha;
      source = "recorded_head_sha";
    }

    try {
      const sha = await fetchRevision({ owner, refspec, repo, token });
      if (target.kind === "sha" && sha !== target.sha) {
        return unavailable(`revision ${target.sha} could not be fetched`);
      }
      return {
        kind: "ok",
        revision: {
          fetchedAt: now().toISOString(),
          owner,
          ref,
          repo,
          repository: `${owner}/${repo}`,
          sha,
          source,
          visibility: info.private ? "private" : "public"
        }
      };
    } catch {
      return unavailable(
        `revision ${target.kind === "sha" ? target.sha : ref} of ${owner}/${repo} could not be fetched`
      );
    }
  }

  async function git(
    revision: MaestroRevision,
    args: string[],
    maxBuffer = MAX_GIT_OUTPUT_BYTES
  ): Promise<Buffer> {
    return await runGit(
      [`--git-dir=${mirrorPath(revision.owner, revision.repo)}`, ...args],
      { env: baseEnv(), maxBuffer, timeoutMs: READ_TIMEOUT_MS }
    );
  }

  async function listFiles(
    revision: MaestroRevision,
    prefix: string | undefined
  ): Promise<{ kind: "ok"; listing: MaestroFileListing } | MaestroUnavailable> {
    if (prefix !== undefined && !validRepoPath(prefix)) {
      return unavailable("path is not valid");
    }
    try {
      const out = await git(revision, [
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        revision.sha,
        ...(prefix === undefined ? [] : ["--", prefix])
      ]);
      const all = out
        .toString("utf8")
        .split("\0")
        .filter((entry) => entry.length > 0);
      const visible = all.filter((entry) => !isSecretPath(entry));
      return {
        kind: "ok",
        listing: {
          files: visible.slice(0, MAX_LIST_ENTRIES).map(scrub),
          truncated: visible.length > MAX_LIST_ENTRIES,
          withheld: all.length - visible.length
        }
      };
    } catch (error) {
      return unavailable(
        isBufferOverflow(error)
          ? "the repository tree is too large to list; pass a narrower path"
          : "the file listing could not be read"
      );
    }
  }

  async function readFile(
    revision: MaestroRevision,
    filePath: string
  ): Promise<
    | { content: MaestroFileContent; kind: "ok" }
    | { kind: "withheld"; path: string }
    | MaestroUnavailable
  > {
    if (!validRepoPath(filePath)) {
      return unavailable("path is not valid");
    }
    if (isSecretPath(filePath)) {
      return { kind: "withheld", path: filePath };
    }
    const object = `${revision.sha}:${filePath}`;
    try {
      const type = (await git(revision, ["cat-file", "-t", object]))
        .toString("utf8")
        .trim();
      if (type !== "blob") {
        return unavailable(`${filePath} is not a file`);
      }
      const size = Number(
        (await git(revision, ["cat-file", "-s", object])).toString("utf8")
      );
      if (size > MAX_BLOB_BYTES) {
        return unavailable(`${filePath} is too large to read`);
      }
      const blob = await git(revision, ["cat-file", "blob", object]);
      if (hasNul(blob)) {
        return unavailable(`${filePath} is a binary file`);
      }
      const truncated = blob.length > MAX_READ_BYTES;
      return {
        content: {
          content: scrub(blob.subarray(0, MAX_READ_BYTES).toString("utf8")),
          path: filePath,
          size: blob.length,
          truncated
        },
        kind: "ok"
      };
    } catch {
      return unavailable(`${filePath} does not exist at ${revision.sha}`);
    }
  }

  async function search(
    revision: MaestroRevision,
    input: { pathspec: string | undefined; pattern: string }
  ): Promise<{ kind: "ok"; result: MaestroSearchResult } | MaestroUnavailable> {
    if (
      input.pattern.length === 0 ||
      input.pattern.length > MAX_PATTERN_CHARS ||
      /[\0\n\r]/.test(input.pattern)
    ) {
      return unavailable("pattern is not valid");
    }
    if (input.pathspec !== undefined && !validRepoPath(input.pathspec)) {
      return unavailable("path is not valid");
    }
    let out: Buffer;
    try {
      out = await git(revision, [
        "grep",
        "-z",
        "-n",
        "-I",
        "-F",
        "--no-color",
        "-e",
        input.pattern,
        revision.sha,
        ...(input.pathspec === undefined ? [] : ["--", input.pathspec])
      ]);
    } catch (error) {
      if (exitCode(error) === 1) {
        return {
          kind: "ok",
          result: { matches: [], truncated: false, withheld: 0 }
        };
      }
      return unavailable(
        isBufferOverflow(error)
          ? "too many matches; narrow the pattern or path"
          : "the search could not be run"
      );
    }

    const prefix = `${revision.sha}:`;
    const matches: MaestroSearchMatch[] = [];
    let withheld = 0;
    let truncated = false;
    // -z -n output is `<sha>:<path>\0<line>\0<text>` per line.
    for (const row of out.toString("utf8").split("\n")) {
      const first = row.indexOf("\0");
      const second = row.indexOf("\0", first + 1);
      if (first === -1 || second === -1 || !row.startsWith(prefix)) {
        continue;
      }
      const filePath = row.slice(prefix.length, first);
      if (isSecretPath(filePath)) {
        withheld += 1;
        continue;
      }
      if (matches.length >= MAX_SEARCH_MATCHES) {
        truncated = true;
        continue;
      }
      matches.push({
        line: Number(row.slice(first + 1, second)),
        path: filePath,
        text: scrub(row.slice(second + 1, second + 1 + MAX_SEARCH_LINE_CHARS))
      });
    }
    return { kind: "ok", result: { matches, truncated, withheld } };
  }

  return {
    session: (repositoryContent) => {
      const memo = new Map<string, Promise<MaestroResolveResult>>();
      return {
        listFiles,
        readFile,
        resolve: (input) => {
          const key = JSON.stringify([
            input.owner.toLowerCase(),
            input.repo.toLowerCase(),
            input.target
          ]);
          let cached = memo.get(key);
          if (cached === undefined) {
            cached = resolve(repositoryContent, input);
            memo.set(key, cached);
          }
          return cached;
        },
        search
      };
    }
  };
}
