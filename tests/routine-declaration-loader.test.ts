import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  it("parses catch-up and overlap policy opt-ins", async () => {
    const root = await makeTempRoot();
    const routinePath = path.join(root, "catch-up-report.md");
    await writeFile(
      routinePath,
      [
        "---",
        "name: catch-up-report",
        "schedule:",
        "  cron: daily",
        "kind: report",
        "catch_up: fire_once_if_missed",
        "allow_overlap: true",
        "---",
        "Report.",
        ""
      ].join("\n")
    );

    const result = await loadRoutineDeclaration(routinePath);

    expect(result.errors).toEqual([]);
    expect(result.routine).toMatchObject({
      allowOverlap: true,
      catchUp: "fire_once_if_missed"
    });
  });

  it.each([
    [
      "catch_up",
      "catch_up: replay_all",
      "catch_up must be fire_once_if_missed"
    ],
    ["allow_overlap", "allow_overlap: yes", "allow_overlap must be a boolean"]
  ])("rejects an invalid %s policy", async (_policy, field, expectedError) => {
    const root = await makeTempRoot();
    const routinePath = path.join(root, "invalid-policy.md");
    await writeFile(
      routinePath,
      [
        "---",
        "name: invalid-policy",
        "schedule:",
        "  cron: daily",
        "kind: report",
        field,
        "---",
        "Report.",
        ""
      ].join("\n")
    );

    const result = await loadRoutineDeclaration(routinePath);

    expect(result.routine).toBeNull();
    expect(result.errors.join("\n")).toContain(expectedError);
  });

  it("parses a Markdown kind: git routine", async () => {
    const root = await makeTempRoot();
    const routinePath = path.join(root, "dependency-update.md");
    await writeFile(
      routinePath,
      [
        "---",
        "name: dependency-update",
        "schedule:",
        "  at: 2026-05-22T10:00:00.000Z",
        "kind: git",
        "---",
        "Update dependencies on {{branch.name}}.",
        ""
      ].join("\n")
    );

    const result = await loadRoutineDeclaration(routinePath);

    expect(result.errors).toEqual([]);
    expect(result.routine).toEqual({
      allowOverlap: false,
      catchUp: "skip",
      kind: "git",
      name: "dependency-update",
      prompt: "Update dependencies on {{branch.name}}.\n",
      provider: null,
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: routinePath
    });
  });

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
      allowOverlap: false,
      catchUp: "skip",
      kind: "report",
      name: "weekly-report",
      prompt: "Summarize {{project.name}} from {{workspace.path}}.\n",
      provider: "claude",
      schedule: { at: "2026-05-22T10:00:00.000Z" },
      sourcePath: routinePath
    });
  });

  it.each([
    ["hourly", "0 * * * *"],
    ["@hourly", "0 * * * *"],
    ["daily", "0 0 * * *"],
    ["@daily", "0 0 * * *"],
    ["weekly", "0 0 * * 0"],
    ["@weekly", "0 0 * * 0"],
    ["monthly", "0 0 1 * *"],
    ["@monthly", "0 0 1 * *"],
    ["yearly", "0 0 1 1 *"],
    ["@yearly", "0 0 1 1 *"]
  ])("expands the %s recurring schedule alias", async (alias, cron) => {
    const root = await makeTempRoot();
    const routinePath = path.join(root, "recurring-report.md");
    await writeFile(
      routinePath,
      [
        "---",
        "name: recurring-report",
        "schedule:",
        `  cron: '${alias}'`,
        "kind: report",
        "---",
        "Report.",
        ""
      ].join("\n")
    );

    const result = await loadRoutineDeclaration(routinePath);

    expect(result.errors).toEqual([]);
    expect(result.routine?.schedule).toEqual({ cron, tz: "Etc/UTC" });
    expect(await readFile(routinePath, "utf8")).toContain(`cron: '${alias}'`);
  });

  it("accepts a valid five-field cron expression in an IANA timezone", async () => {
    const root = await makeTempRoot();
    const routinePath = path.join(root, "weekday-report.md");
    await writeFile(
      routinePath,
      [
        "---",
        "name: weekday-report",
        "schedule:",
        "  cron: '15 9 * * 1-5'",
        "  tz: Europe/Lisbon",
        "kind: report",
        "---",
        "Report.",
        ""
      ].join("\n")
    );

    const result = await loadRoutineDeclaration(routinePath);

    expect(result.errors).toEqual([]);
    expect(result.routine?.schedule).toEqual({
      cron: "15 9 * * 1-5",
      tz: "Europe/Lisbon"
    });
  });

  it.each(["61 * * * *", "0 0 * *", "fortnightly"])(
    "rejects invalid recurring expression %s",
    async (cron) => {
      const root = await makeTempRoot();
      const routinePath = path.join(root, "invalid-cron.md");
      await writeFile(
        routinePath,
        [
          "---",
          "name: invalid-cron",
          "schedule:",
          `  cron: '${cron}'`,
          "kind: report",
          "---",
          "Report.",
          ""
        ].join("\n")
      );

      const result = await loadRoutineDeclaration(routinePath);

      expect(result.routine).toBeNull();
      expect(result.errors.join("\n")).toContain("schedule.cron is invalid");
    }
  );

  it("rejects a recurring schedule with an invalid IANA timezone", async () => {
    const root = await makeTempRoot();
    const routinePath = path.join(root, "invalid-timezone.md");
    await writeFile(
      routinePath,
      [
        "---",
        "name: invalid-timezone",
        "schedule:",
        "  cron: daily",
        "  tz: Atlantic/Atlantis",
        "kind: report",
        "---",
        "Report.",
        ""
      ].join("\n")
    );

    const result = await loadRoutineDeclaration(routinePath);

    expect(result.routine).toBeNull();
    expect(result.errors).toContain(
      `routine at ${routinePath} schedule.tz "Atlantic/Atlantis" is not a valid IANA timezone`
    );
  });

  it("rejects an explicitly empty recurring timezone", async () => {
    const root = await makeTempRoot();
    const routinePath = path.join(root, "empty-timezone.md");
    await writeFile(
      routinePath,
      [
        "---",
        "name: empty-timezone",
        "schedule:",
        "  cron: daily",
        "  tz: ''",
        "kind: report",
        "---",
        "Report.",
        ""
      ].join("\n")
    );

    const result = await loadRoutineDeclaration(routinePath);

    expect(result.routine).toBeNull();
    expect(result.errors.join("\n")).toContain("schedule.tz");
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
      `routine at ${routinePath} schedule must define exactly one of schedule.at or schedule.cron`
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

  it("rejects a non-ISO schedule.at value that JavaScript can still parse", async () => {
    const root = await makeTempRoot();
    const routinePath = path.join(root, "non-iso-date.md");
    await writeFile(
      routinePath,
      [
        "---",
        "name: non-iso-date",
        "schedule:",
        '  at: "1"',
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
