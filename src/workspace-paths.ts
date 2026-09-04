import path from "node:path";

export type ExistingWorkspacePlan = {
  branchName: string;
  workspacePath: string;
};

export type WorkspacePathInputs = {
  configDir?: string;
  // A branch/workspace already decided at an earlier attempt in this Run's
  // chain (persisted on the `runs` row). When present it wins over a fresh
  // derivation from `issue.title` -- the title may have been edited after
  // the branch was created, and re-deriving from it would silently point a
  // continuation at a different, unrelated branch/workspace. See issue #699.
  existing?: ExistingWorkspacePlan;
  issue: { number: number; title: string };
  project: {
    name: string;
    workspace: { root: string };
  };
};

export type WorkspacePathPlan = {
  branchName: string;
  branchRef: string;
  cachePath: string;
  issueDirectoryName: string;
  workspacePath: string;
};

export function planWorkspacePaths(
  input: WorkspacePathInputs
): WorkspacePathPlan {
  const workspaceRoot = path.resolve(
    input.configDir ?? process.cwd(),
    input.project.workspace.root
  );
  const cachePath = path.join(workspaceRoot, ".cache", "repo.git");

  if (input.existing !== undefined) {
    return {
      branchName: input.existing.branchName,
      branchRef: `refs/heads/${input.existing.branchName}`,
      cachePath,
      issueDirectoryName: path.basename(input.existing.workspacePath),
      workspacePath: input.existing.workspacePath
    };
  }

  const projectSlug = slugifyWorkspaceSegment(input.project.name, "project");
  const issueSlug = slugifyWorkspaceSegment(input.issue.title, "issue");
  const issueDirectoryName = `${input.issue.number}-${issueSlug}`;
  const branchName = `sym/${projectSlug}/${issueDirectoryName}`;

  return {
    branchName,
    branchRef: `refs/heads/${branchName}`,
    cachePath,
    issueDirectoryName,
    workspacePath: path.join(workspaceRoot, "issues", issueDirectoryName)
  };
}

export function slugifyWorkspaceSegment(
  input: string,
  fallback: string
): string {
  const asciiInput = Array.from(input.normalize("NFKD"))
    .filter((character) => character.charCodeAt(0) <= 0x7f)
    .join("");
  const slug = asciiInput
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length === 0 ? fallback : slug;
}
