import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitWorkspaceFixture = {
  baseBranch?: string;
  branchName: string;
  workspacePath: string;
};

export async function createGitWorkspaceAhead(
  fixture: GitWorkspaceFixture
): Promise<void> {
  await createGitWorkspace(fixture, { commitWork: true });
}

export async function createGitWorkspaceAtBase(
  fixture: GitWorkspaceFixture
): Promise<void> {
  await createGitWorkspace(fixture, { commitWork: false });
}

async function createGitWorkspace(
  fixture: GitWorkspaceFixture,
  options: { commitWork: boolean }
): Promise<void> {
  const baseBranch = fixture.baseBranch ?? "main";
  await mkdir(path.dirname(fixture.workspacePath), { recursive: true });
  await git([
    "init",
    "--initial-branch",
    fixture.branchName,
    fixture.workspacePath
  ]);
  await git([
    "-C",
    fixture.workspacePath,
    "config",
    "user.email",
    "test@example.com"
  ]);
  await git([
    "-C",
    fixture.workspacePath,
    "config",
    "user.name",
    "Symphonika Test"
  ]);
  await writeFile(path.join(fixture.workspacePath, "README.md"), "# Fixture\n");
  await git(["-C", fixture.workspacePath, "add", "README.md"]);
  await git(["-C", fixture.workspacePath, "commit", "-m", "Base"]);
  const baseSha = await git(["-C", fixture.workspacePath, "rev-parse", "HEAD"]);
  await git([
    "-C",
    fixture.workspacePath,
    "update-ref",
    `refs/remotes/origin/${baseBranch}`,
    baseSha
  ]);

  if (!options.commitWork) {
    return;
  }

  await writeFile(path.join(fixture.workspacePath, "agent-work.txt"), "done\n");
  await git(["-C", fixture.workspacePath, "add", "agent-work.txt"]);
  await git(["-C", fixture.workspacePath, "commit", "-m", "Agent work"]);
}

// Mirrors the real jsse reflogs behind symphonika#806: the attempt captures
// headShaAtStart right after the plan-stage commit, then does real work, then
// (because origin/<base> advanced while the agent was working) rebases its
// branch onto the new base before pushing. Returns the pre-rebase SHA the
// caller passes as `headShaAtStart`, so the fixture proves the check survives
// history rewriting rather than only a fast-forward.
export async function createGitWorkspaceRebasedOntoAdvancedBase(
  fixture: GitWorkspaceFixture
): Promise<{ headShaAtStart: string }> {
  const baseBranch = fixture.baseBranch ?? "main";
  await mkdir(path.dirname(fixture.workspacePath), { recursive: true });
  await git([
    "init",
    "--initial-branch",
    fixture.branchName,
    fixture.workspacePath
  ]);
  await git([
    "-C",
    fixture.workspacePath,
    "config",
    "user.email",
    "test@example.com"
  ]);
  await git([
    "-C",
    fixture.workspacePath,
    "config",
    "user.name",
    "Symphonika Test"
  ]);
  await writeFile(path.join(fixture.workspacePath, "README.md"), "# Fixture\n");
  await git(["-C", fixture.workspacePath, "add", "README.md"]);
  await git(["-C", fixture.workspacePath, "commit", "-m", "Base"]);
  const baseSha = await git(["-C", fixture.workspacePath, "rev-parse", "HEAD"]);
  await git([
    "-C",
    fixture.workspacePath,
    "update-ref",
    `refs/remotes/origin/${baseBranch}`,
    baseSha
  ]);

  // The attempt's own first commit (e.g. the plan-stage handoff). This is the
  // SHA headShaAtAttemptStart captures in the real run-controller.
  await writeFile(path.join(fixture.workspacePath, "PLAN.md"), "plan\n");
  await git(["-C", fixture.workspacePath, "add", "PLAN.md"]);
  await git([
    "-C",
    fixture.workspacePath,
    "commit",
    "-m",
    "docs(plan): add plan"
  ]);
  const headShaAtStart = await git([
    "-C",
    fixture.workspacePath,
    "rev-parse",
    "HEAD"
  ]);

  // Real work landed after the captured start SHA, still on the branch.
  await writeFile(path.join(fixture.workspacePath, "agent-work.txt"), "done\n");
  await git(["-C", fixture.workspacePath, "add", "agent-work.txt"]);
  await git(["-C", fixture.workspacePath, "commit", "-m", "Agent work"]);

  // Upstream base advances independently (a detached commit off the original
  // Base, never touching the feature branch) while the agent is still
  // working, exactly like other PRs merging into origin/main mid-attempt.
  await git(["-C", fixture.workspacePath, "checkout", "--detach", baseSha]);
  await writeFile(path.join(fixture.workspacePath, "upstream.txt"), "new\n");
  await git(["-C", fixture.workspacePath, "add", "upstream.txt"]);
  await git(["-C", fixture.workspacePath, "commit", "-m", "Upstream advance"]);
  const advancedBaseSha = await git([
    "-C",
    fixture.workspacePath,
    "rev-parse",
    "HEAD"
  ]);
  await git([
    "-C",
    fixture.workspacePath,
    "update-ref",
    `refs/remotes/origin/${baseBranch}`,
    advancedBaseSha
  ]);
  await git(["-C", fixture.workspacePath, "checkout", fixture.branchName]);

  // Rebase the branch onto the now-advanced base — rewrites history, so the
  // captured headShaAtStart is no longer an ancestor of the resulting HEAD.
  await git(["-C", fixture.workspacePath, "rebase", `origin/${baseBranch}`]);

  return { headShaAtStart };
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args);
  return stdout.trim();
}
