import type {
  ProjectIssueSnapshotRow,
  ProjectSnapshotRepository
} from "../run-store.js";
import type { WriteIssueLabelsFn } from "./app.js";

type DependencySnapshot = Pick<
  ProjectIssueSnapshotRow,
  "blockedBy" | "blockedByTruncated"
>;

type LabelTarget = {
  projectName: string;
  subjectNumber: number;
  snapshotRepository?: ProjectSnapshotRepository | undefined;
} & (
  | { kind: "issue"; dependencySnapshot: DependencySnapshot }
  | { kind: "pull_request" }
);

export type BulkIssueOperation = {
  issueNumber: number;
  projectName: string;
  snapshotRepository?: ProjectSnapshotRepository;
};

type SingleLabelEditResult =
  | { label: string; ok: true }
  | { error: string; label: string; offerPollNow?: true; ok: false };

type BulkIssueLabelResult =
  | { issueNumber: number; ok: true; projectName: string }
  | { error: string; issueNumber: number; ok: false; projectName: string };

type BulkLabelEditResult =
  | { error: string; kind: "invalid" | "unavailable" }
  | { kind: "completed"; results: BulkIssueLabelResult[] };

const PROTECTED_LABEL_ERROR =
  "sym:* labels are managed by Symphonika and can't be edited here (ADR 0002/0024)";
const UNAVAILABLE_ERROR = "label writes are unavailable";
const BULK_LABEL_WRITE_CONCURRENCY = 4;

export function isOrchestratorLabel(label: string): boolean {
  // GitHub matches names case-insensitively; rendering and mutation refusal
  // must both protect spellings such as SYM:claimed (ADR 0002/0024/0077).
  return label.toLowerCase().startsWith("sym:");
}

export function createOperatorLabelEditor(dependencies: {
  issueSnapshotsFor: (
    projectName: string
  ) => readonly (DependencySnapshot & { issueNumber: number })[];
  readyLabelsFor: (projectName: string) => readonly string[];
  writeLabels?: WriteIssueLabelsFn | undefined;
}) {
  const { issueSnapshotsFor, readyLabelsFor, writeLabels } = dependencies;

  // This is the persisted-snapshot UX gate from ADR 0081, not authoritative
  // Dispatch Eligibility. Only an addition of a Ready Label needs evidence;
  // removals and unrelated additions must reach GitHub even if it is absent.
  function dependencyError(
    projectName: string,
    subjectNumber: number,
    addLabels: string[],
    snapshotFor: () => DependencySnapshot | undefined
  ): string | undefined {
    const readyLabels = readyLabelsFor(projectName).map((label) =>
      label.toLowerCase()
    );
    if (!addLabels.some((label) => readyLabels.includes(label.toLowerCase()))) {
      return undefined;
    }
    const snapshot = snapshotFor();
    if (snapshot === undefined) {
      return `issue #${subjectNumber} is not in the current poll snapshot -- poll now, then retry`;
    }
    const unresolved = snapshot.blockedBy.filter(
      (blocker) => blocker.state !== "CLOSED"
    );
    if (unresolved.length === 0 && !snapshot.blockedByTruncated) {
      return undefined;
    }
    const message =
      unresolved.length === 0
        ? "blocked: this issue has more dependency links than could be checked"
        : `blocked by open ${unresolved.length === 1 ? "dependency" : "dependencies"} ${unresolved
            .map(
              (blocker) => `${blocker.owner}/${blocker.repo}#${blocker.number}`
            )
            .join(", ")}`;
    return `${message} -- resolve on GitHub, then poll now`;
  }

  return {
    async single(input: {
      action: "add" | "remove";
      label: string | undefined;
      target: LabelTarget;
    }): Promise<SingleLabelEditResult> {
      const { action, target } = input;
      const label = (input.label ?? "").trim();
      if (label.length === 0) {
        return { error: "a label is required", label, ok: false };
      }
      if (isOrchestratorLabel(label)) {
        return { error: PROTECTED_LABEL_ERROR, label, ok: false };
      }
      const add = action === "add" ? [label] : [];
      if (action === "add" && target.kind === "issue") {
        const error = dependencyError(
          target.projectName,
          target.subjectNumber,
          add,
          () => target.dependencySnapshot
        );
        if (error !== undefined) {
          return { error, label, offerPollNow: true, ok: false };
        }
      }
      if (writeLabels === undefined) {
        return { error: UNAVAILABLE_ERROR, label, ok: false };
      }
      const result = await writeLabels({
        add,
        kind: target.kind,
        projectName: target.projectName,
        remove: action === "remove" ? [label] : [],
        snapshotRepository: target.snapshotRepository,
        subjectNumber: target.subjectNumber
      });
      return { ...result, label };
    },
    async bulk(input: {
      addLabels: string[];
      operations: BulkIssueOperation[];
      removeLabels: string[];
    }): Promise<BulkLabelEditResult> {
      const { addLabels, operations, removeLabels } = input;
      // JSON shape validation belongs to the route. These whole-request
      // checks must finish before any worker can mutate a selected Issue.
      if ([...addLabels, ...removeLabels].some(isOrchestratorLabel)) {
        return { error: PROTECTED_LABEL_ERROR, kind: "invalid" };
      }
      if (operations.length === 0) {
        return {
          error: "at least one issue in operations is required",
          kind: "invalid"
        };
      }
      if (addLabels.length === 0 && removeLabels.length === 0) {
        return {
          error: "at least one label to add or remove is required",
          kind: "invalid"
        };
      }
      if (writeLabels === undefined) {
        return { error: UNAVAILABLE_ERROR, kind: "unavailable" };
      }
      const write = writeLabels;
      const results = new Array<BulkIssueLabelResult>(operations.length);
      let nextIndex = 0;
      // A batch observes each Project once; a later batch reads fresh evidence.
      const snapshotsByProject = new Map<
        string,
        ReturnType<typeof issueSnapshotsFor>
      >();
      function snapshotFor(operation: BulkIssueOperation) {
        let snapshots = snapshotsByProject.get(operation.projectName);
        if (snapshots === undefined) {
          snapshots = issueSnapshotsFor(operation.projectName);
          snapshotsByProject.set(operation.projectName, snapshots);
        }
        return snapshots.find(
          (row) => row.issueNumber === operation.issueNumber
        );
      }

      async function worker(): Promise<void> {
        for (;;) {
          const index = nextIndex++;
          const operation = operations[index];
          if (operation === undefined) {
            return;
          }
          const error = dependencyError(
            operation.projectName,
            operation.issueNumber,
            addLabels,
            () => snapshotFor(operation)
          );
          // Skip the entire combined operation on refusal. Otherwise forward
          // the full removal list: poll-stale labels must never narrow a write.
          const result =
            error !== undefined
              ? { error, ok: false as const }
              : await write({
                  add: addLabels,
                  kind: "issue",
                  projectName: operation.projectName,
                  remove: removeLabels,
                  snapshotRepository: operation.snapshotRepository,
                  subjectNumber: operation.issueNumber
                });
          results[index] = {
            ...result,
            issueNumber: operation.issueNumber,
            projectName: operation.projectName
          };
        }
      }

      const workerCount = Math.min(
        BULK_LABEL_WRITE_CONCURRENCY,
        operations.length
      );
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      return { kind: "completed", results };
    }
  };
}
