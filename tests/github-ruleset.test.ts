import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeStubExecutables } from "./helpers/doctor-environment.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const configureScript = path.join(
  repoRoot,
  "scripts/configure-main-ruleset.mjs"
);
const rulesetConfigPath = path.join(repoRoot, ".github/rulesets/main.json");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("main branch ruleset configuration", () => {
  it("PUTs the configured ruleset payload to the matched ruleset id", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "symphonika-ruleset-"));
    const binDirectory = path.join(root, "bin");
    const callsPath = path.join(root, "calls.txt");
    const inputPath = path.join(root, "input.json");
    tempRoots.push(root);
    await writeStubExecutables(
      binDirectory,
      ["gh"],
      `#!/bin/sh
if [ "$2" = "repos/pmatos/symphonika/rulesets" ]; then
  printf '%s' '[{"id":15731127,"name":"main","target":"branch"}]'
  exit 0
fi
printf '%s\\n' "$@" > "$GH_CALLS_PATH"
cat > "$GH_INPUT_PATH"
`
    );

    const result = spawnSync(process.execPath, [configureScript], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GH_CALLS_PATH: callsPath,
        GH_INPUT_PATH: inputPath,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`
      }
    });

    expect(result.status).toBe(0);
    expect(readFileSync(callsPath, "utf8").trim().split("\n")).toEqual([
      "api",
      "--method",
      "PUT",
      "repos/pmatos/symphonika/rulesets/15731127",
      "--input",
      "-"
    ]);
    expect(JSON.parse(readFileSync(inputPath, "utf8"))).toEqual(
      JSON.parse(readFileSync(rulesetConfigPath, "utf8"))
    );
    expect(result.stdout).toContain("Updated main ruleset 15731127");
  });
});
