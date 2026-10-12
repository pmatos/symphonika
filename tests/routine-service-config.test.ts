import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { z } from "zod";

import { runDoctor } from "../src/doctor.js";
import type { AgentProviderRegistry } from "../src/provider.js";
import { RuntimeConfigReloader } from "../src/reload.js";
import {
  rejectProjectRoutineDeclarations,
  routineServiceConfigFields
} from "../src/routines/service-config.js";
import {
  doctorTestEnv,
  prepareDoctorTestEnvironment
} from "./helpers/doctor-environment.js";

const roots: string[] = [];
const command =
  "codex -p symphonika --dangerously-bypass-approvals-and-sandbox app-server {{#model}}--model {{model}}{{/model}} {{#effort}}--effort {{effort}}{{/effort}}";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function readers(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "routine-config-test-"));
  roots.push(root);
  await prepareDoctorTestEnvironment(root);
  await writeFile(
    path.join(root, "report.md"),
    "---\nname: report\nkind: report\nprovider: codex\nmodel: routine-model\nschedule:\n  cron: daily\n---\nReport.\n"
  );
  const host = {
    name: "host",
    mode: "routine_host",
    workspace: {
      root: "./workspaces",
      git: {
        remote: "git@github.com:pmatos/symphonika.git",
        base_branch: "main"
      }
    },
    agent: { provider: "codex" }
  };
  const configPath = path.join(root, "symphonika.yml");
  await writeFile(
    configPath,
    stringify({
      providers: { codex: { command }, claude: { command: "claude -p" } },
      projects: [host],
      routines: [{ projects: ["host"], path: "./report.md" }],
      ...overrides
    })
  );
  const validate = vi.fn(() => Promise.resolve());
  const agentProviders: AgentProviderRegistry = {
    codex: {
      name: "codex",
      cancel: () => Promise.resolve(),
      validate,
      runAttempt: async function* () {
        await Promise.resolve();
        yield* [];
      }
    }
  };
  const doctor = await runDoctor({
    agentProviders,
    configPath,
    cwd: root,
    env: doctorTestEnv(root),
    homeDir: root,
    offline: true
  });
  const reload = new RuntimeConfigReloader({ configPath });
  await reload.reload();
  return { doctor, reload, validate, host };
}

describe("Routine Service Config reader compatibility", () => {
  it("normalizes defaults before each reader applies declaration overrides", async () => {
    const { doctor, reload, validate } = await readers({
      routine_defaults: {
        model: " service-model ",
        effort: " steady ",
        permission_mode: " custom-mode ",
        timeout_minutes: 0.5
      }
    });
    expect(doctor.errors).toEqual([]);
    expect(reload.getStatus().ok).toBe(true);
    expect(reload.getSnapshot()?.routineDefaults).toEqual({
      model: "service-model",
      effort: "steady",
      permissionMode: "custom-mode",
      timeoutMinutes: 0.5
    });
    const effective = {
      model: "routine-model",
      effort: "steady",
      permissionMode: "custom-mode",
      timeoutMinutes: 0.5
    };
    expect(validate).toHaveBeenCalledWith(command, effective);
    expect(reload.projectsByName().get("host")?.routines).toEqual([
      expect.objectContaining(effective)
    ]);
  });

  it.each([
    [
      { project: "host", path: "./report.md" },
      "routines.0.project: service-level `project:` was replaced by the explicit `projects: [<name>, ...]` target list (see ADR 0069)"
    ],
    [
      { projects: ["host", " host "], path: "./report.md" },
      'routines.0.projects.1: duplicate target project "host"'
    ],
    [
      { path: "./report.md" },
      "routines.0.projects: an explicit non-empty `projects: [<name>, ...]` target list is required"
    ]
  ])(
    "preserves target diagnostics for %j in both readers",
    async (entry, error) => {
      const { doctor, reload } = await readers({ routines: [entry] });
      expect(doctor.errors).toEqual([error]);
      expect(reload.getStatus().errors).toEqual([error]);
      expect(reload.getSnapshot()).toBeUndefined();
    }
  );

  it("preserves each reader's ordered defaults diagnostics", async () => {
    const { doctor, reload } = await readers({
      routine_defaults: {
        model: "",
        effort: "",
        permission_mode: "",
        timeout_minutes: 0
      }
    });
    const keys = (errors: string[]) =>
      errors.map((error) => error.split(":")[0]);
    expect(keys(doctor.errors)).toEqual([
      "routine_defaults.effort",
      "routine_defaults.model",
      "routine_defaults.permission_mode",
      "routine_defaults.timeout_minutes"
    ]);
    expect(keys(reload.getStatus().errors)).toEqual([
      "routine_defaults.model",
      "routine_defaults.effort",
      "routine_defaults.permission_mode",
      "routine_defaults.timeout_minutes"
    ]);
  });
});

