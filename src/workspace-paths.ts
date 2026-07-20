import path from "node:path";

export type WorkspacePathInputs = {
  configDir?: string;
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
  const projectSlug = slugifyWorkspaceSegment(input.project.name, "project");
  const issueSlug = slugifyWorkspaceSegment(input.issue.title, "issue");
  const issueDirectoryName = `${input.issue.number}-${issueSlug}`;
  const workspaceRoot = path.resolve(
    input.configDir ?? process.cwd(),
    input.project.workspace.root
  );
  const branchName = `sym/${projectSlug}/${issueDirectoryName}`;

  return {
    branchName,
    branchRef: `refs/heads/${branchName}`,
    cachePath: path.join(workspaceRoot, ".cache", "repo.git"),
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
