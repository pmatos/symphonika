import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import type { IssueNativeParent } from "../src/issue-polling.js";
import { openRunStore, type RunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

type SnapshotRow = Parameters<
  RunStore["replaceProjectIssueSnapshots"]
>[0]["rows"][number];

function row(
  input: Pick<SnapshotRow, "issueNumber" | "labels" | "title"> &
    Partial<SnapshotRow>
): SnapshotRow {
  return {
    blockedBy: [],
    blockedByTruncated: false,
    kind: "candidate",
    priority: 1,
    reasons: [],
    ...input
  };
}

function nativeParent(
  number: number,
  overrides: Partial<
    Extract<IssueNativeParent, { availability: "present" }>
  > = {}
): IssueNativeParent {
  return {
    availability: "present",
    crossRepository: false,
    number,
    owner: "pmatos",
    repo: "alpha",
    state: "OPEN",
    title: `parent ${number}`,
    ...overrides
  };
}

type Seed = {
  epicLabels?: string[];
  pollFailing?: boolean;
  polledAt?: string;
  rows: SnapshotRow[];
  startedAtMs?: number;
};

async function projectPage(seed: Seed): Promise<{ html: string }> {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "symphonika-epic-view-"));
  tempRoots.push(stateRoot);
  const runStore: RunStore = openRunStore({ stateRoot });
  try {
    runStore.syncProjectStates([
      { name: "alpha", validationState: "valid", weight: 1 }
    ]);
    runStore.recordProjectPollOutcome({
      candidateIssues: 1,
      error: null,
      fetchedIssues: seed.rows.length,
      filteredIssues: 0,
      ok: true,
      projectName: "alpha"
    });
    runStore.replaceProjectIssueSnapshots({
      polledAt: seed.polledAt ?? new Date().toISOString(),
      projectName: "alpha",
      repository: { owner: "pmatos", repo: "alpha" },
      rows: seed.rows
    });
    if (seed.pollFailing === true) {
      runStore.recordProjectPollOutcome({
        candidateIssues: 0,
        error: "GitHub token revoked",
        fetchedIssues: 0,
        filteredIssues: 0,
        ok: false,
        projectName: "alpha"
      });
    }
    const app = createHttpApp({
      getProjectQueuePolicy: () => ({
        epicLabels: seed.epicLabels ?? ["epic"],
        priority: { default: 99, labels: {} },
        readyLabel: "agent-ready"
      }),
      runStore,
      ...(seed.startedAtMs === undefined
        ? {}
        : { startedAtMs: seed.startedAtMs }),
      stateRoot,
      version: "0.1.0"
    });
    return { html: await (await app.request("/projects/alpha")).text() };
  } finally {
    runStore.close();
  }
}

function epicView(html: string): string {
  const start = html.indexOf('id="epic-view"');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = html.indexOf("</section>", start);
  return html.slice(start, end);
}

