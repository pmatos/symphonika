import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const checkScript = path.resolve(
  import.meta.dirname,
  "../scripts/check-adr-numbers.mjs"
);
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("ADR number validation", () => {
  it("rejects a number allocated concurrently on the current base branch", () => {
    const repo = makeRepository();
    commitAdr(repo, "0001-existing.md");

    git(repo, "checkout", "-b", "feature");
    commitAdr(repo, "0002-feature-decision.md");

    git(repo, "checkout", "main");
    commitAdr(repo, "0002-base-decision.md");
    git(repo, "checkout", "feature");

    const result = spawnSync(
      process.execPath,
      [checkScript, "--base", "main"],
      { cwd: repo, encoding: "utf8" }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "ADR number 0002 would be ambiguous after merge"
    );
    expect(result.stderr).toContain("docs/adr/0002-base-decision.md");
    expect(result.stderr).toContain("docs/adr/0002-feature-decision.md");
  });
});

function makeRepository(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "symphonika-adr-numbering-"));
  tempRoots.push(repo);
  git(repo, "init", "--initial-branch", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Symphonika Test");
  return repo;
}

function commitAdr(repo: string, filename: string): void {
  const adrDirectory = path.join(repo, "docs", "adr");
  mkdirSync(adrDirectory, { recursive: true });
  writeFileSync(path.join(adrDirectory, filename), `# ${filename}\n`, "utf8");
  git(repo, "add", path.join("docs", "adr", filename));
  git(repo, "commit", "-m", `add ${filename}`);
}

function git(repo: string, ...args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}
