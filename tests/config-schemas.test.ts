import { describe, expect, it } from "vitest";

import {
  projectWorkspaceSchema,
  workflowReferenceSchema
} from "../src/config-schemas.js";

describe("workflowReferenceSchema", () => {
  it("normalizes a bare string into { path, format: 'auto' }", () => {
    const result = workflowReferenceSchema.parse("WORKFLOW.md");
    expect(result).toEqual({ format: "auto", path: "WORKFLOW.md" });
  });

  it("trims surrounding whitespace from the string shorthand", () => {
    const result = workflowReferenceSchema.parse("  workflow.yml  ");
    expect(result).toEqual({ format: "auto", path: "workflow.yml" });
  });

  it("rejects an empty string shorthand", () => {
    expect(() => workflowReferenceSchema.parse("")).toThrow();
    expect(() => workflowReferenceSchema.parse("   ")).toThrow();
  });

  it("rejects a path containing NUL bytes", () => {
    expect(() => workflowReferenceSchema.parse("workflow\0.md")).toThrow();
  });

  it("accepts the tagged object form and defaults format to 'auto'", () => {
    const result = workflowReferenceSchema.parse({ path: "WORKFLOW.md" });
    expect(result).toEqual({ format: "auto", path: "WORKFLOW.md" });
  });

  it("accepts explicit markdown, raw_fsm, and auto format values", () => {
    expect(
      workflowReferenceSchema.parse({ format: "markdown", path: "WORKFLOW.md" })
    ).toEqual({ format: "markdown", path: "WORKFLOW.md" });
    expect(
      workflowReferenceSchema.parse({ format: "raw_fsm", path: "workflow.yml" })
    ).toEqual({ format: "raw_fsm", path: "workflow.yml" });
    expect(
      workflowReferenceSchema.parse({ format: "auto", path: "WORKFLOW.md" })
    ).toEqual({ format: "auto", path: "WORKFLOW.md" });
  });

  it("rejects an unknown format value", () => {
    expect(() =>
      workflowReferenceSchema.parse({ format: "xml", path: "workflow.xml" })
    ).toThrow();
  });

  it("rejects unknown keys on the tagged object form", () => {
    expect(() =>
      workflowReferenceSchema.parse({
        format: "markdown",
        kind: "raw_fsm",
        path: "WORKFLOW.md"
      })
    ).toThrow();
  });

  it("rejects an object form with a missing path", () => {
    expect(() =>
      workflowReferenceSchema.parse({ format: "markdown" })
    ).toThrow();
  });
});

describe("projectWorkspaceSchema", () => {
  it("accepts existing workspace config without hooks unchanged", () => {
    const result = projectWorkspaceSchema.parse({
      git: {
        base_branch: "main",
        remote: "git@github.com:pmatos/symphonika.git"
      },
      root: "./.symphonika/workspaces/symphonika"
    });

    expect(result).toEqual({
      git: {
        base_branch: "main",
        remote: "git@github.com:pmatos/symphonika.git"
      },
      root: "./.symphonika/workspaces/symphonika"
    });
  });

  it("accepts an empty workspace hooks map", () => {
    const result = projectWorkspaceSchema.parse({
      git: {
        base_branch: "main",
        remote: "git@github.com:pmatos/symphonika.git"
      },
      hooks: {},
      root: "./.symphonika/workspaces/symphonika"
    });

    expect(result.hooks).toEqual({});
  });

  it("accepts one configured workspace hook", () => {
    const result = projectWorkspaceSchema.parse({
      git: {
        base_branch: "main",
        remote: "git@github.com:pmatos/symphonika.git"
      },
      hooks: {
        after_create: {
          command: "npm ci",
          timeout_ms: 600_000
        }
      },
      root: "./.symphonika/workspaces/symphonika"
    });

    expect(result.hooks?.after_create).toEqual({
      command: "npm ci",
      timeout_ms: 600_000
    });
  });

  it("accepts all configured workspace hook lifecycle keys", () => {
    const result = projectWorkspaceSchema.parse({
      git: {
        base_branch: "main",
        remote: "git@github.com:pmatos/symphonika.git"
      },
      hooks: {
        after_create: { command: "npm ci" },
        after_run: { command: "npm test" },
        before_remove: { command: "./scripts/archive-evidence.sh" },
        before_run: { command: "./scripts/bootstrap.sh" }
      },
      root: "./.symphonika/workspaces/symphonika"
    });

    expect(Object.keys(result.hooks ?? {}).sort()).toEqual([
      "after_create",
      "after_run",
      "before_remove",
      "before_run"
    ]);
  });

  it("rejects unknown workspace hook lifecycle keys with the allowed set", () => {
    const result = projectWorkspaceSchema.safeParse({
      git: {
        base_branch: "main",
        remote: "git@github.com:pmatos/symphonika.git"
      },
      hooks: {
        after_merge: { command: "npm ci" }
      },
      root: "./.symphonika/workspaces/symphonika"
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected workspace hooks validation to fail");
    }
    expect(result.error.issues[0]).toMatchObject({
      message:
        'unknown workspace hook lifecycle "after_merge"; allowed lifecycles: after_create, before_run, after_run, before_remove',
      path: ["hooks", "after_merge"]
    });
  });

  it("rejects empty workspace hook commands after trimming", () => {
    expect(() =>
      projectWorkspaceSchema.parse({
        git: {
          base_branch: "main",
          remote: "git@github.com:pmatos/symphonika.git"
        },
        hooks: {
          before_run: { command: "   " }
        },
        root: "./.symphonika/workspaces/symphonika"
      })
    ).toThrow(/command must be a non-empty string/);
  });

  it.each([
    ["non-integer", 1000.5],
    ["sub-minimum", 999]
  ])("rejects %s workspace hook timeout_ms values", (_label, timeoutMs) => {
    expect(() =>
      projectWorkspaceSchema.parse({
        git: {
          base_branch: "main",
          remote: "git@github.com:pmatos/symphonika.git"
        },
        hooks: {
          before_run: { command: "./scripts/bootstrap.sh", timeout_ms: timeoutMs }
        },
        root: "./.symphonika/workspaces/symphonika"
      })
    ).toThrow();
  });
});