function epicGroup(html: string, epicNumber: number): string {
  const view = epicView(html);
  const start = view.indexOf(`data-epic="${epicNumber}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const tail = view.slice(start + 1);
  const next = tail.search(/data-epic=|class="epic-ungrouped"/);
  return next === -1 ? tail : tail.slice(0, next);
}

function ungrouped(html: string): string {
  const view = epicView(html);
  const start = view.indexOf('class="epic-ungrouped"');
  expect(start).toBeGreaterThanOrEqual(0);
  return view.slice(start);
}

const epic = row({
  issueNumber: 100,
  labels: ["epic"],
  nativeParent: { availability: "none" },
  title: "The epic"
});

describe("Project page epic view (#858 stage B)", () => {
  it("groups a native sub-issue under its epic-labelled Issue with repository and poll provenance", async () => {
    const { html } = await projectPage({
      polledAt: new Date(Date.now() - 90_000).toISOString(),
      rows: [
        epic,
        row({
          issueNumber: 101,
          labels: ["agent-ready"],
          nativeParent: nativeParent(100),
          title: "Native child"
        })
      ]
    });

    const group = epicGroup(html, 100);
    expect(group).toContain("The epic");
    expect(group).toContain("pmatos/alpha");
    expect(group).toContain("/issues/alpha/101");
    expect(group).toContain("Native child");
    expect(group).toMatch(/polled[\s\S]{0,40}ago/i);
    expect(epicView(html)).toMatch(/last successful poll[\s\S]{0,60}ago/i);
  });

  it("never lets a blockedBy link create epic membership, and keeps gating visible only for open blockers", async () => {
    const { html } = await projectPage({
      rows: [
        epic,
        row({
          blockedBy: [
            {
              number: 100,
              owner: "pmatos",
              repo: "alpha",
              state: "OPEN",
              title: "The epic"
            }
          ],
          issueNumber: 103,
          kind: "filtered",
          labels: ["agent-ready"],
          nativeParent: { availability: "none" },
          reasons: ["blocked by open dependency #100"],
          title: "Blocked by the epic only"
        }),
        row({
          blockedBy: [
            {
              number: 9,
              owner: "pmatos",
              repo: "alpha",
              state: "OPEN",
              title: "open prerequisite"
            }
          ],
          issueNumber: 101,
          kind: "filtered",
          labels: ["agent-ready"],
          nativeParent: nativeParent(100),
          reasons: ["blocked by open dependency #9"],
          title: "Child gated by open blocker"
        }),
        row({
          blockedBy: [
            {
              number: 8,
              owner: "pmatos",
              repo: "alpha",
              state: "CLOSED",
              title: "done prerequisite"
            }
          ],
          issueNumber: 102,
          labels: ["agent-ready"],
          nativeParent: nativeParent(100),
          title: "Child with closed blocker"
        })
      ]
    });

    const group = epicGroup(html, 100);
    expect(group).not.toContain("Blocked by the epic only");
    expect(group).not.toContain("/issues/alpha/103");

    const gated = group.slice(group.indexOf("/issues/alpha/101"));
    const gatedRow = gated.slice(0, gated.indexOf("</tr>"));
    expect(gatedRow).toContain("pill--blocked");
    expect(gatedRow).toContain("pmatos/alpha#9");

    const resolved = group.slice(group.indexOf("/issues/alpha/102"));
    const resolvedRow = resolved.slice(0, resolved.indexOf("</tr>"));
    expect(resolvedRow).not.toContain("pill--blocked");
    expect(resolvedRow).toContain("pmatos/alpha#8");
    expect(resolvedRow).toMatch(/resolved|closed/i);

    expect(group).toMatch(/<th[^>]*>Blocked by/);
  });

  it("does not let the ## Parent heading parse create epic membership", async () => {
    const { html } = await projectPage({
      rows: [
        epic,
        row({
          issueNumber: 110,
          labels: ["agent-ready"],
          nativeParent: { availability: "none" },
          parentIssueNumber: 100,
          title: "Heading-only child"
        })
      ]
    });

    expect(epicGroup(html, 100)).not.toContain("Heading-only child");
    expect(epicView(html)).not.toContain("Heading-only child");
    expect(html).toContain('href="/issues/alpha/110"');
  });

  it("shows unavailable and unrecorded parent evidence as degraded, never as a parent or as no parent", async () => {
    const { html } = await projectPage({
      rows: [
        epic,
        row({
          issueNumber: 104,
          labels: ["agent-ready"],
          nativeParent: { availability: "unavailable" },
          title: "Unavailable evidence"
        }),
        row({
          issueNumber: 105,
          labels: ["agent-ready"],
          title: "Unrecorded evidence"
        })
      ]
    });

    expect(epicGroup(html, 100)).not.toContain("/issues/alpha/104");
    expect(epicGroup(html, 100)).not.toContain("/issues/alpha/105");
    const list = ungrouped(html);
    expect(list).toContain("/issues/alpha/104");
    expect(list).toMatch(/parent evidence unavailable/i);
    expect(list).toContain("/issues/alpha/105");
    expect(list).toMatch(/no native parent evidence recorded/i);
    expect(html).toContain('href="/issues/alpha/104"');
    expect(html).toContain('href="/issues/alpha/105"');
  });

  it("badges a cross-repository parent and never groups it under a same-numbered local epic", async () => {
    const { html } = await projectPage({
      rows: [
        epic,
        row({
          issueNumber: 106,
          labels: ["agent-ready"],
          nativeParent: nativeParent(100, {
            crossRepository: true,
            owner: "other",
            repo: "elsewhere"
          }),
          title: "Cross-repo child"
        })
      ]
    });

    expect(epicGroup(html, 100)).not.toContain("Cross-repo child");
    const list = ungrouped(html);
    expect(list).toContain("/issues/alpha/106");
    expect(list).toContain("other/elsewhere#100");
    expect(list).toMatch(/other repository/i);
  });

  it("badges a closed parent without inventing an epic header for it", async () => {
    const { html } = await projectPage({
      rows: [
        row({
          issueNumber: 107,
          labels: ["agent-ready"],
          nativeParent: nativeParent(50, {
            state: "CLOSED",
            title: "<b>old</b>"
          }),
          title: "Child of a closed epic"
        })
      ]
    });

    const view = epicView(html);
    expect(view).not.toContain('data-epic="50"');
    const list = ungrouped(html);
    expect(list).toContain("/issues/alpha/107");
    expect(list).toMatch(/pmatos\/alpha#50/);
    expect(list).toMatch(/closed/i);
    expect(view).not.toContain("<b>old</b>");
  });

  it("badges a closed parent that is still an epic-labelled row, grouping the child under it", async () => {
    const { html } = await projectPage({
      rows: [
        epic,
        row({
          issueNumber: 111,
          labels: ["agent-ready"],
          nativeParent: nativeParent(100, { state: "CLOSED" }),
          title: "Child of closing epic"
        })
      ]
    });

    const group = epicGroup(html, 100);
    expect(group).toContain("Child of closing epic");
    expect(group).toMatch(/parent closed/i);
  });

  it("leaves a child whose open parent is not epic-labelled in the Issues table only", async () => {
    const { html } = await projectPage({
      rows: [
        row({
          issueNumber: 109,
          labels: ["agent-ready"],
          nativeParent: { availability: "none" },
          title: "Plain parent"
        }),
        row({
          issueNumber: 108,
          labels: ["agent-ready"],
          nativeParent: nativeParent(109),
          title: "Child of a plain issue"
        })
      ]
    });

    const view = epicView(html);
    expect(view).not.toContain("Child of a plain issue");
    expect(html).toContain('href="/issues/alpha/108"');
  });

  it("labels a failing latest poll while still showing the last successful snapshot", async () => {
    const { html } = await projectPage({
      pollFailing: true,
      rows: [
        epic,
        row({
          issueNumber: 101,
          labels: ["agent-ready"],
          nativeParent: nativeParent(100),
          title: "Native child"
        })
      ]
    });

    const view = epicView(html);
    expect(view).toContain("pill--fail");
    expect(view).toContain("GitHub token revoked");
    expect(epicGroup(html, 100)).toContain("Native child");
  });

  it("marks a snapshot from before the daemon restarted as pre-restart", async () => {
    const { html } = await projectPage({
      polledAt: "2026-01-01T00:00:00.000Z",
      rows: [epic],
      startedAtMs: Date.parse("2026-06-01T00:00:00.000Z")
    });

    expect(epicView(html)).toContain("pre-restart");
  });

  it("says so when the Project has no epic labels configured", async () => {
    const { html } = await projectPage({ epicLabels: [], rows: [epic] });

    expect(epicView(html)).toMatch(/no epic labels/i);
    expect(epicView(html)).not.toContain('data-epic="100"');
  });

  it("escapes issue titles and repository text", async () => {
    const { html } = await projectPage({
      rows: [
        row({
          issueNumber: 100,
          labels: ["epic"],
          nativeParent: { availability: "none" },
          title: "<script>alert(1)</script>"
        })
      ]
    });

    expect(epicView(html)).not.toContain("<script>alert(1)");
    expect(epicView(html)).toContain("&lt;script&gt;");
  });
});
