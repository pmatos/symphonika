import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("CONTEXT prospective domain model", () => {
  it("warns readers that service-level Routine Fan-out is not implemented yet", async () => {
    const context = await readFile(path.join(repoRoot, "CONTEXT.md"), "utf8");
    const notice = context.match(
      /> \*\*Prospective model:\*\*[\s\S]*?(?=\n\n## Language)/
    )?.[0];

    expect(notice).toEqual(
      [
        "> **Prospective model:** Service-level Routine **Fan-out** — a Routine targeting more than one",
        "> Project via a `projects:` list (or wildcard), with per-Project **Routine Target** state and",
        "> per-clock-event **Routine Fan-out** — is target-state vocabulary for",
        "> [#295](https://github.com/pmatos/symphonika/issues/295), not the current implementation contract.",
        "> The **Dispatch Project** / **Routine Host** mode split (ADR 0062) and single-target service-level",
        "> **Routine** declarations (ADR 0063) below are implemented: a Routine currently targets exactly one",
        "> declared Project by name."
      ].join("\n")
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

  it("documents the Routine as single-target, per ADR 0063", async () => {
    const context = await readFile(path.join(repoRoot, "CONTEXT.md"), "utf8");

    expect(context).toContain(
      "A service-level scheduled prompt declaration that targets one declared Project by name"
    );
    expect(context).toContain(
      "A **Routine** targets one declared **Project** by name and may create zero or more **Routine Firings**"
    );
  });
});
