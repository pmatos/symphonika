import { describe, expect, it } from "vitest";

import { workflowReferenceSchema } from "../src/config-schemas.js";

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
