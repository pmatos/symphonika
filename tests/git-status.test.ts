import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { commitFile, detectGitFileState } from "../src/http/git-status.js";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-git-status-"));
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

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, ...args]);
  return stdout.trim();
}

async function initRepo(dir: string, branch = "main"): Promise<void> {
  await execFileAsync("git", ["init", "--initial-branch", branch, dir]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Symphonika Test"]);
}

describe("detectGitFileState (#306 part 3/3, ADR 0075)", () => {
  it("reports inRepo: false for a path outside any git repo", async () => {
    const root = await makeTempRoot();
    const filePath = path.join(root, "workflow.md");
    await writeFile(filePath, "content", "utf8");

    const state = await detectGitFileState(filePath);
    expect(state).toEqual({ inRepo: false });
  });

  it("reports repo root, branch, and clean status for a committed file", async () => {
    const root = await makeTempRoot();
    await initRepo(root);
    const filePath = path.join(root, "workflow.md");
    await writeFile(filePath, "content\n", "utf8");
    await git(root, ["add", "workflow.md"]);
    await git(root, ["commit", "-m", "base"]);

    const state = await detectGitFileState(filePath);
    expect(state.inRepo).toBe(true);
    if (state.inRepo) {
      expect(state.branch).toBe("main");
      expect(state.detachedHeadSha).toBeNull();
      expect(state.dirty).toBe(false);
      expect(state.fileStatus).toBe("clean");
      expect(state.gitignored).toBe(false);
      expect(state.midRebase).toBe(false);
    }
  });

  it("reports the symbolic branch for a repository with an unborn HEAD", async () => {
    const root = await makeTempRoot();
    await initRepo(root);
    const filePath = path.join(root, "workflow.md");
    await writeFile(filePath, "content\n", "utf8");

    const state = await detectGitFileState(filePath);
    expect(state.inRepo).toBe(true);
    if (state.inRepo) {
      expect(state).toMatchObject({
        branch: "main",
        detachedHeadSha: null
      });
    }
  });

  it("reports untracked for a new, never-added file", async () => {
    const root = await makeTempRoot();
    await initRepo(root);
    await writeFile(path.join(root, "seed.txt"), "seed\n", "utf8");
    await git(root, ["add", "seed.txt"]);
    await git(root, ["commit", "-m", "base"]);
    const filePath = path.join(root, "workflow.md");
    await writeFile(filePath, "content\n", "utf8");

    const state = await detectGitFileState(filePath);
    expect(state.inRepo).toBe(true);
    if (state.inRepo) {
      expect(state.fileStatus).toBe("untracked");
      expect(state.dirty).toBe(true);
    }
  });

  it("reports modified_unstaged for a tracked file with unstaged edits", async () => {
    const root = await makeTempRoot();
    await initRepo(root);
    const filePath = path.join(root, "workflow.md");
    await writeFile(filePath, "content\n", "utf8");
    await git(root, ["add", "workflow.md"]);
    await git(root, ["commit", "-m", "base"]);
    await writeFile(filePath, "edited\n", "utf8");

    const state = await detectGitFileState(filePath);
    expect(state.inRepo).toBe(true);
    if (state.inRepo) {
      expect(state.fileStatus).toBe("modified_unstaged");
    }
  });

  it("reports modified_staged for a tracked file with staged but uncommitted edits", async () => {
    const root = await makeTempRoot();
    await initRepo(root);
    const filePath = path.join(root, "workflow.md");
    await writeFile(filePath, "content\n", "utf8");
    await git(root, ["add", "workflow.md"]);
    await git(root, ["commit", "-m", "base"]);
    await writeFile(filePath, "staged edit\n", "utf8");
    await git(root, ["add", "workflow.md"]);

    const state = await detectGitFileState(filePath);
    expect(state.inRepo).toBe(true);
    if (state.inRepo) {
      expect(state.fileStatus).toBe("modified_staged");
    }
  });

  it("reports modified_staged_and_unstaged when the same file has both", async () => {
    const root = await makeTempRoot();
    await initRepo(root);
    const filePath = path.join(root, "workflow.md");
    await writeFile(filePath, "content\n", "utf8");
    await git(root, ["add", "workflow.md"]);
    await git(root, ["commit", "-m", "base"]);
    await writeFile(filePath, "staged edit\n", "utf8");
    await git(root, ["add", "workflow.md"]);
    await writeFile(filePath, "staged edit, then more on top\n", "utf8");

    const state = await detectGitFileState(filePath);
    expect(state.inRepo).toBe(true);
    if (state.inRepo) {
      expect(state.fileStatus).toBe("modified_staged_and_unstaged");
    }
  });

  it("reports dirty: true from an unrelated file even when the target file itself is clean", async () => {
    const root = await makeTempRoot();
    await initRepo(root);
    const filePath = path.join(root, "workflow.md");
    await writeFile(filePath, "content\n", "utf8");
    await writeFile(path.join(root, "other.txt"), "other\n", "utf8");
    await git(root, ["add", "workflow.md", "other.txt"]);
    await git(root, ["commit", "-m", "base"]);
    // Only the unrelated file gets a follow-up edit.
    await writeFile(path.join(root, "other.txt"), "changed\n", "utf8");

    const state = await detectGitFileState(filePath);
    expect(state.inRepo).toBe(true);
    if (state.inRepo) {
      expect(state.fileStatus).toBe("clean");
      expect(state.dirty).toBe(true);
    }
  });

  it("reports a detached HEAD via detachedHeadSha, branch: null", async () => {
    const root = await makeTempRoot();
    await initRepo(root);
    const filePath = path.join(root, "workflow.md");
    await writeFile(filePath, "content\n", "utf8");
    await git(root, ["add", "workflow.md"]);
    await git(root, ["commit", "-m", "base"]);
    const sha = await git(root, ["rev-parse", "HEAD"]);
    await git(root, ["checkout", sha]);

    const state = await detectGitFileState(filePath);
    expect(state.inRepo).toBe(true);
    if (state.inRepo) {
      expect(state.branch).toBeNull();
      expect(state.detachedHeadSha).toBe(sha);
    }
  });

  it("reports midRebase: true while a conflicting rebase is paused", async () => {
    const root = await makeTempRoot();
    await initRepo(root);
    const filePath = path.join(root, "shared.txt");
    await writeFile(filePath, "line1\n", "utf8");
    await git(root, ["add", "shared.txt"]);
    await git(root, ["commit", "-m", "base"]);
    await git(root, ["checkout", "-b", "feature"]);
    await writeFile(filePath, "line1\nfeature change\n", "utf8");
    await git(root, ["add", "shared.txt"]);
    await git(root, ["commit", "-m", "feature commit"]);
    await git(root, ["checkout", "main"]);
    await writeFile(filePath, "line1\nmain change\n", "utf8");
    await git(root, ["add", "shared.txt"]);
    await git(root, ["commit", "-m", "main commit"]);
    await git(root, ["checkout", "feature"]);
    await execFileAsync("git", ["-C", root, "rebase", "main"]).catch(() => {
      // Expected: the conflicting rebase exits non-zero and pauses.
    });

    const state = await detectGitFileState(filePath);
    expect(state.inRepo).toBe(true);
    if (state.inRepo) {
      expect(state.midRebase).toBe(true);
    }
  });

  it("reports gitignored: true for a path excluded by .gitignore", async () => {
    const root = await makeTempRoot();
    await initRepo(root);
    await writeFile(path.join(root, ".gitignore"), "ignored.md\n", "utf8");
    await git(root, ["add", ".gitignore"]);
    await git(root, ["commit", "-m", "base"]);
    const filePath = path.join(root, "ignored.md");
    await writeFile(filePath, "content\n", "utf8");

    const state = await detectGitFileState(filePath);
    expect(state.inRepo).toBe(true);
    if (state.inRepo) {
      expect(state.gitignored).toBe(true);
    }
  });
});

describe("commitFile (#306 part 3/3, ADR 0075)", () => {
  it("commits exactly the target file, leaving an unrelated staged file untouched", async () => {
    const root = await makeTempRoot();
    await initRepo(root);
    const filePath = path.join(root, "workflow.md");
    const otherPath = path.join(root, "other.txt");
    await writeFile(filePath, "content\n", "utf8");
    await writeFile(otherPath, "other\n", "utf8");
    await git(root, ["add", "workflow.md", "other.txt"]);
    await git(root, ["commit", "-m", "base"]);
    await writeFile(filePath, "edited\n", "utf8");
    await writeFile(otherPath, "also edited\n", "utf8");
    await git(root, ["add", "other.txt"]);

    const result = await commitFile({
      filePath,
      message: "Edit workflow.md via the dashboard",
      repoRoot: root
    });

    expect(result.kind).toBe("committed");
    const status = await git(root, ["status", "--porcelain=v1"]);
    // workflow.md is now committed (no longer listed); other.txt's staged
    // edit is untouched by this commit, still shown as staged.
    expect(status).not.toContain("workflow.md");
    expect(status).toContain("other.txt");
  });

  it("commits exactly a filename containing a pathspec glob metacharacter, leaving an unrelated staged file untouched", async () => {
    const root = await makeTempRoot();
    await initRepo(root);
    const filePath = path.join(root, "template?.yaml");
    const otherPath = path.join(root, "templateA.yaml");
    await writeFile(filePath, "content\n", "utf8");
    await writeFile(otherPath, "other\n", "utf8");
    await git(root, ["add", "--", "template?.yaml", "templateA.yaml"]);
    await git(root, ["commit", "-m", "base"]);
    await writeFile(filePath, "edited\n", "utf8");
    await writeFile(otherPath, "also edited\n", "utf8");
    await git(root, ["add", "--", "templateA.yaml"]);

    const result = await commitFile({
      filePath,
      message: "Edit template?.yaml via the dashboard",
      repoRoot: root
    });

    expect(result.kind).toBe("committed");
    const status = await git(root, ["status", "--porcelain=v1"]);
    // Unescaped, "template?.yaml" is a pathspec glob that also matches
    // templateA.yaml -- a raw (non-literal) pathspec would sweep
    // templateA.yaml's separately staged edit into this commit too.
    expect(status).not.toContain("template?.yaml");
    expect(status).toContain("templateA.yaml");
  });

  it("refuses when the caller-supplied repoRoot disagrees with the file's actual repository", async () => {
    const root = await makeTempRoot();
    await initRepo(root);
    const otherRoot = await makeTempRoot();
    await initRepo(otherRoot);
    const filePath = path.join(root, "workflow.md");
    await writeFile(filePath, "content\n", "utf8");
    await git(root, ["add", "workflow.md"]);
    await git(root, ["commit", "-m", "base"]);
    await writeFile(filePath, "edited\n", "utf8");

    const result = await commitFile({
      filePath,
      message: "Edit workflow.md via the dashboard",
      repoRoot: otherRoot
    });

    expect(result).toMatchObject({ kind: "refused" });
    // Nothing was committed in either repository.
    expect(await git(root, ["rev-list", "--count", "HEAD"])).toBe("1");
    const status = await git(root, ["status", "--porcelain=v1"]);
    expect(status).toContain("workflow.md");
  });

  it("returns nothing_to_commit when the content is unchanged", async () => {
    const root = await makeTempRoot();
    await initRepo(root);
    const filePath = path.join(root, "workflow.md");
    await writeFile(filePath, "content\n", "utf8");
    await git(root, ["add", "workflow.md"]);
    await git(root, ["commit", "-m", "base"]);

    const result = await commitFile({
      filePath,
      message: "No-op save",
      repoRoot: root
    });

    expect(result).toEqual({ kind: "nothing_to_commit" });
  });

  it("refuses, preserving the staged edit, when the saved content matches HEAD", async () => {
    const root = await makeTempRoot();
    await initRepo(root);
    const filePath = path.join(root, "workflow.md");
    await writeFile(filePath, "content\n", "utf8");
    await git(root, ["add", "workflow.md"]);
    await git(root, ["commit", "-m", "base"]);
    await writeFile(filePath, "staged edit\n", "utf8");
    await git(root, ["add", "workflow.md"]);
    // Reverted to HEAD's content, so the index is the only place the
    // staged edit still exists.
    await writeFile(filePath, "content\n", "utf8");

    const result = await commitFile({
      filePath,
      message: "Save whose content matches HEAD",
      repoRoot: root
    });

    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.reason).toContain("staged edit");
    }
    expect(await git(root, ["show", ":workflow.md"])).toBe("staged edit");
    expect(await git(root, ["rev-list", "--count", "HEAD"])).toBe("1");
  });

  it("commits a file that was staged and then edited further", async () => {
    const root = await makeTempRoot();
    await initRepo(root);
    const filePath = path.join(root, "workflow.md");
    await writeFile(filePath, "content\n", "utf8");
    await git(root, ["add", "workflow.md"]);
    await git(root, ["commit", "-m", "base"]);
    await writeFile(filePath, "staged edit\n", "utf8");
    await git(root, ["add", "workflow.md"]);
    await writeFile(filePath, "staged edit, then more on top\n", "utf8");

    const result = await commitFile({
      filePath,
      message: "Save on top of a staged edit",
      repoRoot: root
    });

    expect(result.kind).toBe("committed");
    expect(await git(root, ["show", "HEAD:workflow.md"])).toBe(
      "staged edit, then more on top"
    );
  });

  it("refuses to commit while mid-rebase", async () => {
    const root = await makeTempRoot();
    await initRepo(root);
    const filePath = path.join(root, "shared.txt");
    await writeFile(filePath, "line1\n", "utf8");
    await git(root, ["add", "shared.txt"]);
    await git(root, ["commit", "-m", "base"]);
    await git(root, ["checkout", "-b", "feature"]);
    await writeFile(filePath, "line1\nfeature change\n", "utf8");
    await git(root, ["add", "shared.txt"]);
    await git(root, ["commit", "-m", "feature commit"]);
    await git(root, ["checkout", "main"]);
    await writeFile(filePath, "line1\nmain change\n", "utf8");
    await git(root, ["add", "shared.txt"]);
    await git(root, ["commit", "-m", "main commit"]);
    await git(root, ["checkout", "feature"]);
    await execFileAsync("git", ["-C", root, "rebase", "main"]).catch(() => {
      // Expected: the conflicting rebase exits non-zero and pauses.
    });

    const result = await commitFile({
      filePath,
      message: "Attempted save during a rebase",
      repoRoot: root
    });

    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.reason).toContain("mid-rebase");
    }
  });
});
