import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { issueFiltersSchema } from "../src/config-schemas.js";
import { RuntimeConfigReloader } from "../src/reload.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function loadWithFilterLines(filterLines: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-ready-label-"));
  tempRoots.push(root);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "WORKFLOW.md"), "Work on {{issue.title}}.\n");
  await writeFile(
    path.join(root, "symphonika.yml"),
    [
      "state:",
      "  root: ./.symphonika",
      "polling:",
      "  interval_ms: 1000",
      "providers:",
      "  codex:",
      '    command: "codex -p symphonika"',
      "  claude:",
      '    command: "claude -p"',
      "projects:",
      "  - name: symphonika",
      "    tracker:",
      "      kind: github",
      "      owner: pmatos",
      "      repo: symphonika",
      '      token: "$GITHUB_TOKEN"',
      "    issue_filters:",
      '      states: ["open"]',
      ...filterLines,
      '      labels_none: ["blocked"]',
      "    priority:",
      "      labels: {}",
      "      default: 99",
      "    workspace:",
      "      root: ./.symphonika/workspaces/symphonika",
      "      git:",
      "        remote: git@github.com:pmatos/symphonika.git",
      "        base_branch: main",
      "    agent:",
      "      provider: codex",
      "    workflow: ./WORKFLOW.md",
      ""
    ].join("\n")
  );
  const reloader = new RuntimeConfigReloader({
    configPath: path.join(root, "symphonika.yml")
  });
  await reloader.reload();
  return reloader;
}

describe("ready_label config migration", () => {
  it("keeps a single legacy labels_all value unchanged without a warning", async () => {
    const reloader = await loadWithFilterLines(['      labels_all: ["ship-it"]']);

    const filters = reloader.getSnapshot()?.polling.projects[0]?.issue_filters;
    expect(filters?.ready_label).toBe("ship-it");
    expect(filters).not.toHaveProperty("labels_all");
    expect(reloader.getStatus().ok).toBe(true);
    expect(reloader.getStatus().warnings).toEqual([]);
  });

  it("takes the first of several legacy labels and reports the broadening", async () => {
    const reloader = await loadWithFilterLines([
      '      labels_all: ["ship-it", "backend", "small"]'
    ]);

    expect(
      reloader.getSnapshot()?.polling.projects[0]?.issue_filters.ready_label
    ).toBe("ship-it");
    const status = reloader.getStatus();
    expect(status.ok).toBe(true);
    expect(status.warnings).toHaveLength(1);
    expect(status.warnings[0]).toContain("symphonika");
    expect(status.warnings[0]).toContain('"backend" or "small"');
  });

  it("accepts a native ready_label", async () => {
    const reloader = await loadWithFilterLines(['      ready_label: "go"']);

    expect(
      reloader.getSnapshot()?.polling.projects[0]?.issue_filters.ready_label
    ).toBe("go");
    expect(reloader.getStatus().warnings).toEqual([]);
  });

  it.each([
    ["an empty labels_all", ["      labels_all: []"], "labels_all` is empty"],
    [
      "both labels_all and ready_label",
      ['      labels_all: ["a"]', '      ready_label: "b"'],
      "both set"
    ],
    ["neither key", [], "`ready_label` is required"],
    ["a blank ready_label", ['      ready_label: "  "'], "ready_label"]
  ])("rejects %s", async (_name, lines, message) => {
    const reloader = await loadWithFilterLines(lines);

    expect(reloader.getSnapshot()?.polling.projects ?? []).toEqual([]);
    expect(reloader.getStatus().ok).toBe(false);
    expect(reloader.getStatus().errors.join("\n")).toContain(message);
  });

  it("re-parses its own output without rejecting or losing the broadening marker", () => {
    const first = issueFiltersSchema.parse({
      labels_all: ["a", "b"],
      labels_none: [],
      states: ["open"]
    });

    const second = issueFiltersSchema.parse(first);

    expect(second).toEqual(first);
    expect(second.migrated_from_labels_all).toEqual(["a", "b"]);
  });
});
