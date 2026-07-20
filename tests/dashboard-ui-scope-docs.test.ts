import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("dashboard UI scope documentation", () => {
  it("records richer server-rendered presentation without widening the operator boundary", async () => {
    const [spec, adr0010, adr0027, adr0057] = await Promise.all([
      readRepositoryFile("SPEC.md"),
      readRepositoryFile("docs/adr/0010-server-rendered-local-operator-ui.md"),
      readRepositoryFile("docs/adr/0027-mostly-read-only-local-web-ui.md"),
      readRepositoryFile(
        "docs/adr/0057-richer-server-rendered-dashboard-presentation.md"
      )
    ]);

    expect({
      richerUiDeferred: /^- richer UI$/m.test(spec),
      richerPresentationInBootstrapScope: spec.includes(
        "Richer visual design of these server-rendered pages is part of the v1 bootstrap scope"
      ),
      serverRenderingDecisionAmended: adr0010.includes("Amended by ADR-0057"),
      readOnlyDecisionReaffirmed: adr0027.includes("Reaffirmed by ADR-0057"),
      newDecisionPreservesArchitecture:
        adr0057.includes("amends ADR-0010") &&
        adr0057.includes("leaves ADR-0027 unchanged")
    }).toEqual({
      richerUiDeferred: false,
      richerPresentationInBootstrapScope: true,
      serverRenderingDecisionAmended: true,
      readOnlyDecisionReaffirmed: true,
      newDecisionPreservesArchitecture: true
    });
  });
});

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(path.join(repoRoot, relativePath), "utf8").catch(() => "");
}
