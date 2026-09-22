import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { inspectWorkspaceContentDigest } from "../../src/lifecycle/classify-failure.js";
import { gitSucceeds } from "../../src/workspace.js";

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

// Shared by every fixture below: init the repo, configure the test identity,
// commit a Base, and point refs/remotes/origin/<base> at it. Returns the
// resolved base branch name and the Base commit's SHA.
async function initBaseRepo(
  fixture: GitWorkspaceFixture
): Promise<{ baseBranch: string; baseSha: string }> {
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
  return { baseBranch, baseSha };
}

async function createGitWorkspace(
  fixture: GitWorkspaceFixture,
  options: { commitWork: boolean }
): Promise<void> {
  await initBaseRepo(fixture);

  if (!options.commitWork) {
    return;
  }

  await commitAgentWork(fixture);
}

async function commitAgentWork(fixture: GitWorkspaceFixture): Promise<void> {
  await writeFile(path.join(fixture.workspacePath, "agent-work.txt"), "done\n");
  await git(["-C", fixture.workspacePath, "add", "agent-work.txt"]);
  await git(["-C", fixture.workspacePath, "commit", "-m", "Agent work"]);
}

// The snapshot pair run-controller.ts captures before the provider runs:
// headShaAtStart is used only by fixtures/tests to pin that a later step
// genuinely rewrote history (via isAncestor); contentDigestAtStart is what
// classifyFailure itself compares.
async function captureAttemptStartSnapshot(
  fixture: GitWorkspaceFixture,
  baseBranch: string
): Promise<{ contentDigestAtStart: string; headShaAtStart: string }> {
  const headShaAtStart = await git([
    "-C",
    fixture.workspacePath,
    "rev-parse",
    "HEAD"
  ]);
  const contentDigestAtStart = await inspectWorkspaceContentDigest({
    baseBranch,
    workspacePath: fixture.workspacePath
  });
  return { contentDigestAtStart, headShaAtStart };
}

// Mirrors the real jsse reflogs behind symphonika#806: the attempt captures
// its start snapshot right after the plan-stage commit, then does real work,
// then (because origin/<base> advanced while the agent was working) rebases
// its branch onto the new base before pushing. Returns the pre-rebase
// snapshot the caller passes to classifyFailure, so the fixture proves the
// check survives history rewriting rather than only a fast-forward. Only the
// "Agent work" step writes real file content — the plan and upstream-advance
// commits are `--allow-empty`, since their tree content isn't what's under
// test.
export async function createGitWorkspaceRebasedOntoAdvancedBase(
  fixture: GitWorkspaceFixture
): Promise<{ contentDigestAtStart: string; headShaAtStart: string }> {
  const { baseBranch, baseSha } = await initBaseRepo(fixture);

  // The attempt's own first commit (e.g. the plan-stage handoff) — this is
  // where the real run-controller snapshots before the provider (and any
  // rebase it does) runs.
  await git([
    "-C",
    fixture.workspacePath,
    "commit",
    "--allow-empty",
    "-m",
    "docs(plan): add plan"
  ]);
  const startSnapshot = await captureAttemptStartSnapshot(fixture, baseBranch);

  // Real work landed after the captured start SHA, still on the branch.
  await commitAgentWork(fixture);

  // Upstream base advances independently (a detached commit off the original
  // Base, never touching the feature branch) while the agent is still
  // working, exactly like other PRs merging into origin/main mid-attempt.
  await git(["-C", fixture.workspacePath, "checkout", "--detach", baseSha]);
  await git([
    "-C",
    fixture.workspacePath,
    "commit",
    "--allow-empty",
    "-m",
    "Upstream advance"
  ]);
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

  return startSnapshot;
}

// Reproduces the failure mode the digest check exists to catch: a commit
// --amend that changes only the message, not the tree. HEAD's SHA changes;
// its content doesn't. Returns the pre-amend snapshot alongside proof (via
// isAncestor) that the amend really did rewrite HEAD's SHA, so this fixture
// can't silently degrade into a same-SHA no-op that would pass for a
// different, uninteresting reason.
export async function createGitWorkspaceAmendedWithoutContentChange(
  fixture: GitWorkspaceFixture
): Promise<{ contentDigestAtStart: string; headShaAtStart: string }> {
  const { baseBranch } = await initBaseRepo(fixture);

  await commitAgentWork(fixture);
  const startSnapshot = await captureAttemptStartSnapshot(fixture, baseBranch);

  await git([
    "-C",
    fixture.workspacePath,
    "commit",
    "--amend",
    "-m",
    "Agent work (reworded, no content change)"
  ]);

  return startSnapshot;
}

// Pins the exact invariant createGitWorkspaceRebasedOntoAdvancedBase's rebase step
// is meant to exercise: `ancestor` must no longer reach `descendant` through parent
// links once history has been rewritten. Without this, a fixture that silently
// degraded to a fast-forward would still pass a test that only checks SHA
// inequality, quietly losing coverage of the actual symphonika#806 regression.
export async function isAncestor(
  workspacePath: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  return gitSucceeds([
    "-C",
    workspacePath,
    "merge-base",
    "--is-ancestor",
    ancestor,
    descendant
  ]);
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args);
  return stdout.trim();
}
