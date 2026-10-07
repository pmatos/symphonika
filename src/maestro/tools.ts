import type { MaestroCitation } from "../run-store.js";
import type { MaestroEvidenceReader } from "./reader.js";

// The closed, read-only tool surface offered to the model (src/maestro/
// model.ts) and the Messages API (src/maestro/conversation.ts). Deliberately
// a fixed list, not an extensible registry — AC3 ("no GitHub-write, shell,
// or local-workspace tool") holds because no write-shaped tool is ever
// defined here, not because a runtime check blocks one. See the
// "never registers a write-shaped tool" test.
export type MaestroToolSpec = {
  description: string;
  inputSchema: {
    additionalProperties: false;
    properties: Record<string, unknown>;
    required: string[];
    type: "object";
  };
  name: string;
};

export type MaestroToolOutcome =
  | { citations: MaestroCitation[]; kind: "ok"; output: unknown }
  | { kind: "refused"; reason: string };

export const MAESTRO_TOOLS: MaestroToolSpec[] = [
  {
    description:
      "List every configured Project's poll status: validation state, " +
      "last successful poll time, and the last poll's ok/error outcome.",
    inputSchema: {
      additionalProperties: false,
      properties: {},
      required: [],
      type: "object"
    },
    name: "list_projects"
  },
  {
    description:
      "List the most recently polled Issue snapshot for one Project, with " +
      "each Issue's eligibility kind/reasons and labels.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        project_name: { type: "string" }
      },
      required: ["project_name"],
      type: "object"
    },
    name: "list_issues"
  },
  {
    description: "Get one Issue's most recently polled snapshot by number.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        issue_number: { type: "integer" },
        project_name: { type: "string" }
      },
      required: ["project_name", "issue_number"],
      type: "object"
    },
    name: "get_issue"
  },
  {
    description:
      "List Runs, optionally scoped to one Project, with current state and " +
      "terminal reason.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        project_name: { type: "string" }
      },
      required: [],
      type: "object"
    },
    name: "list_runs"
  },
  {
    description: "Get one Run by id.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        run_id: { type: "string" }
      },
      required: ["run_id"],
      type: "object"
    },
    name: "get_run"
  },
  {
    description:
      "List the most recently polled pull-request snapshot for one Project.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        project_name: { type: "string" }
      },
      required: ["project_name"],
      type: "object"
    },
    name: "list_pull_requests"
  }
];

const MAESTRO_TOOL_NAMES: ReadonlySet<string> = new Set(
  MAESTRO_TOOLS.map((tool) => tool.name)
);

function projectCitation(project: {
  href: string;
  observedAt: string;
  projectName: string;
}): MaestroCitation {
  return {
    href: project.href,
    kind: "project",
    label: project.projectName,
    observedAt: project.observedAt
  };
}

function issueCitation(issue: {
  href: string;
  issueNumber: number;
  observedAt: string;
  projectName: string;
}): MaestroCitation {
  return {
    href: issue.href,
    kind: "issue",
    label: `${issue.projectName}#${issue.issueNumber}`,
    observedAt: issue.observedAt
  };
}

function runCitation(run: {
  href: string;
  id: string;
  observedAt: string;
  projectName: string;
}): MaestroCitation {
  return {
    href: run.href,
    kind: "run",
    label: `${run.projectName} run ${run.id}`,
    observedAt: run.observedAt
  };
}

function pullRequestCitation(pr: {
  href: string;
  observedAt: string;
  prNumber: number;
  projectName: string;
}): MaestroCitation {
  return {
    href: pr.href,
    kind: "pull_request",
    label: `${pr.projectName}#${pr.prNumber}`,
    observedAt: pr.observedAt
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(input: unknown, key: string): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function integerField(input: unknown, key: string): number | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const value = input[key];
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

export function executeMaestroTool(input: {
  input: unknown;
  name: string;
  reader: MaestroEvidenceReader;
}): MaestroToolOutcome {
  if (!MAESTRO_TOOL_NAMES.has(input.name)) {
    return { kind: "refused", reason: `unknown tool "${input.name}"` };
  }

  if (input.name === "list_projects") {
    const projects = input.reader.listProjects();
    return {
      citations: projects.map(projectCitation),
      kind: "ok",
      output: projects
    };
  }

  if (input.name === "list_issues") {
    const projectName = stringField(input.input, "project_name");
    if (projectName === undefined) {
      return { kind: "refused", reason: "project_name is required" };
    }
    const issues = input.reader.listIssues(projectName);
    return {
      citations: issues.map(issueCitation),
      kind: "ok",
      output: issues
    };
  }

  if (input.name === "get_issue") {
    const projectName = stringField(input.input, "project_name");
    const issueNumber = integerField(input.input, "issue_number");
    if (projectName === undefined || issueNumber === undefined) {
      return {
        kind: "refused",
        reason: "project_name and issue_number are required"
      };
    }
    const issue = input.reader.getIssue(projectName, issueNumber);
    return {
      citations: issue === undefined ? [] : [issueCitation(issue)],
      kind: "ok",
      output: issue ?? { found: false }
    };
  }

  if (input.name === "list_runs") {
    const projectName = stringField(input.input, "project_name");
    const runs = input.reader.listRuns(projectName);
    return { citations: runs.map(runCitation), kind: "ok", output: runs };
  }

  if (input.name === "get_run") {
    const runId = stringField(input.input, "run_id");
    if (runId === undefined) {
      return { kind: "refused", reason: "run_id is required" };
    }
    const run = input.reader.getRun(runId);
    return {
      citations: run === undefined ? [] : [runCitation(run)],
      kind: "ok",
      output: run ?? { found: false }
    };
  }

  // input.name === "list_pull_requests": the only remaining registered tool.
  const projectName = stringField(input.input, "project_name");
  if (projectName === undefined) {
    return { kind: "refused", reason: "project_name is required" };
  }
  const pullRequests = input.reader.listPullRequests(projectName);
  return {
    citations: pullRequests.map(pullRequestCitation),
    kind: "ok",
    output: pullRequests
  };
}
