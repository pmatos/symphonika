import type { DispatchProjectConfig } from "./run-controller.js";
import type {
  GitHubIssueRepositoryInput,
  IssueSnapshot
} from "../issue-polling.js";

// The dependencies the scheduled-dispatch prologue needs, as ports so the
// resolution is exercisable without constructing a RunController. Each adapter
// closes over the controller's already-injected collaborators
// (`githubIssuesApi`, `env`) and its private `refreshIssue`.
export type ScheduledDispatchPorts = {
  isLabelWritingApi: () => boolean;
  resolveToken: (tokenReference: string) => string | undefined;
  refreshIssue: (input: {
    project: DispatchProjectConfig;
    issueNumber: number;
    repository: GitHubIssueRepositoryInput;
  }) => Promise<IssueSnapshot | null | undefined>;
};

export type ScheduledDispatchRequest = {
  project: DispatchProjectConfig;
  issueNumber: number;
  // `false` only for the waiting-run re-eval path, which is deliberately not
  // gated on label-writing capability (issues #731/#737/#740/#745). Required so
  // no caller silently inherits a default.
  requireLabelWritingApi: boolean;
};

export type ScheduledDispatchContext =
  | {
      kind: "resolved";
      repository: GitHubIssueRepositoryInput;
      // May be null when the tracker reports the issue gone. The caller owns the
      // null / closed / eligibility reaction — this seam resolves I/O and
      // credentials, not dispatch policy.
      issue: IssueSnapshot | null;
    }
  | {
      kind: "dropped";
      reason:
        | "label_writes_unavailable"
        | "token_unavailable"
        | "refresh_unavailable";
    };

// The token -> repository -> refresh tail shared by every scheduled-dispatch
// entry point (executeRetry, reEvaluateWaitingRun, executeStateAdvance,
// executeContinuation, dispatchReviewFollowup). It classifies the drop with a
// typed reason but never acts on it and never logs: each caller maps the reason
// to its own reaction (bare return / warn / claimLabels.release /
// cancelScheduledLifecycleWork / markCancelRequested / typed result) and owns
// the eligibility decision on a resolved issue.
export async function resolveScheduledDispatchContext(
  ports: ScheduledDispatchPorts,
  request: ScheduledDispatchRequest
): Promise<ScheduledDispatchContext> {
  if (request.requireLabelWritingApi && !ports.isLabelWritingApi()) {
    return { kind: "dropped", reason: "label_writes_unavailable" };
  }
  const token = ports.resolveToken(request.project.tracker.token);
  if (token === undefined) {
    return { kind: "dropped", reason: "token_unavailable" };
  }
  const repository: GitHubIssueRepositoryInput = {
    owner: request.project.tracker.owner,
    repo: request.project.tracker.repo,
    token
  };
  const issue = await ports.refreshIssue({
    project: request.project,
    issueNumber: request.issueNumber,
    repository
  });
  if (issue === undefined) {
    return { kind: "dropped", reason: "refresh_unavailable" };
  }
  return { kind: "resolved", repository, issue };
}
