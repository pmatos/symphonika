import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadRoutineDeclaration } from "../src/routines/declaration-loader.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-routine-loader-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("RoutineDeclarationLoader", () => {
  it("parses a Markdown kind: report routine with one-shot at schedule", async () => {
    const root = await makeTempRoot();
    const routinePath = path.join(root, "weekly-report.md");
    await writeFile(
      routinePath,
      [
        "---",
        "name: weekly-report",
        "schedule:",
        "  at: 2026-05-22T10:00:00.000Z",
        "kind: report",
        "provider: claude",
        "---",
        "Summarize {{project.name}} from {{workspace.path}}.",
        ""
      ].join("\n")
    );

    const result = await loadRoutineDeclaration(routinePath);

    expect(result.errors).toEqual([]);
    expect(result.routine).toEqual({
      kind: "report",
      name: "weekly-report",
      prompt: "Summarize {{project.name}} from {{workspace.path}}.\n",
      provider: "claude",
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: routinePath
    });
  });

  it("reports missing required front matter fields", async () => {
    const root = await makeTempRoot();
    const routinePath = path.join(root, "missing.md");
    await writeFile(
      routinePath,
      ["---", "name: missing", "---", "Body", ""].join("\n")
    );

    const result = await loadRoutineDeclaration(routinePath);

    expect(result.routine).toBeNull();
    expect(result.errors.join("\n")).toContain("schedule.at");
    expect(result.errors.join("\n")).toContain("kind");
  });

  it("rejects names that are unsafe as a single workspace path segment", async () => {
    const root = await makeTempRoot();
    const routinePath = path.join(root, "unsafe.md");
    await writeFile(
      routinePath,
      [
        "---",
        "name: ../weekly-report",
        "schedule:",
        "  at: 2026-05-22T10:00:00.000Z",
        "kind: report",
        "---",
        "Body",
        ""
      ].join("\n")
    );

    const result = await loadRoutineDeclaration(routinePath);

    expect(result.routine).toBeNull();
    expect(result.errors).toContain(
      `routine at ${routinePath} name "../weekly-report" is not path-safe`
    );
  });

  it("rejects mutually-exclusive schedule fields", async () => {
    const root = await makeTempRoot();
    await mkdir(path.join(root, "routines"), { recursive: true });
    const routinePath = path.join(root, "routines", "conflicting.md");
    await writeFile(
      routinePath,
      [
        "---",
        "name: conflicting",
        "schedule:",
        "  at: 2026-05-22T10:00:00.000Z",
        "  cron: '0 8 * * *'",
        "kind: report",
        "---",
        "Body",
        ""
      ].join("\n")
    );

    const result = await loadRoutineDeclaration(routinePath);

    expect(result.routine).toBeNull();
    expect(result.errors).toContain(
      `routine at ${routinePath} schedule must define only one schedule field; supported in this slice: at`
    );
  });

  it("rejects YAML front matter that parses as a list", async () => {
    const root = await makeTempRoot();
    const routinePath = path.join(root, "list-front-matter.md");
    await writeFile(
      routinePath,
      ["---", "- foo", "- bar", "---", "Body", ""].join("\n")
    );

    const result = await loadRoutineDeclaration(routinePath);

    expect(result.routine).toBeNull();
    expect(result.errors).toContain(
      `routine front matter at ${routinePath} must be a mapping`
    );
  });

  it("reports invalid schedule.at dates without throwing", async () => {
    const root = await makeTempRoot();
    const routinePath = path.join(root, "invalid-date.md");
    await writeFile(
      routinePath,
      [
        "---",
        "name: invalid-date",
        "schedule:",
        "  at: tomorrow-ish",
        "kind: report",
        "---",
        "Body",
        ""
      ].join("\n")
    );

    const result = await loadRoutineDeclaration(routinePath);

    expect(result.routine).toBeNull();
    expect(result.errors).toContain(
      `routine at ${routinePath} schedule.at must be a valid ISO 8601 date`
    );
  });
});
