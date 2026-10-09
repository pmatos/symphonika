import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MaestroRepositoryContent } from "../src/maestro/config.js";
import {
  createGitHubRepositoryInfoLookup,
  createMaestroWorkspace,
  type GitRunner,
  type MaestroRevision,
  type MaestroWorkspaceSession,
  type RepositoryInfo
} from "../src/maestro/workspace.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-maestro-ws-"));
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_AUTHOR_NAME: "t",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      HOME: cwd,
      PATH: process.env.PATH ?? ""
    }
  }).trim();
}

async function writeFiles(
  dir: string,
  files: Record<string, string>
): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
}

type Fixture = {
  commit(files: Record<string, string>, message: string): Promise<string>;
  url: string;
  work: string;
};

async function makeFixtureRemote(
  initial: Record<string, string>
): Promise<Fixture> {
  const root = await makeTempRoot();
  const work = path.join(root, "work");
  const bare = path.join(root, "remote.git");
  await mkdir(work);
  git(work, "init", "--quiet", "--initial-branch=main");
  git(work, "init", "--quiet", "--bare", bare);
  git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
  const fixture: Fixture = {
    commit: async (files, message) => {
      await writeFiles(work, files);
      git(work, "add", "-A");
      git(work, "commit", "--quiet", "-m", message);
      git(work, "push", "--quiet", bare, "HEAD:refs/heads/main");
      return git(work, "rev-parse", "HEAD");
    },
    url: `file://${bare}`,
    work
  };
  await fixture.commit(initial, "initial");
  return fixture;
}

type Harness = {
  gitCalls: string[][];
  redactSecretsCalls: () => number;
  session: (
    repositoryContent: MaestroRepositoryContent
  ) => MaestroWorkspaceSession;
  stateRoot: string;
};

async function makeHarness(input: {
  info?: RepositoryInfo | undefined;
  redactSecrets?: string[];
  remote: Fixture;
  token?: string | undefined;
}): Promise<Harness> {
  const stateRoot = await makeTempRoot();
  const gitCalls: string[][] = [];
  let redactSecretsCalls = 0;
  const runGit: GitRunner = async (args, options) => {
    gitCalls.push(args);
    const { stdout } = await execFileAsync("git", args, {
      encoding: "buffer",
      env: options.env,
      maxBuffer: options.maxBuffer,
      timeout: options.timeoutMs
    });
    return stdout;
  };
  const workspace = createMaestroWorkspace({
    now: () => new Date("2026-10-09T12:00:00.000Z"),
    redactSecrets: () => {
      redactSecretsCalls += 1;
      return input.redactSecrets ?? [];
    },
    remoteUrl: () => input.remote.url,
    repositoryInfo: () =>
      Promise.resolve(
        "info" in input ? input.info : { defaultBranch: "main", private: false }
      ),
    runGit,
    stateRoot,
    tokenFor: () =>
      Promise.resolve("token" in input ? input.token : "test-token")
  });
  return {
    gitCalls,
    redactSecretsCalls: () => redactSecretsCalls,
    session: (repositoryContent) => workspace.session(repositoryContent),
    stateRoot
  };
}

async function resolveDefault(
  session: MaestroWorkspaceSession
): Promise<MaestroRevision> {
  const result = await session.resolve({
    owner: "acme",
    repo: "widgets",
    target: { kind: "default_branch" }
  });
  if (result.kind !== "ok") {
    throw new Error(`expected ok, got ${result.reason}`);
  }
  return result.revision;
}

