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
  it("uses the custom release-commit plugin only from main", () => {
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
      customPlugin: pluginNames.includes(
        "./.github/semantic-release/push-release-commit.mjs"
      ),
      defaultGitPlugin: pluginNames.includes("@semantic-release/git"),
      mainOnly: releaseWorkflow.includes("if: github.ref == 'refs/heads/main'")
    }).toEqual({
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

  it("commits and pushes the release straight to main", async () => {
    const harness = await makeReleaseHarness();

    harness.plugin.prepare({}, harness.context);

    const calls = readFileSync(harness.callsPath, "utf8").trim().split("\n");
    const commitIndex = calls.findIndex((call) =>
      call.startsWith("git\tcommit\t-m\tchore(release): 0.2.0 [skip ci]")
    );
    const mainPushIndex = calls.findIndex((call) =>
      call.endsWith("HEAD:refs/heads/main")
    );

    expect({
      commandsFound: [commitIndex, mainPushIndex].every((index) => index >= 0),
      ordered: commitIndex < mainPushIndex,
      tokenExposed: calls.join("\n").includes("test-token")
    }).toEqual({
      commandsFound: true,
      ordered: true,
      tokenExposed: false
    });
  });
});

async function makeReleaseHarness(): Promise<{
  callsPath: string;
  context: ReleaseContext;
  plugin: ReleasePlugin;
}> {
  const root = mkdtempSync(path.join(tmpdir(), "symphonika-release-"));
  const binDirectory = path.join(root, "bin");
  const callsPath = path.join(root, "calls.txt");
  const committedPath = path.join(root, "committed");
  tempRoots.push(root);
  await writeStubExecutables(
    binDirectory,
    ["git"],
    `#!/bin/sh
command_name="$(basename "$0")"
printf '%s' "$command_name" >> "$CALLS_PATH"
for argument in "$@"; do
  printf '\\t%s' "$argument" >> "$CALLS_PATH"
done
printf '\\n' >> "$CALLS_PATH"

if [ "$1" = "rev-parse" ]; then
  if [ "$2" = "HEAD" ] && [ -f "$COMMITTED_PATH" ]; then
    printf '%s\\n' 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  else
    printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  fi
  exit 0
fi

if [ "$1" = "diff" ]; then
  printf '%s\\n' 'CHANGELOG.md' 'package-lock.json' 'package.json'
  exit 0
fi

if [ "$1" = "commit" ]; then
  : > "$COMMITTED_PATH"
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
      COMMITTED_PATH: committedPath,
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: "pmatos/symphonika",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_TOKEN: "test-token",
      PATH: `${binDirectory}:${process.env.PATH ?? ""}`
    },
    logger: { log: () => undefined, warn: () => undefined },
    nextRelease: { notes: "Release notes", version: "0.2.0" }
  };

  return { callsPath, context, plugin };
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}
