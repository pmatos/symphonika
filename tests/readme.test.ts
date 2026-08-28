import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const readmePath = path.join(repoRoot, "README.md");
const execFile = promisify(execFileCallback);

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
      await expect(
        access(path.join(repoRoot, target))
      ).resolves.toBeUndefined();
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
    expect(readme).toContain(
      "[symphonika.example.yml](symphonika.example.yml)"
    );
    expect(readme).toContain("private and experimental");
    expect(readme).toContain("single-operator workflow");
    expect(readme).toContain("Autonomy contract");
    expect(readme).toContain("gh issue comment");
    expect(readme).toContain(
      `codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never -c model_reasoning_summary=detailed -c model_verbosity=medium --dangerously-bypass-approvals-and-sandbox app-server`
    );
    expect(readme).toContain(`sandbox_mode = "danger-full-access"`);
    expect(readme).toContain(`approval_policy = "never"`);
    expect(readme).toContain(`model_reasoning_summary = "detailed"`);
    expect(readme).toContain(`model_verbosity = "medium"`);

    expect(readme).not.toMatch(
      /\/home\/|\/Users\/|GITHUB_TOKEN|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+/
    );
  });

  it("creates the documented env file under the home fallback for a relative XDG config home", async () => {
    const readme = await readFile(readmePath, "utf8");
    const recipe = readme.match(
      /Create the default file[\s\S]*?```sh\n([\s\S]*?)\n```/
    )?.[1];
    const root = await mkdtemp(path.join(tmpdir(), "symphonika-readme-test-"));
    const homeDir = path.join(root, "home");

    expect(recipe).toBeDefined();
    await mkdir(homeDir);
    try {
      await execFile("/bin/sh", ["-c", recipe ?? ""], {
        cwd: root,
        env: {
          ...process.env,
          EDITOR: "true",
          HOME: homeDir,
          XDG_CONFIG_HOME: "relative-config"
        }
      });

      await expect(
        access(path.join(homeDir, ".config", "symphonika", "env"))
      ).resolves.toBeUndefined();
      await expect(
        access(path.join(root, "relative-config", "symphonika", "env"))
      ).rejects.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
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