describe("Maestro Workspace revision resolution", () => {
  it("fetches the default-branch revision with provenance, and re-fetches on a new session", async () => {
    const remote = await makeFixtureRemote({ "README.md": "hello\n" });
    const first = await remote.commit({ "README.md": "hello v1\n" }, "v1");
    const harness = await makeHarness({ remote });

    const revision = await resolveDefault(harness.session("public"));

    expect(revision).toMatchObject({
      fetchedAt: "2026-10-09T12:00:00.000Z",
      ref: "main",
      repository: "acme/widgets",
      sha: first,
      source: "default_branch",
      visibility: "public"
    });

    const second = await remote.commit({ "README.md": "hello v2\n" }, "v2");
    const next = await resolveDefault(harness.session("public"));
    expect(next.sha).toBe(second);
  });

  it("memoizes a revision within one session so the answer has one fetchedAt", async () => {
    const remote = await makeFixtureRemote({ "README.md": "hello\n" });
    const harness = await makeHarness({ remote });
    const session = harness.session("public");

    await resolveDefault(session);
    const fetchesAfterFirst = harness.gitCalls.filter((args) =>
      args.includes("fetch")
    ).length;
    await resolveDefault(session);

    expect(
      harness.gitCalls.filter((args) => args.includes("fetch")).length
    ).toBe(fetchesAfterFirst);
    expect(fetchesAfterFirst).toBe(1);
  });

  it("reads a named branch tip and a recorded sha, never the default branch", async () => {
    const remote = await makeFixtureRemote({ "README.md": "hello\n" });
    const mainSha = await remote.commit({ "a.txt": "main\n" }, "main work");
    git(remote.work, "checkout", "--quiet", "-b", "feature");
    await writeFiles(remote.work, { "b.txt": "feature\n" });
    git(remote.work, "add", "-A");
    git(remote.work, "commit", "--quiet", "-m", "feature");
    const featureSha = git(remote.work, "rev-parse", "HEAD");
    git(
      remote.work,
      "push",
      "--quiet",
      remote.url.replace("file://", ""),
      "HEAD:refs/heads/feature"
    );
    const harness = await makeHarness({ remote });
    const session = harness.session("public");

    const branch = await session.resolve({
      owner: "acme",
      repo: "widgets",
      target: { branch: "feature", kind: "branch" }
    });
    const recorded = await session.resolve({
      owner: "acme",
      repo: "widgets",
      target: { branch: "feature", kind: "sha", sha: featureSha }
    });

    expect(branch).toMatchObject({
      kind: "ok",
      revision: { ref: "feature", sha: featureSha, source: "branch_tip" }
    });
    expect(recorded).toMatchObject({
      kind: "ok",
      revision: { sha: featureSha, source: "recorded_head_sha" }
    });
    expect(featureSha).not.toBe(mainSha);
  });

  it("reports a missing branch and a missing sha as unavailable without substituting the default branch", async () => {
    const remote = await makeFixtureRemote({ "README.md": "hello\n" });
    const harness = await makeHarness({ remote });
    const session = harness.session("public");

    const branch = await session.resolve({
      owner: "acme",
      repo: "widgets",
      target: { branch: "gone", kind: "branch" }
    });
    const sha = await session.resolve({
      owner: "acme",
      repo: "widgets",
      target: { kind: "sha", sha: "a".repeat(40) }
    });

    expect(branch).toMatchObject({ kind: "unavailable" });
    expect(sha).toMatchObject({ kind: "unavailable" });
  });

  it("rejects malformed repository, branch, and sha input before running git", async () => {
    const remote = await makeFixtureRemote({ "README.md": "hello\n" });
    const harness = await makeHarness({ remote });
    const session = harness.session("public_and_private");

    const results = await Promise.all([
      session.resolve({
        owner: "acme",
        repo: "..",
        target: { kind: "default_branch" }
      }),
      session.resolve({
        owner: "--upload-pack=x",
        repo: "widgets",
        target: { kind: "default_branch" }
      }),
      session.resolve({
        owner: "acme",
        repo: "widgets",
        target: { branch: "--force", kind: "branch" }
      }),
      session.resolve({
        owner: "acme",
        repo: "widgets",
        target: { kind: "sha", sha: "main" }
      })
    ]);

    for (const result of results) {
      expect(result.kind).toBe("unavailable");
    }
    expect(harness.gitCalls).toEqual([]);
  });

  it("is unavailable, without running git, when gh has no token", async () => {
    const remote = await makeFixtureRemote({ "README.md": "hello\n" });
    const harness = await makeHarness({ remote, token: undefined });

    const result = await harness.session("public").resolve({
      owner: "acme",
      repo: "widgets",
      target: { kind: "default_branch" }
    });

    expect(result).toMatchObject({ kind: "unavailable" });
    expect(harness.gitCalls).toEqual([]);
  });

  it("is unavailable when the repository is not accessible through gh", async () => {
    const remote = await makeFixtureRemote({ "README.md": "hello\n" });
    const harness = await makeHarness({ info: undefined, remote });

    const result = await harness.session("public_and_private").resolve({
      owner: "acme",
      repo: "widgets",
      target: { kind: "default_branch" }
    });

    expect(result).toMatchObject({ kind: "unavailable" });
    expect(harness.gitCalls).toEqual([]);
  });
});

