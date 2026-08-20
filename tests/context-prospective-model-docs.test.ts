import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("CONTEXT Routine fan-out domain model", () => {
  it("documents service-level Routine Fan-out as implemented", async () => {
    const context = await readFile(path.join(repoRoot, "CONTEXT.md"), "utf8");

    expect(context).not.toContain("**Prospective model:**");
    expect(context).toContain(
      "The materialized per-Project state for one Routine, durably keyed by `(project_name, name)`"
    );
    expect(context).toContain(
      "The durable group created when one Routine clock event matches one or more Routine Targets"
    );
  });

  it("documents the Dispatch Project / Routine Host mode split as implemented", async () => {
    const context = await readFile(path.join(repoRoot, "CONTEXT.md"), "utf8");

    expect(context).toContain(
      "declares a `mode` of `dispatch` or `routine_host` (ADR 0062)"
    );
    expect(context).toContain(
      "A Project with `mode: routine_host`: never polled for issues"
    );
  });

  it("documents explicit targets and non-gating holds, per ADRs 0069 and 0084", async () => {
    const context = await readFile(path.join(repoRoot, "CONTEXT.md"), "utf8");

    expect(context).toContain(
      "targets an explicit,\nnon-empty list of declared Projects"
    );
    expect(context).toContain(
      "A **Routine Fan-out** produces one grouped notification after all target legs are terminal or held"
    );
  });
});
