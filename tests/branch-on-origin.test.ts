import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GitHubIssuesApi } from "../src/issue-polling.js";
import { verifyBranchPublished } from "../src/lifecycle/branch-on-origin.js";
import { createGitWorkspaceAhead } from "./helpers/git-workspace.js";

const execFileAsync = promisify(execFile);
const repository = { owner: "pmatos", repo: "symphonika", token: "secret" };
const branch = "sym/symphonika/833-test";
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function workspaceWithHead(): Promise<{ head: string; path: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-origin-test-"));
  tempRoots.push(root);
  const workspacePath = path.join(root, "workspace");
  await createGitWorkspaceAhead({ branchName: branch, workspacePath });
  const { stdout } = await execFileAsync("git", [
    "-C",
    workspacePath,
    "rev-parse",
    "HEAD"
  ]);
  return { head: stdout.trim(), path: workspacePath };
}

function check(api: GitHubIssuesApi, workspacePath: string, timeoutMs = 1000) {
  return verifyBranchPublished({
    api,
    branch,
    repository,
    timeoutMs,
    workspacePath
  });
}

const baseApi: GitHubIssuesApi = { listOpenIssues: () => Promise.resolve([]) };

describe("verifyBranchPublished", () => {
  it("reports published when origin's tip matches the local head", async () => {
    const ws = await workspaceWithHead();
    const api = {
      ...baseApi,
      listBranchCommits: vi.fn().mockResolvedValue([{ sha: ws.head }])
    };
    await expect(check(api, ws.path)).resolves.toEqual({ kind: "published" });
    expect(api.listBranchCommits).toHaveBeenCalledWith(
      expect.objectContaining({ branch, perPage: 1 })
    );
  });

  it("reports missing when origin has no such branch", async () => {
    const ws = await workspaceWithHead();
    const api = {
      ...baseApi,
      listBranchCommits: vi.fn().mockResolvedValue(null)
    };
    await expect(check(api, ws.path)).resolves.toEqual({ kind: "missing" });
  });

  it("reports stale when origin's tip differs from the local head", async () => {
    const ws = await workspaceWithHead();
    const api = {
      ...baseApi,
      listBranchCommits: vi.fn().mockResolvedValue([{ sha: "0".repeat(40) }])
    };
    await expect(check(api, ws.path)).resolves.toEqual({
      kind: "stale",
      localSha: ws.head,
      originSha: "0".repeat(40)
    });
  });

  it("fails open when the commits API is unavailable", async () => {
    const ws = await workspaceWithHead();
    await expect(check(baseApi, ws.path)).resolves.toEqual({
      kind: "unverified"
    });
  });

  it("fails open when GitHub throws", async () => {
    const ws = await workspaceWithHead();
    const api = {
      ...baseApi,
      listBranchCommits: vi.fn().mockRejectedValue(new Error("502"))
    };
    await expect(check(api, ws.path)).resolves.toEqual({ kind: "unverified" });
  });

  it("fails open when the lookup outlasts the timeout", async () => {
    const ws = await workspaceWithHead();
    const api = {
      ...baseApi,
      listBranchCommits: vi.fn().mockReturnValue(new Promise(() => undefined))
    };
    await expect(check(api, ws.path, 20)).resolves.toEqual({
      kind: "unverified"
    });
  });

  it("fails open when the local head cannot be read", async () => {
    const api = {
      ...baseApi,
      listBranchCommits: vi.fn().mockResolvedValue([{ sha: "abc" }])
    };
    await expect(check(api, "/nonexistent/workspace")).resolves.toEqual({
      kind: "unverified"
    });
  });

  it("fails open when origin returns a commit without a sha", async () => {
    const ws = await workspaceWithHead();
    const api = {
      ...baseApi,
      listBranchCommits: vi.fn().mockResolvedValue([{}])
    };
    await expect(check(api, ws.path)).resolves.toEqual({ kind: "unverified" });
  });

  it("logs a warning when the lookup throws", async () => {
    const ws = await workspaceWithHead();
    const warn = vi.fn();
    const api = {
      ...baseApi,
      listBranchCommits: vi.fn().mockRejectedValue(new Error("502"))
    };
    await expect(
      verifyBranchPublished({
        api,
        branch,
        logger: { warn } as unknown as Logger,
        repository,
        timeoutMs: 1000,
        workspacePath: ws.path
      })
    ).resolves.toEqual({ kind: "unverified" });
    expect(warn).toHaveBeenCalledOnce();
  });
});
