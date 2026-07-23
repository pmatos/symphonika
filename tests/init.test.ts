import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { runInit } from "../src/init.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("global initialization", () => {
  it("uses interactive answers for cross-project settings", async () => {
    const root = await makeTempRoot();
    const configHome = path.join(root, "config");
    const answers: Record<string, string> = {
      claudeCommand: "custom-claude --stream",
      codexCommand: "custom-codex app-server",
      mergeEnabled: "yes",
      mergeMethod: "rebase",
      pollingIntervalMs: "45000",
      requireReviewDecision: "yes",
      requireStatusSuccess: "no",
      stateRoot: path.join(root, "custom-state")
    };
    const prompted: string[] = [];

    const report = await runInit({
      env: { XDG_CONFIG_HOME: configHome },
      homeDir: root,
      prompt: (input) => {
        prompted.push(input.key);
        return Promise.resolve(answers[input.key] ?? "");
      }
    });

    expect(report.ok).toBe(true);
    const config = parse(await readFile(report.configPath, "utf8")) as {
      polling: { interval_ms: number };
      projects: unknown[];
      providers: Record<string, { command: string }>;
      pull_requests: {
        merge: {
          enabled: boolean;
          method: string;
          require_review_decision: boolean;
          require_status_success: boolean;
        };
      };
      state: { root: string };
    };
    expect(config).toMatchObject({
      polling: { interval_ms: 45000 },
      projects: [],
      providers: {
        claude: { command: "custom-claude --stream" },
        codex: { command: "custom-codex app-server" }
      },
      pull_requests: {
        merge: {
          enabled: true,
          method: "rebase",
          require_review_decision: true,
          require_status_success: false
        }
      },
      state: { root: path.join(root, "custom-state") }
    });
    expect(prompted).toEqual([
      "stateRoot",
      "pollingIntervalMs",
      "mergeEnabled",
      "mergeMethod",
      "requireStatusSuccess",
      "requireReviewDecision",
      "codexCommand",
      "claudeCommand"
    ]);
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-init-test-"));
  tempRoots.push(root);
  return root;
}
