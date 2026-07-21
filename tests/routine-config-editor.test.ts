import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RoutineConfigEditor } from "../src/routines/config-editor.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-routine-editor-"));
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

describe("RoutineConfigEditor", () => {
  it("appends a declaration path to an existing Project routines list", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await mkdir(path.join(root, "routines"));
    await writeRoutine(path.join(root, "routines", "daily.md"), "daily");
    await writeRoutine(path.join(root, "routines", "weekly.md"), "weekly");
    await writeFile(
      configPath,
      [
        "projects:",
        "  - name: alpha",
        "    routines:",
        "      - ./routines/daily.md",
        "    workflow: ./WORKFLOW.md",
        ""
      ].join("\n")
    );

    const result = await new RoutineConfigEditor(configPath).addRoutine({
      projectName: "alpha",
      routinePath: "./routines/weekly.md"
    });

    expect(result).toEqual({ changed: true, routineName: "weekly" });
    expect(await readFile(configPath, "utf8")).toContain(
      "      - ./routines/daily.md\n      - ./routines/weekly.md\n"
    );
  });

  it("creates a Project routines list when it is absent", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await mkdir(path.join(root, "routines"));
    await writeRoutine(path.join(root, "routines", "weekly.md"), "weekly");
    await writeFile(
      configPath,
      ["projects:", "  - name: alpha", "    workflow: ./WORKFLOW.md", ""].join(
        "\n"
      )
    );

    await new RoutineConfigEditor(configPath).addRoutine({
      projectName: "alpha",
      routinePath: "./routines/weekly.md"
    });

    expect(await readFile(configPath, "utf8")).toContain(
      "    workflow: ./WORKFLOW.md\n    routines:\n      - ./routines/weekly.md\n"
    );
  });

  it("refuses to edit a Project that does not exist", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await mkdir(path.join(root, "routines"));
    await writeRoutine(path.join(root, "routines", "weekly.md"), "weekly");
    const original = "projects:\n  - name: alpha\n";
    await writeFile(configPath, original);

    await expect(
      new RoutineConfigEditor(configPath).addRoutine({
        projectName: "missing",
        routinePath: "./routines/weekly.md"
      })
    ).rejects.toThrow('project "missing" not found in service config');
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("refuses a different declaration path with the same Routine name", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await mkdir(path.join(root, "routines"));
    await writeRoutine(path.join(root, "routines", "weekly-old.md"), "weekly");
    await writeRoutine(path.join(root, "routines", "weekly-new.md"), "weekly");
    const original = [
      "projects:",
      "  - name: alpha",
      "    routines:",
      "      - ./routines/weekly-old.md",
      ""
    ].join("\n");
    await writeFile(configPath, original);

    await expect(
      new RoutineConfigEditor(configPath).addRoutine({
        projectName: "alpha",
        routinePath: "./routines/weekly-new.md"
      })
    ).rejects.toThrow(
      'routine name "weekly" already exists in project "alpha" at ./routines/weekly-old.md'
    );
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("is idempotent when the same resolved declaration path is re-added", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await mkdir(path.join(root, "routines"));
    await writeRoutine(path.join(root, "routines", "weekly.md"), "weekly");
    const original = [
      "projects:",
      "  - name: alpha",
      "    routines:",
      "      - ./routines/weekly.md",
      ""
    ].join("\n");
    await writeFile(configPath, original);

    const result = await new RoutineConfigEditor(configPath).addRoutine({
      projectName: "alpha",
      routinePath: "routines/weekly.md"
    });

    expect(result).toEqual({ changed: false, routineName: "weekly" });
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("preserves comments and unrelated key ordering", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await mkdir(path.join(root, "routines"));
    await writeRoutine(path.join(root, "routines", "weekly.md"), "weekly");
    const original = [
      "# service heading",
      "providers: # provider comment",
      "  codex:",
      "    command: codex",
      "projects:",
      "  - name: alpha # selected project",
      "    workflow: ./WORKFLOW.md # workflow comment",
      "polling:",
      "  interval_ms: 30000 # cadence",
      ""
    ].join("\n");
    await writeFile(configPath, original);

    await new RoutineConfigEditor(configPath).addRoutine({
      projectName: "alpha",
      routinePath: "./routines/weekly.md"
    });

    const edited = await readFile(configPath, "utf8");
    expect(edited).toContain("# service heading");
    expect(edited).toContain("# provider comment");
    expect(edited).toContain("# selected project");
    expect(edited).toContain("# workflow comment");
    expect(edited).toContain("# cadence");
    expect(edited.indexOf("providers:")).toBeLessThan(
      edited.indexOf("projects:")
    );
    expect(edited.indexOf("projects:")).toBeLessThan(
      edited.indexOf("polling:")
    );
    expect(edited).toContain(
      "    workflow: ./WORKFLOW.md # workflow comment\n    routines:\n      - ./routines/weekly.md\n"
    );
  });
});

async function writeRoutine(filePath: string, name: string): Promise<void> {
  await writeFile(
    filePath,
    [
      "---",
      `name: ${name}`,
      "schedule:",
      "  cron: daily",
      "kind: report",
      "---",
      "Do the work.",
      ""
    ].join("\n")
  );
}
