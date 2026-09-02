import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { writeStubExecutables } from "./helpers/doctor-environment.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const releasePluginPath = path.join(
  repoRoot,
  ".github/semantic-release/push-release-commit.mjs"
);
const tempRoots: string[] = [];

type ReleaseContext = {
  env: NodeJS.ProcessEnv;
  logger: { log: () => void; warn: () => void };
  nextRelease: { notes: string; version: string };
};

type ReleasePlugin = {
  prepare: (config: Record<string, never>, context: ReleaseContext) => void;
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("release workflow", () => {
  it("routes release commits through the required check only from main", () => {
    const releaseConfig = parseJson(
      readFileSync(path.join(repoRoot, ".releaserc.json"), "utf8")
    );
    if (
      typeof releaseConfig !== "object" ||
      releaseConfig === null ||
      !("plugins" in releaseConfig) ||
      !Array.isArray(releaseConfig.plugins)
    ) {
      throw new Error("release config must declare a plugins array");
    }
    const pluginNames: unknown[] = releaseConfig.plugins.map(
      (plugin: unknown): unknown =>
        Array.isArray(plugin) ? (plugin as unknown[])[0] : plugin
    );
    const releaseWorkflow = readFileSync(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8"
    );

    expect({
      checksPermission: /permissions:\n(?:.*\n)*? {6}checks: write/.test(
        releaseWorkflow
      ),
      customPlugin: pluginNames.includes(
        "./.github/semantic-release/push-release-commit.mjs"
      ),
      defaultGitPlugin: pluginNames.includes("@semantic-release/git"),
      mainOnly: releaseWorkflow.includes("if: github.ref == 'refs/heads/main'")
    }).toEqual({
      checksPermission: true,
      customPlugin: true,
      defaultGitPlugin: false,
      mainOnly: true
    });
  });

  it("refuses a release dispatch from a non-main ref", async () => {
    const harness = await makeReleaseHarness();

    expect(() =>
      harness.plugin.prepare(
        {},
        {
          ...harness.context,
          env: {
            ...harness.context.env,
            GITHUB_REF: "refs/heads/unreviewed"
          }
        }
      )
    ).toThrow("release job must run from refs/heads/main");
    expect(existsSync(harness.callsPath)).toBe(false);
  });

  it("refuses a required check attributed to another app", async () => {
    const harness = await makeReleaseHarness("999");

    expect(() => harness.plugin.prepare({}, harness.context)).toThrow(
      "ADR numbers check was not attributed to GitHub Actions app 15368"
    );

    const calls = readFileSync(harness.callsPath, "utf8").trim().split("\n");
    expect({
      cleanedTemporaryRef: calls.some((call) => call.includes("\tDELETE\t")),
      updatedMain: calls.some((call) => call.endsWith("HEAD:refs/heads/main"))
    }).toEqual({ cleanedTemporaryRef: true, updatedMain: false });
  });

  it("validates and certifies the release commit before updating main", async () => {
    const harness = await makeReleaseHarness();

    harness.plugin.prepare({}, harness.context);

    const calls = readFileSync(harness.callsPath, "utf8").trim().split("\n");
    const validationIndex = calls.indexOf(
      "npm\trun\tcheck:adr-numbers\t--\t--base\taaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    const temporaryPushIndex = calls.findIndex((call) =>
      call.endsWith("HEAD:refs/heads/semantic-release-check/123-2")
    );
    const createCheckIndex = calls.findIndex((call) =>
      call.includes("\tPOST\trepos/pmatos/symphonika/check-runs")
    );
    const mainPushIndex = calls.findIndex((call) =>
      call.endsWith("HEAD:refs/heads/main")
    );
    const cleanupIndex = calls.findIndex((call) =>
      call.includes(
        "\tDELETE\trepos/pmatos/symphonika/git/refs/heads/semantic-release-check/123-2"
      )
    );

    expect({
      checkInput: parseJson(readFileSync(harness.checkInputPath, "utf8")),
      commandsFound: [
        validationIndex,
        temporaryPushIndex,
        createCheckIndex,
        mainPushIndex,
        cleanupIndex
      ].every((index) => index >= 0),
      ordered:
        validationIndex < temporaryPushIndex &&
        temporaryPushIndex < createCheckIndex &&
        createCheckIndex < mainPushIndex &&
        mainPushIndex < cleanupIndex,
      tokenExposed: calls.join("\n").includes("test-token")
    }).toMatchObject({
      checkInput: {
        conclusion: "success",
        head_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        name: "ADR numbers",
        status: "completed"
      },
      commandsFound: true,
      ordered: true,
      tokenExposed: false
    });
  });
});

async function makeReleaseHarness(checkAppId = "15368"): Promise<{
  callsPath: string;
  checkInputPath: string;
  context: ReleaseContext;
  plugin: ReleasePlugin;
}> {
  const root = mkdtempSync(path.join(tmpdir(), "symphonika-release-"));
  const binDirectory = path.join(root, "bin");
  const callsPath = path.join(root, "calls.txt");
  const committedPath = path.join(root, "committed");
  const checkInputPath = path.join(root, "check-input.json");
  tempRoots.push(root);
  await writeStubExecutables(
    binDirectory,
    ["gh", "git", "npm"],
    `#!/bin/sh
command_name="$(basename "$0")"
printf '%s' "$command_name" >> "$CALLS_PATH"
for argument in "$@"; do
  printf '\\t%s' "$argument" >> "$CALLS_PATH"
done
printf '\\n' >> "$CALLS_PATH"

if [ "$command_name" = "git" ] && [ "$1" = "rev-parse" ]; then
  if [ "$2" = "HEAD" ] && [ -f "$COMMITTED_PATH" ]; then
    printf '%s\\n' 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  else
    printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  fi
  exit 0
fi

if [ "$command_name" = "git" ] && [ "$1" = "diff" ]; then
  printf '%s\\n' 'CHANGELOG.md' 'package-lock.json' 'package.json'
  exit 0
fi

if [ "$command_name" = "git" ] && [ "$1" = "commit" ]; then
  : > "$COMMITTED_PATH"
  exit 0
fi

if [ "$command_name" = "gh" ] && [ "$3" = "POST" ]; then
  cat > "$CHECK_INPUT_PATH"
  printf '{"name":"ADR numbers","head_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","status":"completed","conclusion":"success","app":{"id":%s}}' "$CHECK_APP_ID"
  exit 0
fi

if [ "$command_name" = "gh" ] && [ "$3" = "DELETE" ]; then
  printf '%s' '{}'
  exit 0
fi
`
  );

  const plugin = (await import(
    `${pathToFileURL(releasePluginPath).href}?test=${Date.now()}-${Math.random()}`
  )) as ReleasePlugin;
  const context: ReleaseContext = {
    env: {
      ...process.env,
      CALLS_PATH: callsPath,
      CHECK_APP_ID: checkAppId,
      CHECK_INPUT_PATH: checkInputPath,
      COMMITTED_PATH: committedPath,
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: "pmatos/symphonika",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "123",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_TOKEN: "test-token",
      PATH: `${binDirectory}:${process.env.PATH ?? ""}`
    },
    logger: { log: () => undefined, warn: () => undefined },
    nextRelease: { notes: "Release notes", version: "0.2.0" }
  };

  return { callsPath, checkInputPath, context, plugin };
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