describe("Maestro Workspace visibility gate", () => {
  const privateInfo: RepositoryInfo = { defaultBranch: "main", private: true };

  it("refuses a private repository under public, running no git", async () => {
    const remote = await makeFixtureRemote({ "README.md": "secret\n" });
    const harness = await makeHarness({ info: privateInfo, remote });

    const result = await harness.session("public").resolve({
      owner: "acme",
      repo: "widgets",
      target: { kind: "default_branch" }
    });

    expect(result).toEqual({
      kind: "unavailable",
      reason: "private repository content disclosure not enabled"
    });
    expect(harness.gitCalls).toEqual([]);
    expect(await readdir(harness.stateRoot)).toEqual([]);
  });

  it("allows a private repository under public_and_private and discloses its visibility", async () => {
    const remote = await makeFixtureRemote({ "README.md": "secret\n" });
    const harness = await makeHarness({ info: privateInfo, remote });

    const revision = await resolveDefault(
      harness.session("public_and_private")
    );

    expect(revision.visibility).toBe("private");
  });

  it("refuses everything under none, running no git", async () => {
    const remote = await makeFixtureRemote({ "README.md": "hello\n" });
    const harness = await makeHarness({ remote });

    const result = await harness.session("none").resolve({
      owner: "acme",
      repo: "widgets",
      target: { kind: "default_branch" }
    });

    expect(result).toMatchObject({ kind: "unavailable" });
    expect(harness.gitCalls).toEqual([]);
  });
});

