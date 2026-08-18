type DependencyGraphBlocker = {
  number: number;
  owner: string;
  repo: string;
  state: "CLOSED" | "OPEN";
  title: string;
};

export type DependencyGraphIssue = {
  blockedBy: DependencyGraphBlocker[];
  blockedByTruncated: boolean;
  issueNumber: number;
  owner: string;
  parentIssueNumber?: number;
  projectName: string;
  repo: string;
  title: string;
};

type DependencyGraphNodeData = {
  id: string;
  issueNumber: number;
  // The rendered cytoscape node label -- distinct from `title` so an
  // external node's owner/repo#N qualifier (needed so its numbering can't
  // be mistaken for a local issue) doesn't also leak into the detail
  // panel's separate "Title" row, which shows `title` alone.
  label: string;
  kind: "cluster" | "external" | "issue";
  owner: string;
  parent?: string;
  projectName?: string;
  repo: string;
  state?: "CLOSED" | "OPEN";
  title: string;
  truncated?: boolean;
};

export type DependencyGraphNode = { data: DependencyGraphNodeData };

type DependencyGraphEdge = {
  data: { id: string; source: string; target: string };
};

export type DependencyGraphElements = {
  edges: DependencyGraphEdge[];
  nodes: DependencyGraphNode[];
};

// GitHub owner/repo lookups are case-insensitive, but a Project's configured
// tracker.owner/repo and a blockedBy entry's GraphQL-returned owner/repo can
// disagree in case for the identical repository -- normalized here so both
// sides of the same physical issue always resolve to one node id. The
// separate `owner`/`repo` fields on each node's `data` keep their original
// casing for display.
// Exported so the view can compute a `?issue=`-focused node's id the exact
// same way the elements it's looking for were built, rather than
// duplicating the id scheme at the call site.
export function issueNodeId(
  owner: string,
  repo: string,
  issueNumber: number
): string {
  return `issue:${owner.toLowerCase()}/${repo.toLowerCase()}#${issueNumber}`;
}

export function buildDependencyGraphElements(
  issues: readonly DependencyGraphIssue[]
): DependencyGraphElements {
  const nodesById = new Map<string, DependencyGraphNode>();
  const edges: DependencyGraphEdge[] = [];

  for (const issue of issues) {
    const id = issueNodeId(issue.owner, issue.repo, issue.issueNumber);
    nodesById.set(id, {
      data: {
        id,
        issueNumber: issue.issueNumber,
        label: issue.title,
        kind: "issue",
        owner: issue.owner,
        projectName: issue.projectName,
        repo: issue.repo,
        state: "OPEN",
        title: issue.title,
        ...(issue.blockedByTruncated ? { truncated: true } : {})
      }
    });
  }

  for (const issue of issues) {
    if (issue.parentIssueNumber === undefined) {
      continue;
    }
    const childId = issueNodeId(issue.owner, issue.repo, issue.issueNumber);
    // Always the same id an issue node or a blockedBy entry for this same
    // physical issue would already use (or will later use) -- so whichever
    // of the three loops reaches this issue first "wins" its node, and the
    // others just add an edge/parent reference to it, rather than each
    // synthesizing a disconnected duplicate under a different id scheme.
    const parentId = issueNodeId(
      issue.owner,
      issue.repo,
      issue.parentIssueNumber
    );
    if (!nodesById.has(parentId)) {
      nodesById.set(parentId, {
        data: {
          id: parentId,
          issueNumber: issue.parentIssueNumber,
          label: `${issue.owner}/${issue.repo}#${issue.parentIssueNumber}`,
          kind: "cluster",
          owner: issue.owner,
          repo: issue.repo,
          title: `${issue.owner}/${issue.repo}#${issue.parentIssueNumber}`
        }
      });
    }
    const childNode = nodesById.get(childId);
    if (childNode !== undefined) {
      childNode.data.parent = parentId;
    }
  }

  for (const issue of issues) {
    const targetId = issueNodeId(issue.owner, issue.repo, issue.issueNumber);
    for (const blocker of issue.blockedBy) {
      const sourceId = issueNodeId(blocker.owner, blocker.repo, blocker.number);
      if (!nodesById.has(sourceId)) {
        nodesById.set(sourceId, {
          data: {
            id: sourceId,
            issueNumber: blocker.number,
            label: `${blocker.owner}/${blocker.repo}#${blocker.number}\n${blocker.title}`,
            kind: "external",
            owner: blocker.owner,
            repo: blocker.repo,
            state: blocker.state,
            title: blocker.title
          }
        });
      }
      edges.push({
        data: {
          id: `${sourceId}->${targetId}`,
          source: sourceId,
          target: targetId
        }
      });
    }
  }

  return { edges, nodes: Array.from(nodesById.values()) };
}
