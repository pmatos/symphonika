import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const readmePath = path.join(repoRoot, "README.md");

describe("README", () => {
  it("orients visitors with valid relative documentation links", async () => {
    const readme = await readFile(readmePath, "utf8");

    expect(readme).toContain("Symphonika is a TypeScript/Node orchestrator");
    expect(readme).toContain("[SPEC.md](SPEC.md)");
    expect(readme).toContain("[CONTEXT.md](CONTEXT.md)");
    expect(readme).toContain("[AGENTS.md](AGENTS.md)");
    expect(readme).toContain("[docs/adr/](docs/adr/)");

    for (const href of extractMarkdownLinks(readme)) {
      if (isExternalOrAnchorLink(href)) {
        continue;
      }

      const target = href.split("#")[0] ?? "";
      expect(target).not.toBe("");
      await expect(access(path.join(repoRoot, target))).resolves.toBeUndefined();
    }
  });

  it("documents the quality gate and avoids local operator details", async () => {
    const readme = await readFile(readmePath, "utf8");

    expect(readme).toContain("npm ci");
    expect(readme).toContain("npm run lint");
    expect(readme).toContain("npm run typecheck");
    expect(readme).toContain("npm test");
    expect(readme).toContain("npm run build");
    expect(readme).toContain("[docs/smoke.md](docs/smoke.md)");
    expect(readme).toContain("[WORKFLOW.md](WORKFLOW.md)");
    expect(readme).toContain("[symphonika.yml](symphonika.yml)");
    expect(readme).toContain("private and experimental");
    expect(readme).toContain("single-operator workflow");

    expect(readme).not.toMatch(
      /\/home\/|\/Users\/|GITHUB_TOKEN|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+/,
    );
  });
});

function extractMarkdownLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((href): href is string => href !== undefined);
}

function isExternalOrAnchorLink(href: string): boolean {
  return (
    href.startsWith("#") ||
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("mailto:")
  );
}
