import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("CONTEXT prospective domain model", () => {
  it("warns readers that Project kinds and service-level Routines are not implemented yet", async () => {
    const context = await readFile(path.join(repoRoot, "CONTEXT.md"), "utf8");
    const notice = context.match(
      /> \*\*Prospective model:\*\*[\s\S]*?(?=\n\n## Language)/
    )?.[0];

    expect(notice).toEqual(
      [
        "> **Prospective model:** The **Dispatch Project** / **Routine Host** split and service-level",
        "> **Routine** / **Routine Target** / **Routine Fan-out** definitions are target-state vocabulary",
        "> for [#290](https://github.com/pmatos/symphonika/issues/290) and",
        "> [#295](https://github.com/pmatos/symphonika/issues/295), not the current implementation",
        "> contract. Until those issues land, `SPEC.md`, ADR-0060, and the Service Config loader remain",
        "> authoritative for the implemented flat **Project**, project-owned **Routine** model."
      ].join("\n")
    );
  });
});
