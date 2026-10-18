import { describe, expect, it, vi } from "vitest";

import { createOperatorLabelEditor } from "../src/http/operator-label-edit.js";
import type { WriteIssueLabelsFn } from "../src/http/app.js";

const repository = { owner: "pmatos", repo: "symphonika" };
const openBlocker = {
  number: 301,
  owner: "pmatos",
  repo: "symphonika",
  state: "OPEN" as const,
  title: "Prerequisite"
};
const clear = { blockedBy: [], blockedByTruncated: false };
const blocked = { blockedBy: [openBlocker], blockedByTruncated: false };
const target = {
  dependencySnapshot: blocked,
  kind: "issue" as const,
  projectName: "alpha",
  snapshotRepository: repository,
  subjectNumber: 7
};

function setup() {
  const writeLabels = vi.fn<WriteIssueLabelsFn>(() =>
    Promise.resolve({ ok: true })
  );
  const readyLabelsFor = vi.fn(() => ["agent-ready"]);
  const issueSnapshotsFor = vi.fn(() => [
    { ...blocked, issueNumber: 7 },
    { ...clear, issueNumber: 8 }
  ]);
  return {
    editor: createOperatorLabelEditor({
      issueSnapshotsFor,
      readyLabelsFor,
      writeLabels
    }),
    issueSnapshotsFor,
    readyLabelsFor,
    writeLabels
  };
}

