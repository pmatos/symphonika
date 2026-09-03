import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

describe("provider sandboxing posture documentation", () => {
  it("records status quo as the accepted extension of ADR 0015", async () => {
    const [spec, fullPermissionAdr, sandboxingAdr] = await Promise.all([
      readRepositoryFile("SPEC.md"),
      readRepositoryFile("docs/adr/0015-full-permission-agent-execution.md"),
      readRepositoryFile(
        "docs/adr/0097-provider-filesystem-sandboxing-posture.md"
      )
    ]);

    expect({
      accepted: sandboxingAdr.includes("Status: Accepted"),
      bwrapDeferred: sandboxingAdr.includes(
        "Defer `bwrap` filesystem sandboxing"
      ),
      claudeAutoNotDefault: sandboxingAdr.includes(
        "Do not make Claude's `--permission-mode auto` an interim Symphonika default"
      ),
      fullPermissionDefaultsReaffirmed: sandboxingAdr.includes(
        "Keep ADR-0015's full-permission provider defaults unchanged"
      ),
      foundationalAdrLinked: fullPermissionAdr.includes(
        "Reaffirmed by ADR-0097"
      ),
      providerNeutralBoundary: sandboxingAdr.includes(
        "outside the Agent Provider boundary"
      ),
      specLinked: spec.includes(
        "ADR-0097 keeps this provider-neutral full-permission default"
      )
    }).toEqual({
      accepted: true,
      bwrapDeferred: true,
      claudeAutoNotDefault: true,
      fullPermissionDefaultsReaffirmed: true,
      foundationalAdrLinked: true,
      providerNeutralBoundary: true,
      specLinked: true
    });
  });
});

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(path.join(repoRoot, relativePath), "utf8").catch(() => "");
}