describe("Maestro Workspace content access", () => {
  async function open(
    files: Record<string, string>,
    redactSecrets: string[] = []
  ): Promise<{
    harness: Harness;
    revision: MaestroRevision;
    session: MaestroWorkspaceSession;
  }> {
    const remote = await makeFixtureRemote(files);
    const harness = await makeHarness({ redactSecrets, remote });
    const session = harness.session("public");
    return { harness, revision: await resolveDefault(session), session };
  }

  it("lists files with a path-prefix filter and caps the listing", async () => {
    const many: Record<string, string> = { "README.md": "x\n" };
    for (let index = 0; index < 205; index += 1) {
      many[`src/f${index}.ts`] = "x\n";
    }
    const { revision, session } = await open(many);

    const all = await session.listFiles(revision, undefined);
    const scoped = await session.listFiles(revision, "README.md");

    expect(all).toMatchObject({
      kind: "ok",
      listing: { truncated: true }
    });
    expect(all.kind === "ok" ? all.listing.files : []).toHaveLength(200);
    expect(scoped).toMatchObject({
      kind: "ok",
      listing: { files: ["README.md"], truncated: false }
    });
  });

  it("treats a glob or magic pathspec as a literal path", async () => {
    const { revision, session } = await open({
      "a.txt": "needle\n",
      "b.txt": "needle\n"
    });

    const listing = await session.listFiles(revision, ":(top)*.txt");
    const glob = await session.search(revision, {
      pathspec: "*.txt",
      pattern: "needle"
    });
    const exact = await session.search(revision, {
      pathspec: "a.txt",
      pattern: "needle"
    });

    expect(listing).toMatchObject({ kind: "ok", listing: { files: [] } });
    expect(glob).toMatchObject({ kind: "ok", result: { matches: [] } });
    expect(exact.kind === "ok" ? exact.result.matches : []).toHaveLength(1);
  });

  it("reads a file, truncating large content and refusing binaries and directories", async () => {
    const { revision, session } = await open({
      "bin/blob.dat": "a\0b",
      "big.txt": "x".repeat(150_000),
      "docs/guide.md": "# Guide\n"
    });

    const small = await session.readFile(revision, "docs/guide.md");
    const big = await session.readFile(revision, "big.txt");
    const binary = await session.readFile(revision, "bin/blob.dat");
    const directory = await session.readFile(revision, "docs");
    const missing = await session.readFile(revision, "nope.md");

    expect(small).toMatchObject({
      content: { content: "# Guide\n", truncated: false },
      kind: "ok"
    });
    expect(big).toMatchObject({
      content: { size: 150_000, truncated: true },
      kind: "ok"
    });
    expect(big.kind === "ok" ? big.content.content.length : 0).toBe(100_000);
    expect(binary).toMatchObject({ kind: "unavailable" });
    expect(directory).toMatchObject({ kind: "unavailable" });
    expect(missing).toMatchObject({ kind: "unavailable" });
  });

  it("rejects traversal, absolute, option-like, and NUL paths", async () => {
    const { revision, session } = await open({ "a.txt": "x\n" });

    for (const bad of ["../a.txt", "/etc/passwd", "--help", "a\0b", "a/../b"]) {
      expect(await session.readFile(revision, bad)).toMatchObject({
        kind: "unavailable"
      });
    }
  });

  it("returns a symlink's target text instead of following it", async () => {
    const remote = await makeFixtureRemote({ "README.md": "x\n" });
    const { symlink } = await import("node:fs/promises");
    await symlink("/etc/passwd", path.join(remote.work, "link"));
    git(remote.work, "add", "-A");
    git(remote.work, "commit", "--quiet", "-m", "link");
    git(
      remote.work,
      "push",
      "--quiet",
      remote.url.replace("file://", ""),
      "HEAD:refs/heads/main"
    );
    const harness = await makeHarness({ remote });
    const session = harness.session("public");
    const revision = await resolveDefault(session);

    const result = await session.readFile(revision, "link");

    expect(result).toMatchObject({
      content: { content: "/etc/passwd" },
      kind: "ok"
    });
  });

  it("searches literally, caps matches, and treats an option-shaped pattern as data", async () => {
    const lines = Array.from({ length: 80 }, (_, index) => `needle ${index}`);
    const { revision, session } = await open({
      "a.txt": `${lines.join("\n")}\n`,
      "b.txt": "--open-files-in-pager=sh\nfoo.*bar\n"
    });

    const capped = await session.search(revision, {
      pathspec: "a.txt",
      pattern: "needle"
    });
    const option = await session.search(revision, {
      pathspec: undefined,
      pattern: "--open-files-in-pager=sh"
    });
    const literal = await session.search(revision, {
      pathspec: undefined,
      pattern: "foo.*bar"
    });
    const none = await session.search(revision, {
      pathspec: undefined,
      pattern: "absent-token"
    });

    expect(capped).toMatchObject({ kind: "ok", result: { truncated: true } });
    expect(capped.kind === "ok" ? capped.result.matches : []).toHaveLength(50);
    expect(option).toMatchObject({
      kind: "ok",
      result: { matches: [{ line: 1, path: "b.txt" }] }
    });
    expect(literal.kind === "ok" ? literal.result.matches : []).toHaveLength(1);
    expect(none).toMatchObject({ kind: "ok", result: { matches: [] } });
  });

  it("withholds secret-shaped paths from reads, listings, and searches", async () => {
    const { revision, session } = await open({
      ".env": "TOKEN=hunter2\n",
      "README.md": "TOKEN docs\n",
      "deploy/key.pem": "TOKEN pem\n"
    });

    const read = await session.readFile(revision, "deploy/key.pem");
    const env = await session.readFile(revision, ".env");
    const listing = await session.listFiles(revision, undefined);
    const search = await session.search(revision, {
      pathspec: undefined,
      pattern: "TOKEN"
    });

    expect(read).toEqual({ kind: "withheld", path: "deploy/key.pem" });
    expect(env).toEqual({ kind: "withheld", path: ".env" });
    expect(listing).toMatchObject({
      kind: "ok",
      listing: { files: ["README.md"], withheld: 2 }
    });
    expect(search).toMatchObject({
      kind: "ok",
      result: { matches: [{ path: "README.md" }], withheld: 2 }
    });
  });

  it("withholds dotenv variants and git's credential store", async () => {
    const { revision, session } = await open({
      ".env-production": "TOKEN=1\n",
      ".envrc": "export TOKEN=1\n",
      "README.md": "docs\n",
      "config/.git-credentials": "https://user:pw@example.com\n"
    });

    for (const secret of [
      ".envrc",
      ".env-production",
      "config/.git-credentials"
    ]) {
      expect(await session.readFile(revision, secret)).toEqual({
        kind: "withheld",
        path: secret
      });
    }
    expect(await session.listFiles(revision, undefined)).toMatchObject({
      listing: { files: ["README.md"], withheld: 3 }
    });
  });

  it("redacts a secret that straddles the truncation point instead of leaking its prefix", async () => {
    const secret = "ghp_SECRETVALUE123";
    const { revision, session } = await open(
      {
        "big.txt": `${"x".repeat(99_995)}${secret}${"y".repeat(50)}\n`,
        "wide.txt": `${"w".repeat(290)}${secret}${"z".repeat(50)}\n`
      },
      [secret]
    );

    const read = await session.readFile(revision, "big.txt");
    const search = await session.search(revision, {
      pathspec: "wide.txt",
      pattern: "www"
    });

    expect(read).toMatchObject({ content: { truncated: true }, kind: "ok" });
    expect(JSON.stringify(read)).not.toContain("ghp_");
    expect(JSON.stringify(search)).toContain("wwww");
    expect(JSON.stringify(search)).not.toContain("ghp_");
  });

  it("resolves the secret inventory once per operation, not once per string", async () => {
    const many: Record<string, string> = {};
    for (let index = 0; index < 60; index += 1) {
      many[`src/f${index}.ts`] = "needle\n";
    }
    const { harness, revision, session } = await open(many);

    const before = harness.redactSecretsCalls();
    await session.listFiles(revision, undefined);
    const afterList = harness.redactSecretsCalls();
    await session.search(revision, { pathspec: undefined, pattern: "needle" });
    const afterSearch = harness.redactSecretsCalls();

    expect(afterList - before).toBe(1);
    expect(afterSearch - afterList).toBe(1);
  });

  it("lands every fetch in one scratch ref so the next fetch has a revision to negotiate from", async () => {
    const remote = await makeFixtureRemote({ "README.md": "hello\n" });
    const harness = await makeHarness({ remote });
    await resolveDefault(harness.session("public"));
    await remote.commit({ "README.md": "hello v2\n" }, "v2");

    await resolveDefault(harness.session("public"));

    const refs = execFileSync(
      "git",
      [
        `--git-dir=${path.join(harness.stateRoot, "maestro-workspace", "acme", "widgets.git")}`,
        "for-each-ref",
        "--format=%(refname)"
      ],
      { encoding: "utf8" }
    )
      .trim()
      .split("\n");
    expect(refs).toEqual(["refs/maestro/fetched"]);
  });

  it("redacts known secret values out of file content and search text", async () => {
    const { revision, session } = await open(
      { "notes.txt": "key=ghp_SECRETVALUE123\n" },
      ["ghp_SECRETVALUE123"]
    );

    const read = await session.readFile(revision, "notes.txt");
    const search = await session.search(revision, {
      pathspec: undefined,
      pattern: "key="
    });

    expect(JSON.stringify(read)).not.toContain("ghp_SECRETVALUE123");
    expect(JSON.stringify(search)).not.toContain("ghp_SECRETVALUE123");
    expect(JSON.stringify(read)).toContain("[REDACTED]");
  });
});

