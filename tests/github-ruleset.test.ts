import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const configureScript = path.join(
  repoRoot,
  "scripts/configure-main-ruleset.mjs"
);
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("main branch ruleset configuration", () => {
  it("requires the GitHub Actions ADR check against the latest base", () => {
    const root = mkdtempSync(path.join(tmpdir(), "symphonika-ruleset-"));
    const binDirectory = path.join(root, "bin");
    const callsPath = path.join(root, "calls.txt");
    const inputPath = path.join(root, "input.json");
    const ghPath = path.join(binDirectory, "gh");
    tempRoots.push(root);
    mkdirSync(binDirectory);
    writeFileSync(
      ghPath,
      `#!/bin/sh
if [ "$2" = "repos/pmatos/symphonika/rulesets" ]; then
  printf '%s' '[{"id":15731127,"name":"main","target":"branch"}]'
  exit 0
fi
printf '%s\\n' "$@" > "$GH_CALLS_PATH"
tee "$GH_INPUT_PATH" >/dev/null
printf '%s' '{"id":15731127}'
`,
      "utf8"
    );
    chmodSync(ghPath, 0o755);

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
    expect(JSON.parse(readFileSync(inputPath, "utf8"))).toEqual({
      name: "main",
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: {
        ref_name: {
          exclude: [],
          include: ["~DEFAULT_BRANCH"]
        }
      },
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        {
          type: "required_status_checks",
          parameters: {
            do_not_enforce_on_create: false,
            required_status_checks: [
              { context: "ADR numbers", integration_id: 15368 }
            ],
            strict_required_status_checks_policy: true
          }
        }
      ]
    });
    expect(result.stdout).toContain("Updated main ruleset 15731127");
  });
});
