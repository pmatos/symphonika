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

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args);
  return stdout.trim();
}
