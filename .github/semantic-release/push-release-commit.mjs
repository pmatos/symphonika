import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * @typedef {object} ReleaseContext
 * @property {NodeJS.ProcessEnv} [env]
 * @property {{log: (message: string) => void, warn: (message: string) => void}} logger
 * @property {{notes: string, version: string}} nextRelease
 */

const ALLOWED_RELEASE_FILES = new Set([
  "CHANGELOG.md",
  "package-lock.json",
  "package.json"
]);
const CHECK_NAME = "ADR numbers";
const askpassPath = fileURLToPath(
  new URL("./github-token-askpass.sh", import.meta.url)
);

/**
 * @param {Record<string, unknown>} _pluginConfig
 * @param {ReleaseContext} context
 */
export function prepare(_pluginConfig, context) {
  const env = context.env ?? process.env;
  if (env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("release job must run from refs/heads/main");
  }
  const repository = requireEnvironment(env, "GITHUB_REPOSITORY");
  const runId = requireEnvironment(env, "GITHUB_RUN_ID");
  const runAttempt = requireEnvironment(env, "GITHUB_RUN_ATTEMPT");
  requireEnvironment(env, "GITHUB_TOKEN");
  const serverUrl = env.GITHUB_SERVER_URL ?? "https://github.com";
  const gitEnvironment = {
    ...process.env,
    ...env,
    GIT_ASKPASS: askpassPath,
    GIT_TERMINAL_PROMPT: "0"
  };
  const baseSha = git(["rev-parse", "origin/main"], gitEnvironment);

  if (git(["rev-parse", "HEAD"], gitEnvironment) !== baseSha) {
    throw new Error("release checkout is not the current origin/main commit");
  }

  git(
    ["add", "--", "CHANGELOG.md", "package-lock.json", "package.json"],
    gitEnvironment
  );
  const stagedFiles = git(["diff", "--cached", "--name-only"], gitEnvironment)
    .split("\n")
    .filter(Boolean);
  if (
    stagedFiles.length === 0 ||
    stagedFiles.some((file) => !ALLOWED_RELEASE_FILES.has(file))
  ) {
    throw new Error(
      `release commit contains unexpected staged files: ${stagedFiles.join(", ") || "none"}`
    );
  }

  const message = `chore(release): ${context.nextRelease.version} [skip ci]\n\n${context.nextRelease.notes}`;
  git(["commit", "-m", message], {
    ...gitEnvironment,
    GIT_AUTHOR_EMAIL: "semantic-release-bot@martynus.net",
    GIT_AUTHOR_NAME: "@semantic-release-bot",
    GIT_COMMITTER_EMAIL: "semantic-release-bot@martynus.net",
    GIT_COMMITTER_NAME: "@semantic-release-bot"
  });

  const releaseSha = git(["rev-parse", "HEAD"], gitEnvironment);
  if (git(["rev-parse", "HEAD^"], gitEnvironment) !== baseSha) {
    throw new Error("release commit is not a direct child of origin/main");
  }

  run(
    "npm",
    ["run", "check:adr-numbers", "--", "--base", baseSha],
    gitEnvironment
  );

  const temporaryBranch = `semantic-release-check/${runId}-${runAttempt}`;
  const repositoryUrl = `${serverUrl}/${repository}.git`;
  let temporaryBranchPushed = false;

  try {
    gitPush(
      repositoryUrl,
      `HEAD:refs/heads/${temporaryBranch}`,
      gitEnvironment
    );
    temporaryBranchPushed = true;

    const checkRun = {
      conclusion: "success",
      details_url: `${serverUrl}/${repository}/actions/runs/${runId}`,
      external_id: `semantic-release:${runId}:${runAttempt}`,
      head_sha: releaseSha,
      name: CHECK_NAME,
      output: {
        summary: `Validated release commit ${releaseSha} against ${baseSha}.`,
        title: "Release commit has unambiguous ADR numbers"
      },
      status: "completed"
    };
    /** @type {unknown} */
    const createdCheck = JSON.parse(
      gh(
        [
          "api",
          "--method",
          "POST",
          `repos/${repository}/check-runs`,
          "--input",
          "-"
        ],
        gitEnvironment,
        JSON.stringify(checkRun)
      )
    );
    if (
      !isRecord(createdCheck) ||
      !isRecord(createdCheck.app) ||
      createdCheck.app.id !== 15368
    ) {
      throw new Error(
        `${CHECK_NAME} check was not attributed to GitHub Actions app 15368`
      );
    }
    if (
      createdCheck.name !== CHECK_NAME ||
      createdCheck.head_sha !== releaseSha ||
      createdCheck.status !== "completed" ||
      createdCheck.conclusion !== "success"
    ) {
      throw new Error(
        `${CHECK_NAME} check was not completed successfully for ${releaseSha}`
      );
    }

    gitPush(repositoryUrl, "HEAD:refs/heads/main", gitEnvironment);
    context.logger.log(
      `Pushed release commit ${releaseSha} after ${CHECK_NAME} succeeded.`
    );
  } finally {
    if (temporaryBranchPushed) {
      try {
        gh(
          [
            "api",
            "--method",
            "DELETE",
            `repos/${repository}/git/refs/heads/${temporaryBranch}`
          ],
          gitEnvironment
        );
      } catch (error) {
        context.logger.warn(
          `Could not remove temporary release branch ${temporaryBranch}: ${errorMessage(error)}`
        );
      }
    }
  }
}

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
function git(args, env) {
  return run("git", args, env).trim();
}

/**
 * @param {string} repositoryUrl
 * @param {string} refspec
 * @param {NodeJS.ProcessEnv} env
 */
function gitPush(repositoryUrl, refspec, env) {
  run("git", ["-c", "credential.helper=", "push", repositoryUrl, refspec], env);
}

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [input]
 */
function gh(args, env, input) {
  return run("gh", args, env, input);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [input]
 */
function run(command, args, env, input) {
  return execFileSync(command, args, {
    encoding: "utf8",
    env,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"]
  });
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 */
function requireEnvironment(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required to push a release commit`);
  }
  return value;
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