describe("Operator Label Edit", () => {
  it.each([
    [undefined, "a label is required"],
    [" \t ", "a label is required"],
    [
      " SYM:claimed ",
      "sym:* labels are managed by Symphonika and can't be edited here (ADR 0002/0024)"
    ]
  ])(
    "refuses form label %j before resolving dependency policy",
    async (label, error) => {
      const { editor, readyLabelsFor, writeLabels } = setup();
      expect(await editor.single({ action: "add", label, target })).toEqual({
        error,
        label: label?.trim() ?? "",
        ok: false
      });
      expect(readyLabelsFor).not.toHaveBeenCalled();
      expect(writeLabels).not.toHaveBeenCalled();
    }
  );

  it("reports the dependency refusal before writer unavailability", async () => {
    const editor = createOperatorLabelEditor({
      issueSnapshotsFor: () => [],
      readyLabelsFor: () => ["agent-ready"]
    });
    expect(
      await editor.single({ action: "add", label: " Agent-Ready ", target })
    ).toEqual({
      error:
        "blocked by open dependency pmatos/symphonika#301 -- resolve on GitHub, then poll now",
      label: "Agent-Ready",
      offerPollNow: true,
      ok: false
    });
    expect(
      await editor.single({ action: "remove", label: "agent-ready", target })
    ).toEqual({
      error: "label writes are unavailable",
      label: "agent-ready",
      ok: false
    });
  });

  it.each([
    { blockedBy: [], blockedByTruncated: true },
    {
      blockedBy: [{ ...openBlocker, state: "CLOSED" as const }],
      blockedByTruncated: true
    }
  ])("fails closed on truncated dependency evidence %j", async (snapshot) => {
    const { editor, writeLabels } = setup();
    expect(
      await editor.single({
        action: "add",
        label: "agent-ready",
        target: { ...target, dependencySnapshot: snapshot }
      })
    ).toMatchObject({
      error:
        "blocked: this issue has more dependency links than could be checked -- resolve on GitHub, then poll now",
      offerPollNow: true,
      ok: false
    });
    expect(writeLabels).not.toHaveBeenCalled();
  });

  it("uses the supplied closed dependency evidence and preserves repository identity", async () => {
    const { editor, issueSnapshotsFor, writeLabels } = setup();
    expect(
      await editor.single({
        action: "add",
        label: " Agent-Ready ",
        target: {
          ...target,
          dependencySnapshot: {
            blockedBy: [{ ...openBlocker, state: "CLOSED" }],
            blockedByTruncated: false
          }
        }
      })
    ).toEqual({ label: "Agent-Ready", ok: true });
    expect(issueSnapshotsFor).not.toHaveBeenCalled();
    expect(writeLabels).toHaveBeenCalledExactlyOnceWith({
      add: ["Agent-Ready"],
      kind: "issue",
      projectName: "alpha",
      remove: [],
      snapshotRepository: repository,
      subjectNumber: 7
    });
  });

  it("does not apply Issue dependency policy to a PR and preserves write failure", async () => {
    const { editor, issueSnapshotsFor, readyLabelsFor, writeLabels } = setup();
    writeLabels.mockResolvedValue({ error: "token refused", ok: false });
    expect(
      await editor.single({
        action: "add",
        label: "agent-ready",
        target: {
          kind: "pull_request",
          projectName: "alpha",
          snapshotRepository: repository,
          subjectNumber: 7
        }
      })
    ).toEqual({ error: "token refused", label: "agent-ready", ok: false });
    expect(readyLabelsFor).not.toHaveBeenCalled();
    expect(issueSnapshotsFor).not.toHaveBeenCalled();
    expect(writeLabels).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "pull_request" })
    );
  });

  it.each([
    {
      addLabels: ["agent-ready"],
      error:
        "sym:* labels are managed by Symphonika and can't be edited here (ADR 0002/0024)",
      operations: [],
      removeLabels: ["SyM:running"]
    },
    {
      addLabels: [],
      error: "at least one issue in operations is required",
      operations: [],
      removeLabels: []
    },
    {
      addLabels: [],
      error: "at least one label to add or remove is required",
      operations: [{ issueNumber: 7, projectName: "alpha" }],
      removeLabels: []
    }
  ])(
    "refuses the entire bulk request before unavailable writes: $error",
    async ({ error, ...request }) => {
      const issueSnapshotsFor = vi.fn(() => []);
      const readyLabelsFor = vi.fn(() => ["agent-ready"]);
      const editor = createOperatorLabelEditor({
        issueSnapshotsFor,
        readyLabelsFor
      });
      expect(await editor.bulk(request)).toEqual({ error, kind: "invalid" });
      expect(issueSnapshotsFor).not.toHaveBeenCalled();
      expect(readyLabelsFor).not.toHaveBeenCalled();
    }
  );

  it("refuses unavailable bulk writes before looking up individual dependency evidence", async () => {
    const issueSnapshotsFor = vi.fn(() => []);
    const editor = createOperatorLabelEditor({
      issueSnapshotsFor,
      readyLabelsFor: () => ["agent-ready"]
    });
    expect(
      await editor.bulk({
        addLabels: ["agent-ready"],
        operations: [{ issueNumber: 7, projectName: "alpha" }],
        removeLabels: []
      })
    ).toEqual({ error: "label writes are unavailable", kind: "unavailable" });
    expect(issueSnapshotsFor).not.toHaveBeenCalled();
  });

  it("caches snapshots per batch, skips complete blocked changes, and retains ordered individual failures", async () => {
    const { editor, issueSnapshotsFor, writeLabels } = setup();
    writeLabels.mockResolvedValue({ error: "write refused", ok: false });
    const request = {
      addLabels: ["Agent-Ready"],
      operations: [7, 8, 999].map((issueNumber) => ({
        issueNumber,
        projectName: "alpha",
        snapshotRepository: repository
      })),
      removeLabels: ["needs-triage", "absent-from-snapshot"]
    };
    expect(await editor.bulk(request)).toEqual({
      kind: "completed",
      results: [
        {
          error:
            "blocked by open dependency pmatos/symphonika#301 -- resolve on GitHub, then poll now",
          issueNumber: 7,
          ok: false,
          projectName: "alpha"
        },
        {
          error: "write refused",
          issueNumber: 8,
          ok: false,
          projectName: "alpha"
        },
        {
          error:
            "issue #999 is not in the current poll snapshot -- poll now, then retry",
          issueNumber: 999,
          ok: false,
          projectName: "alpha"
        }
      ]
    });
    expect(issueSnapshotsFor).toHaveBeenCalledTimes(1);
    expect(writeLabels).toHaveBeenCalledExactlyOnceWith({
      add: request.addLabels,
      kind: "issue",
      projectName: "alpha",
      remove: request.removeLabels,
      snapshotRepository: repository,
      subjectNumber: 8
    });
    await editor.bulk(request);
    expect(issueSnapshotsFor).toHaveBeenCalledTimes(2);
  });

  it("retains literal bulk labels and avoids snapshot reads for unrelated additions and removals", async () => {
    const { editor, issueSnapshotsFor, writeLabels } = setup();
    expect(
      await editor.bulk({
        addLabels: [" agent-ready "],
        operations: [{ issueNumber: 999, projectName: "alpha" }],
        removeLabels: ["agent-ready", "not-in-the-snapshot"]
      })
    ).toEqual({
      kind: "completed",
      results: [{ issueNumber: 999, ok: true, projectName: "alpha" }]
    });
    expect(issueSnapshotsFor).not.toHaveBeenCalled();
    expect(writeLabels).toHaveBeenCalledWith(
      expect.objectContaining({
        add: [" agent-ready "],
        remove: ["agent-ready", "not-in-the-snapshot"]
      })
    );
  });
});
