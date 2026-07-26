import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runAddRoutine } from "../src/add-routine.js";
import { buildCli } from "../src/cli.js";
import { loadRoutineDeclaration } from "../src/routines/declaration-loader.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-add-routine-"));
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

describe("add-routine", () => {
  it("creates and registers a recurring Routine with all supplied flags", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeConfig(configPath);

    const report = await runAddRoutine({
      configPath,
      cwd: root,
      kind: "git",
      name: "weekly-maintenance",
      project: "alpha",
      provider: "claude",
      schedule: "@weekly",
      tz: "Europe/Berlin"
    });

    const routinePath = path.join(root, "routines", "weekly-maintenance.md");
    expect(report).toMatchObject({
      configPath,
      filePath: routinePath,
      ok: true,
      project: "alpha",
      registeredPath: "./routines/weekly-maintenance.md",
      routineName: "weekly-maintenance"
    });
    const source = await readFile(routinePath, "utf8");
    expect(source).toContain("name: weekly-maintenance");
    expect(source).toContain('cron: "@weekly"');
    expect(source).toContain("tz: Europe/Berlin");
    expect(source).toContain("kind: git");
    expect(source).toContain("provider: claude");
    expect(source).toContain("<!-- TODO:");
    expect((await loadRoutineDeclaration(routinePath)).routine).toMatchObject({
      kind: "git",
      name: "weekly-maintenance",
      provider: "claude",
      schedule: { cron: "0 0 * * 0", tz: "Europe/Berlin" }
    });
    expect(await readFile(configPath, "utf8")).toContain(
      "    routines:\n      - ./routines/weekly-maintenance.md\n"
    );
  });

  it("creates a one-shot Routine and uses an absolute registration from user config", async () => {
    const root = await makeTempRoot();
    const projectRoot = path.join(root, "project");
    const configPath = path.join(root, "config", "symphonika.yml");
    await mkdir(projectRoot);
    await writeConfig(configPath);

    const report = await runAddRoutine({
      at: "2026-08-01T09:30:00+02:00",
      configPath,
      cwd: projectRoot,
      kind: "report",
      name: "launch-report",
      project: "alpha"
    });

    const routinePath = path.join(projectRoot, "routines", "launch-report.md");
    expect(report).toMatchObject({
      ok: true,
      registeredPath: routinePath
    });
    expect((await loadRoutineDeclaration(routinePath)).routine).toMatchObject({
      kind: "report",
      name: "launch-report",
      provider: null,
      schedule: { at: "2026-08-01T07:30:00.000Z" }
    });
    expect(await readFile(routinePath, "utf8")).not.toContain("provider:");
    expect(await readFile(configPath, "utf8")).toContain(
      `    routines:\n      - ${routinePath}\n`
    );
  });

  it.each([
    {
      label: "unknown alias",
      name: "bad-alias",
      options: { schedule: "fortnightly" },
      problem: "expected exactly five fields or a supported alias"
    },
    {
      label: "invalid cron",
      name: "bad-cron",
      options: { schedule: "99 99 * * *" },
      problem: "schedule.cron is invalid"
    },
    {
      label: "invalid timezone",
      name: "bad-timezone",
      options: { schedule: "daily", tz: "Mars/Olympus" },
      problem: "is not a valid IANA timezone"
    },
    {
      label: "unsafe name",
      name: "../escape",
      options: { schedule: "daily" },
      problem: "is not path-safe"
    },
    {
      label: "non-ISO one-shot timestamp",
      name: "bad-at",
      options: { at: "1" },
      problem: "schedule.at must be a valid ISO 8601 date"
    }
  ])("refuses a $label without creating or registering it", async (input) => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeConfig(configPath);
    const original = await readFile(configPath, "utf8");

    const report = await runAddRoutine({
      configPath,
      cwd: root,
      kind: "report",
      name: input.name,
      project: "alpha",
      ...input.options
    });

    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toContain(input.problem);
    await expect(readFile(report.filePath, "utf8")).rejects.toThrow();
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("requires exactly one of a recurring schedule or one-shot time", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeConfig(configPath);

    const report = await runAddRoutine({
      at: "2026-08-01T09:30:00Z",
      configPath,
      cwd: root,
      kind: "report",
      name: "ambiguous",
      project: "alpha",
      schedule: "daily"
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain(
      "exactly one of --schedule or --at must be supplied"
    );
    await expect(readFile(report.filePath, "utf8")).rejects.toThrow();
  });

  it("refuses a timezone for a one-shot Routine", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeConfig(configPath);

    const report = await runAddRoutine({
      at: "2026-08-01T09:30:00Z",
      configPath,
      cwd: root,
      kind: "report",
      name: "one-shot-with-timezone",
      project: "alpha",
      tz: "Europe/Berlin"
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain(
      "--tz may only be supplied with --schedule"
    );
    await expect(readFile(report.filePath, "utf8")).rejects.toThrow();
  });

  it("refuses an unknown Project without leaving a Routine file", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeConfig(configPath);
    const original = await readFile(configPath, "utf8");

    const report = await runAddRoutine({
      configPath,
      cwd: root,
      kind: "report",
      name: "orphan",
      project: "missing",
      schedule: "daily"
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain(
      'project "missing" not found in service config'
    );
    await expect(readFile(report.filePath, "utf8")).rejects.toThrow();
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("refuses a Routine name already registered under another path", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    const routinesDirectory = path.join(root, "routines");
    await mkdir(routinesDirectory);
    await writeFile(
      path.join(routinesDirectory, "existing.md"),
      [
        "---",
        "name: daily-report",
        "schedule:",
        "  cron: daily",
        "kind: report",
        "---",
        "Create the report.",
        ""
      ].join("\n")
    );
    await writeConfig(configPath, ["./routines/existing.md"]);
    const original = await readFile(configPath, "utf8");

    const report = await runAddRoutine({
      configPath,
      cwd: root,
      kind: "report",
      name: "daily-report",
      project: "alpha",
      schedule: "weekly"
    });

    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toContain(
      'routine name "daily-report" already exists in project "alpha"'
    );
    await expect(readFile(report.filePath, "utf8")).rejects.toThrow();
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("registers a Routine when an unrelated existing declaration cannot be loaded", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeConfig(configPath, ["./routines/missing.md"]);

    const report = await runAddRoutine({
      configPath,
      cwd: root,
      kind: "report",
      name: "daily-report",
      project: "alpha",
      schedule: "daily"
    });

    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(await readFile(report.filePath, "utf8")).toContain(
      "name: daily-report"
    );
    expect(await readFile(configPath, "utf8")).toContain(
      [
        "    routines:",
        "      - ./routines/missing.md",
        "      - ./routines/daily-report.md",
        ""
      ].join("\n")
    );
  });

  it("refuses a duplicate name recovered from an invalid existing declaration", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    const existingPath = path.join(root, "routines", "existing.md");
    await mkdir(path.dirname(existingPath));
    await writeFile(
      existingPath,
      [
        "---",
        "name: daily-report",
        "kind: report",
        "---",
        "Create the report.",
        ""
      ].join("\n")
    );
    await writeConfig(configPath, ["./routines/existing.md"]);
    const original = await readFile(configPath, "utf8");

    const report = await runAddRoutine({
      configPath,
      cwd: root,
      kind: "report",
      name: "daily-report",
      project: "alpha",
      schedule: "daily"
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain(
      'routine name "daily-report" already exists in project "alpha" at ./routines/existing.md'
    );
    await expect(readFile(report.filePath, "utf8")).rejects.toThrow();
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("does not overwrite an existing Routine file", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    const routinePath = path.join(root, "routines", "daily-report.md");
    await writeConfig(configPath);
    await mkdir(path.dirname(routinePath));
    await writeFile(routinePath, "operator-owned contents\n");

    const report = await runAddRoutine({
      configPath,
      cwd: root,
      kind: "report",
      name: "daily-report",
      project: "alpha",
      schedule: "daily"
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain(
      `routine file already exists at ${routinePath}`
    );
    expect(await readFile(routinePath, "utf8")).toBe(
      "operator-owned contents\n"
    );
  });

  it("exposes the filesystem-only behavior through the add-routine CLI command", async () => {
    const previousCwd = process.cwd();
    const previousExitCode = process.exitCode;
    const root = await makeTempRoot();
    const configPath = path.join(root, "symphonika.yml");
    await writeConfig(configPath);
    const output = { stderr: "", stdout: "" };
    let networkCalls = 0;
    const program = buildCli({
      fetch: () => {
        networkCalls += 1;
        return Promise.reject(new Error("network access is forbidden"));
      },
      registerSignalHandlers: false
    });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });

    try {
      process.chdir(root);
      process.exitCode = 0;
      await program.parseAsync([
        "node",
        "symphonika",
        "add-routine",
        "nightly-report",
        "--project",
        "alpha",
        "--schedule",
        "daily",
        "--kind",
        "report",
        "--config",
        configPath
      ]);

      expect(process.exitCode).not.toBe(1);
      expect(output.stderr).toBe("");
      expect(output.stdout).toContain("add-routine ok");
      expect(output.stdout).toContain(
        path.join(root, "routines", "nightly-report.md")
      );
      expect(networkCalls).toBe(0);
    } finally {
      process.chdir(previousCwd);
      process.exitCode = previousExitCode;
    }
  });
});

async function writeConfig(
  configPath: string,
  routines: string[] = []
): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    [
      "projects:",
      "  - name: alpha",
      "    workflow: ./WORKFLOW.md",
      ...(routines.length === 0
        ? []
        : [
            "    routines:",
            ...routines.map((routine) => `      - ${routine}`)
          ]),
      ""
    ].join("\n")
  );
}