describe("Maestro Workspace edge handling", () => {
  async function openWith(
    files: Record<string, string>,
    wrap?: (runGit: GitRunner) => GitRunner
  ): Promise<{
    revision: MaestroRevision;
    session: MaestroWorkspaceSession;
  }> {
    const remote = await makeFixtureRemote(files);
    const stateRoot = await makeTempRoot();
    const real: GitRunner = async (args, options) => {
      const { stdout } = await execFileAsync("git", args, {
        encoding: "buffer",
        env: options.env,
        maxBuffer: options.maxBuffer,
        timeout: options.timeoutMs
      });
      return stdout;
    };
    const workspace = createMaestroWorkspace({
      remoteUrl: () => remote.url,
      repositoryInfo: () =>
        Promise.resolve({ defaultBranch: "main", private: false }),
      runGit: wrap === undefined ? real : wrap(real),
      stateRoot,
      tokenFor: () => Promise.resolve("test-token")
    });
    const session = workspace.session("public");
    return { revision: await resolveDefault(session), session };
  }

  it("rejects an invalid path prefix, search pattern, and search pathspec", async () => {
    const { revision, session } = await openWith({ "a.txt": "needle\n" });

    expect(await session.listFiles(revision, "../escape")).toMatchObject({
      kind: "unavailable"
    });
    expect(
      await session.search(revision, { pathspec: undefined, pattern: "" })
    ).toMatchObject({ kind: "unavailable" });
    expect(
      await session.search(revision, { pathspec: "/abs", pattern: "needle" })
    ).toMatchObject({ kind: "unavailable" });
  });

  it("refuses a blob over the size cap", async () => {
    const { revision, session } = await openWith({
      "huge.txt": "x".repeat(8_000_001)
    });

    expect(await session.readFile(revision, "huge.txt")).toMatchObject({
      kind: "unavailable"
    });
  });

  it("reports git output overflow on listings and searches as unavailable", async () => {
    const overflow = Object.assign(new Error("maxBuffer"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    });
    const { revision, session } = await openWith(
      { "a.txt": "needle\n" },
      (real) => (args, options) =>
        args.some((arg) => arg === "ls-tree" || arg === "grep")
          ? Promise.reject(overflow)
          : real(args, options)
    );

    const listing = await session.listFiles(revision, undefined);
    const search = await session.search(revision, {
      pathspec: undefined,
      pattern: "needle"
    });

    expect(listing).toEqual({
      kind: "unavailable",
      reason: "the repository tree is too large to list; pass a narrower path"
    });
    expect(search).toEqual({
      kind: "unavailable",
      reason: "too many matches; narrow the pattern or path"
    });
  });

  it("falls back to the real git runner and clock when none are injected", async () => {
    const remote = await makeFixtureRemote({ "README.md": "hello\n" });
    const workspace = createMaestroWorkspace({
      remoteUrl: () => remote.url,
      repositoryInfo: () =>
        Promise.resolve({ defaultBranch: "main", private: false }),
      stateRoot: await makeTempRoot(),
      tokenFor: () => Promise.resolve("test-token")
    });
    const session = workspace.session("public");

    const revision = await resolveDefault(session);

    expect(revision.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Number.isNaN(Date.parse(revision.fetchedAt))).toBe(false);
  });
});

describe("createGitHubRepositoryInfoLookup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the default branch and visibility from the GitHub API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ default_branch: "trunk", private: true }),
            { headers: { "content-type": "application/json" }, status: 200 }
          )
        )
      )
    );

    const info = await createGitHubRepositoryInfoLookup()(
      "acme",
      "widgets",
      "t"
    );

    expect(info).toEqual({ defaultBranch: "trunk", private: true });
  });

  it("returns undefined when the repository cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ message: "Not Found" }), {
            headers: { "content-type": "application/json" },
            status: 404
          })
        )
      )
    );

    const info = await createGitHubRepositoryInfoLookup()(
      "acme",
      "widgets",
      "t"
    );

    expect(info).toBeUndefined();
  });
});
