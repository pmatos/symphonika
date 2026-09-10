import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { clearBlockedSentinel } from "../src/lifecycle/blocked-sentinel.js";

const execFileAsync = promisify(execFile);

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function makeGitWorkspace(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "symphonika-blocked-sentinel-")
  );
  tempRoots.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Symphonika Test"]);
  await writeFile(path.join(root, "README.md"), "# Fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "Base"]);
  return root;
}

async function git(workspacePath: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", workspacePath, ...args]);
}

// Issue #739: PR #736's clearBlockedSentinel deletes BLOCKED.md
// unconditionally once a state declares the gate, with no check on whether
// the file is the orchestration's own uncommitted sentinel or a managed
// repository's own git-tracked source file of the same name.
describe("clearBlockedSentinel provenance check (issue #739)", () => {
  it("does not delete a git-tracked BLOCKED.md owned by the managed repository", async () => {
    const workspacePath = await makeGitWorkspace();
    const ownedContents = "# Blocked\nThis is the repo's own tracked file.\n";
    await writeFile(path.join(workspacePath, "BLOCKED.md"), ownedContents);
    await git(workspacePath, ["add", "BLOCKED.md"]);
    await git(workspacePath, ["commit", "-m", "Add tracked BLOCKED.md"]);

    await clearBlockedSentinel(workspacePath);

    await expect(
      readFile(path.join(workspacePath, "BLOCKED.md"), "utf8")
    ).resolves.toBe(ownedContents);
  });

  it("deletes an untracked BLOCKED.md sentinel left by a prior attempt", async () => {
    const workspacePath = await makeGitWorkspace();
    await writeFile(
      path.join(workspacePath, "BLOCKED.md"),
      "# Blocked\nStale sentinel from a previous attempt.\n"
    );

    await clearBlockedSentinel(workspacePath);

    await expect(
      readFile(path.join(workspacePath, "BLOCKED.md"), "utf8")
    ).rejects.toThrow();
  });
});
