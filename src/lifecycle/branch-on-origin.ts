import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Logger } from "pino";

import {
  tryListBranchCommits,
  type GitHubIssueRepositoryInput,
  type GitHubIssuesApi
} from "../issue-polling.js";

const execFileAsync = promisify(execFile);

export type BranchPublication =
  | { kind: "published" }
  | { kind: "missing" }
  | { kind: "stale"; localSha: string; originSha: string }
  | { kind: "unverified" };

export type VerifyBranchPublishedInput = {
  api: GitHubIssuesApi;
  branch: string;
  logger?: Logger | undefined;
  repository: GitHubIssueRepositoryInput;
  timeoutMs: number;
  workspacePath: string;
};

// Fail-open: anything that stops us from proving the branch is absent or
// behind (no API, a GitHub error, a timeout, an unreadable local HEAD) reads
// `unverified`, so an outage never turns a good run into a failure.
export async function verifyBranchPublished(
  input: VerifyBranchPublishedInput
): Promise<BranchPublication> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      lookup(input),
      new Promise<BranchPublication>((resolve) => {
        timer = setTimeout(
          () => resolve({ kind: "unverified" }),
          input.timeoutMs
        );
      })
    ]);
  } catch (error) {
    input.logger?.warn(
      { branch: input.branch, err: error },
      "branch publication check failed; treating as unverified"
    );
    return { kind: "unverified" };
  } finally {
    clearTimeout(timer);
  }
}

async function lookup(
  input: VerifyBranchPublishedInput
): Promise<BranchPublication> {
  const commits = await tryListBranchCommits(input.api, {
    ...input.repository,
    branch: input.branch,
    perPage: 1
  });
  if (commits === undefined) {
    return { kind: "unverified" };
  }
  if (commits === null || commits.length === 0) {
    return { kind: "missing" };
  }
  const originSha = commits[0]?.sha;
  if (originSha === undefined) {
    return { kind: "unverified" };
  }
  const { stdout } = await execFileAsync("git", [
    "-C",
    input.workspacePath,
    "rev-parse",
    "HEAD"
  ]);
  const localSha = stdout.trim();
  return localSha === originSha
    ? { kind: "published" }
    : { kind: "stale", localSha, originSha };
}
