import path from "node:path";

import { describe, expect, it } from "vitest";

import { planWorkspacePaths } from "../src/workspace-paths.js";

describe("planWorkspacePaths", () => {
  it("returns the same deterministic workspace plan for the same project and issue", () => {
    const input = {
      configDir: "/config",
      issue: {
        number: 146,
        title: "Extract a pure planWorkspacePaths module"
      },
      project: {
        name: "Symphonika",
        workspace: {
          root: "./.symphonika/workspaces/symphonika"
        }
      }
    };

    const first = planWorkspacePaths(input);
    const second = planWorkspacePaths(input);

    expect(second).toEqual(first);
    expect(first).toEqual({
      branchName: "sym/symphonika/146-extract-a-pure-planworkspacepaths-module",
      branchRef:
        "refs/heads/sym/symphonika/146-extract-a-pure-planworkspacepaths-module",
      cachePath: path.join(
        "/config",
        ".symphonika",
        "workspaces",
        "symphonika",
        ".cache",
        "repo.git"
      ),
      issueDirectoryName: "146-extract-a-pure-planworkspacepaths-module",
      workspacePath: path.join(
        "/config",
        ".symphonika",
        "workspaces",
        "symphonika",
        "issues",
        "146-extract-a-pure-planworkspacepaths-module"
      )
    });
  });

  it("returns different plans for different project and issue inputs", () => {
    const base = planWorkspacePaths({
      configDir: "/config",
      issue: {
        number: 146,
        title: "Extract a pure planWorkspacePaths module"
      },
      project: {
        name: "symphonika",
        workspace: {
          root: "./.symphonika/workspaces/symphonika"
        }
      }
    });

    const differentIssue = planWorkspacePaths({
      configDir: "/config",
      issue: {
        number: 147,
        title: "Extract a pure planWorkspacePaths module"
      },
      project: {
        name: "symphonika",
        workspace: {
          root: "./.symphonika/workspaces/symphonika"
        }
      }
    });
    const differentProject = planWorkspacePaths({
      configDir: "/config",
      issue: {
        number: 146,
        title: "Extract a pure planWorkspacePaths module"
      },
      project: {
        name: "other project",
        workspace: {
          root: "./.symphonika/workspaces/other"
        }
      }
    });

    expect(differentIssue).not.toEqual(base);
    expect(differentIssue.issueDirectoryName).toBe(
      "147-extract-a-pure-planworkspacepaths-module"
    );
    expect(differentProject.branchName).toBe(
      "sym/other-project/146-extract-a-pure-planworkspacepaths-module"
    );
    expect(differentProject.workspacePath).toBe(
      path.join(
        "/config",
        ".symphonika",
        "workspaces",
        "other",
        "issues",
        "146-extract-a-pure-planworkspacepaths-module"
      )
    );
  });

  it("keeps slug output stable for Unicode and edge-case titles", () => {
    const unicode = planWorkspacePaths({
      configDir: "/config",
      issue: {
        number: 42,
        title: "Déjà vu / workspace prep ✨"
      },
      project: {
        name: "Crème Brûlée",
        workspace: {
          root: "workspaces/unicode"
        }
      }
    });
    const punctuationOnly = planWorkspacePaths({
      configDir: "/config",
      issue: {
        number: 43,
        title: "✨ / ../ !!!"
      },
      project: {
        name: "✨",
        workspace: {
          root: "workspaces/fallback"
        }
      }
    });

    expect(unicode.branchName).toBe(
      "sym/creme-brulee/42-deja-vu-workspace-prep"
    );
    expect(unicode.issueDirectoryName).toBe("42-deja-vu-workspace-prep");
    expect(punctuationOnly.branchName).toBe("sym/project/43-issue");
    expect(punctuationOnly.issueDirectoryName).toBe("43-issue");
    expect(punctuationOnly.issueDirectoryName).not.toContain("/");
    expect(punctuationOnly.issueDirectoryName).not.toContain("..");
  });
});
