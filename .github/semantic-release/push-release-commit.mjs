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

  const repositoryUrl = `${serverUrl}/${repository}.git`;
  gitPush(repositoryUrl, "HEAD:refs/heads/main", gitEnvironment);
  context.logger.log(`Pushed release commit ${releaseSha} to main.`);
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
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
function run(command, args, env) {
  return execFileSync(command, args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "inherit"]
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
