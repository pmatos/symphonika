import { describe, expect, it } from "vitest";

import { setRoutineDisabled } from "../src/routines/declaration-editor.js";
import { parseRoutineDeclaration } from "../src/routines/declaration-loader.js";

describe("setRoutineDisabled (#307 part 4, ADR 0076)", () => {
  it("adds disabled: true to front matter with no disabled key, preserving comments and key order", () => {
    const original = [
      "---",
      "name: audit # the routine's name",
      "kind: report",
      "schedule:",
      '  at: "2026-05-22T10:00:00.000Z"',
      "---",
      "Audit the codebase.",
      ""
    ].join("\n");

    const result = setRoutineDisabled(original, true);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.content).toContain("# the routine's name");
      expect(result.content.indexOf("name: audit")).toBeLessThan(
        result.content.indexOf("kind: report")
      );
      expect(result.content).toContain("Audit the codebase.");
      const parsed = parseRoutineDeclaration(result.content, "/tmp/audit.md");
      expect(parsed.errors).toEqual([]);
      expect(parsed.routine).toMatchObject({ disabled: true });
    }
  });

  it("flips an existing disabled: true to false in place", () => {
    const original = [
      "---",
      "name: audit",
      "kind: report",
      "disabled: true",
      "schedule:",
      '  at: "2026-05-22T10:00:00.000Z"',
      "---",
      "Audit the codebase.",
      ""
    ].join("\n");

    const result = setRoutineDisabled(original, false);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      const parsed = parseRoutineDeclaration(result.content, "/tmp/audit.md");
      expect(parsed.errors).toEqual([]);
      expect(parsed.routine).toMatchObject({ disabled: false });
    }
  });

  it("leaves the prompt body byte-for-byte untouched, including its own --- lines", () => {
    const original = [
      "---",
      "name: audit",
      "kind: report",
      "schedule:",
      '  at: "2026-05-22T10:00:00.000Z"',
      "---",
      "Body with a literal --- inside it.",
      "",
      "More body.",
      ""
    ].join("\n");

    const result = setRoutineDisabled(original, true);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(
        result.content.endsWith(
          "Body with a literal --- inside it.\n\nMore body.\n"
        )
      ).toBe(true);
    }
  });

  it("preserves CRLF line endings when toggling a routine", () => {
    const original = [
      "---",
      "name: audit",
      "kind: report",
      "schedule:",
      '  at: "2026-05-22T10:00:00.000Z"',
      "---",
      "Audit the codebase.",
      ""
    ].join("\r\n");

    const result = setRoutineDisabled(original, true);

    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.content).toContain("\r\n");
      expect(result.content.replaceAll("\r\n", "")).not.toContain("\n");
      const parsed = parseRoutineDeclaration(result.content, "/tmp/audit.md");
      expect(parsed.errors).toEqual([]);
      expect(parsed.routine).toMatchObject({ disabled: true });
    }
  });

  it("returns an error for content with no front matter", () => {
    const result = setRoutineDisabled("no front matter here\n", true);
    expect(result.kind).toBe("error");
  });

  it("returns an error for unterminated front matter", () => {
    const result = setRoutineDisabled("---\nname: audit\n", true);
    expect(result.kind).toBe("error");
  });
});
