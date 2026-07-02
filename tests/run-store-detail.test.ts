import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import type { IssueSnapshot } from "../src/issue-polling.js";
import { openRunStore } from "../src/run-store.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-rsd-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

function sampleIssue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    body: "issue body",
    created_at: "2026-04-01T00:00:00Z",
    id: 1001,
    labels: ["agent-ready"],
    number: 42,
    priority: 99,
    state: "open",
    title: "Sample issue",
    updated_at: "2026-04-02T00:00:00Z",
    url: "https://example.invalid/issue/42",
    ...overrides
  };
}

describe("RunStore detail queries", () => {
  it("returns run evidence through value getters and artifact descriptors", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      const evidenceDir = path.join(stateRoot, "logs", "runs", "run-artifacts");
      await mkdir(evidenceDir, { recursive: true });
      const issueSnapshotPath = path.join(evidenceDir, "issue-snapshot.json");
      const metadataPath = path.join(evidenceDir, "prompt-metadata.json");
      const normalizedLogPath = path.join(
        evidenceDir,
        "provider.normalized.jsonl"
      );
      const promptPath = path.join(evidenceDir, "prompt.md");
      const rawLogPath = path.join(evidenceDir, "provider.raw.jsonl");
      const workflowGraphPath = path.join(evidenceDir, "workflow-graph.json");
      const issue = sampleIssue({ number: 99, title: "Artifact run" });
      const workflowGraph = {
        contentHash: "sha256:" + "a".repeat(64),
        initial: "run_agent",
        name: "single_agent_workflow",
        source: { kind: "markdown", path: "/repo/WORKFLOW.md" },
        states: [{ completeWhen: {}, id: "run_agent", transitions: [] }],
        templateFiles: []
      };

      await Promise.all([
        writeFile(issueSnapshotPath, `${JSON.stringify(issue)}\n`, "utf8"),
        writeFile(
          metadataPath,
          `${JSON.stringify({ run: { id: "run-artifacts" } })}\n`,
          "utf8"
        ),
        writeFile(
          normalizedLogPath,
          '{"type":"message","message":"hi"}\n',
          "utf8"
        ),
        writeFile(promptPath, "Rendered prompt\n", "utf8"),
        writeFile(rawLogPath, '{"raw":"event"}\n', "utf8"),
        writeFile(
          workflowGraphPath,
          `${JSON.stringify(workflowGraph)}\n`,
          "utf8"
        )
      ]);

      store.createRun({
        id: "run-artifacts",
        issue,
        projectName: "symphonika",
        providerCommand: "codex",
        providerName: "codex"
      });
      store.updateRunEvidence("run-artifacts", {
        branchName: "sym/symphonika/99-artifacts",
        branchRef: "refs/heads/sym/symphonika/99-artifacts",
        issueSnapshotPath,
        metadataPath,
        normalizedLogPath,
        promptPath,
        rawLogPath,
        workflowGraphPath,
        workspacePath: "/tmp/work"
      });

      const detail = store.getRun("run-artifacts");
      expect(detail).not.toHaveProperty("promptPath");
      expect(detail).not.toHaveProperty("rawLogPath");

      const artifacts = store.listRunArtifacts("run-artifacts");
      expect(
        artifacts.map((artifact) => ({
          kind: artifact.kind,
          present: artifact.present
        }))
      ).toEqual([
        { kind: "issue_snapshot", present: true },
        { kind: "prompt", present: true },
        { kind: "prompt_metadata", present: true },
        { kind: "workflow_graph", present: true },
        { kind: "provider_raw", present: true },
        { kind: "provider_normalized", present: true }
      ]);
      for (const artifact of artifacts) {
        expect(typeof artifact.sizeBytes).toBe("number");
      }
      await expect(
        store.getIssueSnapshot("run-artifacts")
      ).resolves.toMatchObject({
        number: 99,
        title: "Artifact run"
      });
      await expect(store.getRenderedPrompt("run-artifacts")).resolves.toBe(
        "Rendered prompt\n"
      );
      await expect(
        store.getPromptMetadata("run-artifacts")
      ).resolves.toMatchObject({
        run: { id: "run-artifacts" }
      });
      await expect(
        store.getWorkflowGraph("run-artifacts")
      ).resolves.toMatchObject({
        name: "single_agent_workflow"
      });
      await expect(
        store.getNormalizedEventLog("run-artifacts")
      ).resolves.toEqual([{ message: "hi", type: "message" }]);

      const rawProviderLog = await store.getRawProviderLog("run-artifacts");
      expect(rawProviderLog).toBeDefined();
      await expect(streamText(rawProviderLog)).resolves.toBe(
        '{"raw":"event"}\n'
      );

      const artifactStream = await store.openArtifactStream(
        "run-artifacts",
        "provider_raw"
      );
      await expect(streamText(artifactStream)).resolves.toBe(
        '{"raw":"event"}\n'
      );
    } finally {
      store.close();
    }
  });

  it("getRun returns the run with attempts and transitions", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.createRun({
        id: "run-A",
        issue: sampleIssue(),
        projectName: "symphonika",
        providerCommand: "codex --x",
        providerName: "codex"
      });
      store.updateRunState("run-A", "preparing_workspace");
      store.createAttempt({
        attemptNumber: 1,
        branchName: "sym/symphonika/42-sample",
        branchRef: "refs/heads/sym/symphonika/42-sample",
        id: "run-A-attempt-1",
        issueSnapshotPath: "/tmp/snap.json",
        metadataPath: "/tmp/meta.json",
        normalizedLogPath: "/tmp/normalized.jsonl",
        promptPath: "/tmp/prompt.md",
        providerCommand: "codex --x",
        providerName: "codex",
        rawLogPath: "/tmp/raw.jsonl",
        runId: "run-A",
        state: "running",
        workflowGraphPath: "",
        workspacePath: "/tmp/work"
      });
      store.updateRunState("run-A", "running");

      const detail = store.getRun("run-A");
      expect(detail).toBeDefined();
      expect(detail?.id).toBe("run-A");
      expect(detail?.issueTitle).toBe("Sample issue");
      expect(detail?.attempts).toHaveLength(1);
      expect(detail?.attempts[0]?.id).toBe("run-A-attempt-1");
      expect(detail?.attempts[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(detail?.attempts[0]?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(detail?.transitions.map((t) => t.state)).toEqual([
        "queued",
        "preparing_workspace",
        "running"
      ]);
    } finally {
      store.close();
    }
  });

  it("updateRunEvidence exposes workflow graph evidence as an artifact and value", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      const evidenceDir = path.join(stateRoot, "logs", "runs", "run-graph");
      await mkdir(evidenceDir, { recursive: true });
      const workflowGraphPath = path.join(evidenceDir, "workflow-graph.json");
      await writeFile(
        workflowGraphPath,
        JSON.stringify({
          contentHash: "sha256:" + "b".repeat(64),
          initial: "run_agent",
          name: "single_agent_workflow",
          source: { kind: "markdown", path: "/repo/WORKFLOW.md" },
          states: [],
          templateFiles: []
        })
      );
      store.createRun({
        id: "run-graph",
        issue: sampleIssue(),
        projectName: "symphonika",
        providerCommand: "codex",
        providerName: "codex"
      });
      store.updateRunEvidence("run-graph", {
        branchName: "sym/symphonika/42-graph",
        branchRef: "refs/heads/sym/symphonika/42-graph",
        issueSnapshotPath: "/tmp/snap.json",
        metadataPath: "/tmp/meta.json",
        normalizedLogPath: "/tmp/normalized.jsonl",
        promptPath: "/tmp/prompt.md",
        rawLogPath: "/tmp/raw.jsonl",
        workflowGraphPath,
        workspacePath: "/tmp/work"
      });

      const detail = store.getRun("run-graph");
      expect(detail).not.toHaveProperty("workflowGraphPath");
      const workflowGraphArtifact = store
        .listRunArtifacts("run-graph")
        .find((artifact) => artifact.kind === "workflow_graph");
      expect(workflowGraphArtifact?.present).toBe(true);
      expect(typeof workflowGraphArtifact?.sizeBytes).toBe("number");
      await expect(store.getWorkflowGraph("run-graph")).resolves.toMatchObject({
        name: "single_agent_workflow"
      });
    } finally {
      store.close();
    }
  });

  it("listAttempts does not expose per-attempt evidence paths", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.createRun({
        id: "run-attempts",
        issue: sampleIssue(),
        projectName: "symphonika",
        providerCommand: "codex",
        providerName: "codex"
      });
      const baseAttempt = {
        branchName: "sym/symphonika/42-attempts",
        branchRef: "refs/heads/sym/symphonika/42-attempts",
        issueSnapshotPath: "/tmp/snap.json",
        metadataPath: "/tmp/meta.json",
        normalizedLogPath: "/tmp/normalized.jsonl",
        promptPath: "/tmp/prompt.md",
        providerCommand: "codex",
        providerName: "codex" as const,
        rawLogPath: "/tmp/raw.jsonl",
        runId: "run-attempts",
        state: "running" as const,
        workspacePath: "/tmp/work"
      };
      store.createAttempt({
        ...baseAttempt,
        attemptNumber: 1,
        id: "run-attempts-attempt-1",
        workflowGraphPath: "/tmp/workflow-graph.json"
      });
      store.createAttempt({
        ...baseAttempt,
        attemptNumber: 2,
        id: "run-attempts-attempt-2",
        workflowGraphPath: "/tmp/workflow-graph.attempt-2.json"
      });

      const detail = store.getRun("run-attempts");
      expect(detail?.attempts).toHaveLength(2);
      expect(detail?.attempts[0]).not.toHaveProperty("workflowGraphPath");
      expect(detail?.attempts[1]).not.toHaveProperty("workflowGraphPath");
      const attemptKinds = (detail?.attempts[0]?.artifacts ?? []).map(
        (artifact) => artifact.kind
      );
      expect(attemptKinds).toEqual([
        "issue_snapshot",
        "prompt",
        "prompt_metadata",
        "workflow_graph",
        "provider_raw",
        "provider_normalized"
      ]);
      expect(detail?.attempts[1]?.artifacts).toEqual(
        detail?.attempts[0]?.artifacts.map((artifact) => ({
          kind: artifact.kind,
          present: false,
          sizeBytes: undefined
        }))
      );
    } finally {
      store.close();
    }
  });

  it("exposes prior attempts' workflow graphs after a retry overwrites the run-level path", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      const evidenceDir = path.join(stateRoot, "logs", "runs", "run-retry");
      await mkdir(evidenceDir, { recursive: true });
      const attempt1Graph = path.join(evidenceDir, "workflow-graph.json");
      const attempt2Graph = path.join(
        evidenceDir,
        "workflow-graph.attempt-2.json"
      );
      const attempt1Prompt = path.join(evidenceDir, "prompt.md");
      const attempt2Prompt = path.join(evidenceDir, "prompt.attempt-2.md");
      const attempt1Metadata = path.join(evidenceDir, "prompt-metadata.json");
      const attempt2Metadata = path.join(
        evidenceDir,
        "prompt-metadata.attempt-2.json"
      );
      const attempt1Snapshot = path.join(evidenceDir, "issue-snapshot.json");
      const attempt2Snapshot = path.join(
        evidenceDir,
        "issue-snapshot.attempt-2.json"
      );
      const attempt1Raw = path.join(evidenceDir, "provider.raw.jsonl");
      const attempt2Raw = path.join(
        evidenceDir,
        "provider.raw.attempt-2.jsonl"
      );
      const attempt1Normalized = path.join(
        evidenceDir,
        "provider.normalized.jsonl"
      );
      const attempt2Normalized = path.join(
        evidenceDir,
        "provider.normalized.attempt-2.jsonl"
      );
      const attempt1Workflow = {
        contentHash: "sha256:" + "a".repeat(64),
        initial: "run_agent",
        name: "attempt-1",
        source: { kind: "markdown", path: "/repo/WORKFLOW.md" },
        states: [{ completeWhen: {}, id: "run_agent", transitions: [] }],
        templateFiles: []
      };
      const attempt2Workflow = { ...attempt1Workflow, name: "attempt-2" };
      await Promise.all([
        writeFile(
          attempt1Graph,
          `${JSON.stringify(attempt1Workflow)}\n`,
          "utf8"
        ),
        writeFile(
          attempt2Graph,
          `${JSON.stringify(attempt2Workflow)}\n`,
          "utf8"
        ),
        writeFile(attempt1Prompt, "attempt 1 prompt\n", "utf8"),
        writeFile(attempt2Prompt, "attempt 2 prompt\n", "utf8"),
        writeFile(
          attempt1Metadata,
          `${JSON.stringify({ attempt: 1 })}\n`,
          "utf8"
        ),
        writeFile(
          attempt2Metadata,
          `${JSON.stringify({ attempt: 2 })}\n`,
          "utf8"
        ),
        writeFile(
          attempt1Snapshot,
          `${JSON.stringify({ number: 42, title: "attempt 1" })}\n`,
          "utf8"
        ),
        writeFile(
          attempt2Snapshot,
          `${JSON.stringify({ number: 42, title: "attempt 2" })}\n`,
          "utf8"
        ),
        writeFile(attempt1Raw, '{"raw":"a1"}\n', "utf8"),
        writeFile(attempt2Raw, '{"raw":"a2"}\n', "utf8"),
        writeFile(attempt1Normalized, '{"normalized":"a1"}\n', "utf8"),
        writeFile(attempt2Normalized, '{"normalized":"a2"}\n', "utf8")
      ]);

      const issue = sampleIssue();
      store.createRun({
        id: "run-retry",
        issue,
        projectName: "symphonika",
        providerCommand: "codex",
        providerName: "codex"
      });
      const baseAttempt = {
        branchName: "sym/symphonika/42-retry",
        branchRef: "refs/heads/sym/symphonika/42-retry",
        providerCommand: "codex",
        providerName: "codex" as const,
        runId: "run-retry",
        state: "running" as const,
        workspacePath: "/tmp/work"
      };
      store.createAttempt({
        ...baseAttempt,
        attemptNumber: 1,
        id: "run-retry-attempt-1",
        issueSnapshotPath: attempt1Snapshot,
        metadataPath: attempt1Metadata,
        normalizedLogPath: attempt1Normalized,
        promptPath: attempt1Prompt,
        rawLogPath: attempt1Raw,
        workflowGraphPath: attempt1Graph
      });
      store.createAttempt({
        ...baseAttempt,
        attemptNumber: 2,
        id: "run-retry-attempt-2",
        issueSnapshotPath: attempt2Snapshot,
        metadataPath: attempt2Metadata,
        normalizedLogPath: attempt2Normalized,
        promptPath: attempt2Prompt,
        rawLogPath: attempt2Raw,
        workflowGraphPath: attempt2Graph
      });
      store.updateRunEvidence("run-retry", {
        branchName: baseAttempt.branchName,
        branchRef: baseAttempt.branchRef,
        issueSnapshotPath: attempt2Snapshot,
        metadataPath: attempt2Metadata,
        normalizedLogPath: attempt2Normalized,
        promptPath: attempt2Prompt,
        rawLogPath: attempt2Raw,
        workflowGraphPath: attempt2Graph,
        workspacePath: baseAttempt.workspacePath
      });

      const descriptors1 = store.listAttemptArtifacts("run-retry-attempt-1");
      expect(descriptors1.map((descriptor) => descriptor.kind)).toEqual([
        "issue_snapshot",
        "prompt",
        "prompt_metadata",
        "workflow_graph",
        "provider_raw",
        "provider_normalized"
      ]);
      expect(descriptors1.every((descriptor) => descriptor.present)).toBe(true);
      expect(
        descriptors1.every((descriptor) => (descriptor.sizeBytes ?? 0) > 0)
      ).toBe(true);

      const stream1 = await store.openAttemptArtifactStream(
        "run-retry-attempt-1",
        "workflow_graph"
      );
      expect(stream1).toBeDefined();
      const contents1 = await streamText(stream1);
      expect(JSON.parse(contents1)).toMatchObject({ name: "attempt-1" });
      const prompt1 = await store.openAttemptArtifactStream(
        "run-retry-attempt-1",
        "prompt"
      );
      expect(prompt1).toBeDefined();
      await expect(streamText(prompt1)).resolves.toBe("attempt 1 prompt\n");
      const metadata1 = await store.openAttemptArtifactStream(
        "run-retry-attempt-1",
        "prompt_metadata"
      );
      expect(metadata1).toBeDefined();
      await expect(streamText(metadata1)).resolves.toBe('{"attempt":1}\n');
      const snapshot1 = await store.openAttemptArtifactStream(
        "run-retry-attempt-1",
        "issue_snapshot"
      );
      expect(snapshot1).toBeDefined();
      await expect(streamText(snapshot1)).resolves.toBe(
        '{"number":42,"title":"attempt 1"}\n'
      );

      const stream2 = await store.openAttemptArtifactStream(
        "run-retry-attempt-2",
        "workflow_graph"
      );
      const contents2 = await streamText(stream2);
      expect(JSON.parse(contents2)).toMatchObject({ name: "attempt-2" });

      expect(
        await store.openAttemptArtifactStream(
          "missing-attempt",
          "workflow_graph"
        )
      ).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("reports missing workflow graph evidence through descriptors and getters", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.createRun({
        id: "run-legacy",
        issue: sampleIssue(),
        projectName: "symphonika",
        providerCommand: "codex",
        providerName: "codex"
      });
      const detail = store.getRun("run-legacy");
      expect(detail).not.toHaveProperty("workflowGraphPath");
      expect(store.listRunArtifacts("run-legacy")).toContainEqual({
        kind: "workflow_graph",
        present: false,
        sizeBytes: undefined
      });
      await expect(
        store.getWorkflowGraph("run-legacy")
      ).resolves.toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("getRun returns undefined for unknown id", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      expect(store.getRun("missing")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("listRuns filters by state, project, and issueNumber", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.createRun({
        id: "r-1",
        issue: sampleIssue({ number: 1 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      store.updateRunState("r-1", "running");
      store.createRun({
        id: "r-2",
        issue: sampleIssue({ number: 2 }),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      store.updateRunState("r-2", "failed");
      store.createRun({
        id: "r-3",
        issue: sampleIssue({ number: 3 }),
        projectName: "beta",
        providerCommand: "x",
        providerName: "claude"
      });
      store.updateRunState("r-3", "failed");

      expect(
        store.listRuns({ project: "alpha", state: "failed" }).map((r) => r.id)
      ).toEqual(["r-2"]);
      expect(
        store
          .listRuns({ state: "failed" })
          .map((r) => r.id)
          .sort()
      ).toEqual(["r-2", "r-3"]);
      expect(store.listRuns({ issueNumber: 1 }).map((r) => r.id)).toEqual([
        "r-1"
      ]);
    } finally {
      store.close();
    }
  });

  it("listProviderEvents respects limit and afterSequence", async () => {
    const stateRoot = await makeTempRoot();
    const store = openRunStore({ stateRoot });
    try {
      store.createRun({
        id: "r-events",
        issue: sampleIssue(),
        projectName: "alpha",
        providerCommand: "x",
        providerName: "codex"
      });
      store.createAttempt({
        attemptNumber: 1,
        branchName: "branch",
        branchRef: "refs/heads/branch",
        id: "r-events-attempt-1",
        issueSnapshotPath: "/tmp/snap.json",
        metadataPath: "/tmp/meta.json",
        normalizedLogPath: "/tmp/normalized.jsonl",
        promptPath: "/tmp/prompt.md",
        providerCommand: "x",
        providerName: "codex",
        rawLogPath: "/tmp/raw.jsonl",
        runId: "r-events",
        state: "running",
        workflowGraphPath: "",
        workspacePath: "/tmp/work"
      });
      store.createAttempt({
        attemptNumber: 2,
        branchName: "branch",
        branchRef: "refs/heads/branch",
        id: "r-events-attempt-2",
        issueSnapshotPath: "/tmp/snap-2.json",
        metadataPath: "/tmp/meta-2.json",
        normalizedLogPath: "/tmp/normalized-2.jsonl",
        promptPath: "/tmp/prompt-2.md",
        providerCommand: "x",
        providerName: "codex",
        rawLogPath: "/tmp/raw-2.jsonl",
        runId: "r-events",
        state: "running",
        workflowGraphPath: "",
        workspacePath: "/tmp/work"
      });
      for (let i = 1; i <= 5; i += 1) {
        store.recordProviderEvent({
          attemptId: "r-events-attempt-1",
          normalized: { type: "message", message: `m${i}` },
          raw: { kind: "message", body: `m${i}` },
          runId: "r-events",
          sequence: i
        });
      }
      store.recordProviderEvent({
        attemptId: "r-events-attempt-2",
        normalized: { type: "message", message: "retry started" },
        raw: { kind: "message", body: "retry started" },
        runId: "r-events",
        sequence: 1
      });

      expect(
        store.listProviderEvents("r-events").map((e) => e.sequence)
      ).toEqual([1, 1, 2, 3, 4, 5]);
      expect(
        store
          .listProviderEvents("r-events", { limit: 2 })
          .map((e) => e.sequence)
      ).toEqual([1, 1]);
      expect(
        store
          .listProviderEvents("r-events", { afterSequence: 3 })
          .map((e) => e.sequence)
      ).toEqual([4, 5]);
      expect(
        store
          .listProviderEvents("r-events", { limit: 1, order: "desc" })
          .map((e) => [e.attemptId, e.sequence])
      ).toEqual([["r-events-attempt-2", 1]]);
    } finally {
      store.close();
    }
  });
});

async function streamText(
  stream: NodeJS.ReadableStream | undefined
): Promise<string> {
  if (stream === undefined) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from(stream)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