describe("Routine Service Config fields", () => {
  const doctorSchema = z.object(routineServiceConfigFields("effort-first"));
  const runtimeSchema = z.object(routineServiceConfigFields("model-first"));

  it("trims targets and paths while retaining entry extensions", () => {
    expect(
      doctorSchema.parse({
        routines: [
          { projects: [" host ", " sibling "], path: " ./report.md ", extra: 1 }
        ]
      })
    ).toEqual({
      routines: [
        { projects: ["host", "sibling"], path: "./report.md", extra: 1 }
      ]
    });
  });

  it("keeps omitted defaults absent and drops undefined settings", () => {
    expect(doctorSchema.parse({})).toStrictEqual({});
    expect(
      doctorSchema.parse({
        routine_defaults: { model: undefined, effort: " hi " }
      })
    ).toStrictEqual({ routine_defaults: { effort: "hi" } });
    expect(runtimeSchema.parse({ routine_defaults: {} })).toEqual({
      routine_defaults: {}
    });
  });

  it("projects authored defaults into execution settings with both historical key orders", () => {
    const input = {
      routine_defaults: {
        model: " model ",
        effort: " effort ",
        permission_mode: " custom ",
        timeout_minutes: 0.5
      }
    };
    const doctor = doctorSchema.parse(input).routine_defaults;
    const runtime = runtimeSchema.parse(input).routine_defaults;
    expect(doctor).toEqual({
      model: "model",
      effort: "effort",
      permissionMode: "custom",
      timeoutMinutes: 0.5
    });
    expect(runtime).toEqual(doctor);
    expect(Object.keys(doctor ?? {})).toEqual([
      "model",
      "effort",
      "permissionMode",
      "timeoutMinutes"
    ]);
    expect(Object.keys(runtime ?? {})).toEqual([
      "effort",
      "model",
      "permissionMode",
      "timeoutMinutes"
    ]);
  });

  it.each([[], "all", [""], ["host", " host "]])(
    "rejects invalid target list %j",
    (projects) => {
      expect(
        doctorSchema.safeParse({ routines: [{ projects, path: "report.md" }] })
          .success
      ).toBe(false);
    }
  );

  it("preserves migration precedence and all ordered nested diagnostics", () => {
    const result = runtimeSchema.safeParse({
      routine_defaults: { model: "", effort: "" },
      routines: [
        { project: "host", path: "report.md" },
        { project: "host", projects: ["host", "host"], path: "report.md" }
      ]
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected invalid Routine config");
    expect(result.error.issues.map(({ path }) => path)).toEqual([
      ["routine_defaults", "model"],
      ["routine_defaults", "effort"],
      ["routines", 0, "project"],
      ["routines", 1, "project"],
      ["routines", 1, "projects", 1]
    ]);
    expect(result.error.issues.at(-1)?.message).toBe(
      'duplicate target project "host"'
    );
  });

  it("rejects strict defaults extensions and unsafe paths", () => {
    expect(
      doctorSchema.safeParse({ routine_defaults: { extension: "extra" } })
        .success
    ).toBe(false);
    expect(
      doctorSchema.safeParse({
        routines: [{ projects: ["host"], path: "bad\0.md" }]
      }).success
    ).toBe(false);
  });

  it.each([0, -1, NaN, Infinity])(
    "rejects non-positive or non-finite timeout %s",
    (timeout_minutes) => {
      expect(
        doctorSchema.safeParse({ routine_defaults: { timeout_minutes } })
          .success
      ).toBe(false);
    }
  );

  it("rejects legacy Project routines at the parent Project path", () => {
    const schema = z.object({
      projects: z.array(
        z
          .object({ name: z.string() })
          .passthrough()
          .superRefine(rejectProjectRoutineDeclarations)
      )
    });
    expect(schema.safeParse({ projects: [{ name: "host" }] }).success).toBe(
      true
    );
    const result = schema.safeParse({
      projects: [{ name: "host", routines: [] }]
    });
    expect(result.success).toBe(false);
    if (result.success)
      throw new Error("expected legacy Project config to fail");
    expect(
      result.error.issues.map(({ path, message }) => ({ path, message }))
    ).toEqual([
      {
        path: ["projects", 0, "routines"],
        message:
          "per-project `routines:` was removed; move routine entries to the top-level `routines:` block with a `projects: [<name>, ...]` target list (see ADR 0069)"
      }
    ]);
  });
});
