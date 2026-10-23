import { describe, expect, it } from "vitest";

import { buildDependencyGraphElements } from "../../src/client/dependency-graph-elements.js";

describe("buildDependencyGraphElements", () => {
  it("builds one issue node with no edges for an issue with no blockers or parent", () => {
    const result = buildDependencyGraphElements([
      {
        blockedBy: [],
        blockedByTruncated: false,
        issueNumber: 101,
        owner: "pmatos",
        projectName: "alpha",
        repo: "symphonika",
        title: "Add graph view"
      }
    ]);

    expect(result).toEqual({
      edges: [],
      nodes: [
        {
          data: {
            id: "issue:pmatos/symphonika#101",
            issueNumber: 101,
            kind: "issue",
            label: "Add graph view",
            owner: "pmatos",
            projectName: "alpha",
            repo: "symphonika",
            state: "OPEN",
            title: "Add graph view"
          }
        }
      ]
    });
  });

  it("synthesizes an external node and an edge for a blocker not in the snapshot", () => {
    const result = buildDependencyGraphElements([
      {
        blockedBy: [
          {
            number: 42,
            owner: "pmatos",
            repo: "symphonika",
            state: "CLOSED",
            title: "Design the dependency model"
          }
        ],
        blockedByTruncated: false,
        issueNumber: 101,
        owner: "pmatos",
        projectName: "alpha",
        repo: "symphonika",
        title: "Add graph view"
      }
    ]);

    expect(result.nodes).toContainEqual({
      data: {
        id: "issue:pmatos/symphonika#42",
        issueNumber: 42,
        kind: "external",
        label: "pmatos/symphonika#42\nDesign the dependency model",
        owner: "pmatos",
        repo: "symphonika",
        state: "CLOSED",
        title: "Design the dependency model"
      }
    });
    expect(result.edges).toEqual([
      {
        data: {
          id: "issue:pmatos/symphonika#42->issue:pmatos/symphonika#101",
          source: "issue:pmatos/symphonika#42",
          target: "issue:pmatos/symphonika#101"
        }
      }
    ]);
  });

  it("links to the real node instead of synthesizing one when the blocker is itself in the snapshot", () => {
    const result = buildDependencyGraphElements([
      {
        blockedBy: [
          {
            number: 100,
            owner: "pmatos",
            repo: "symphonika",
            state: "OPEN",
            title: "Design the dependency model"
          }
        ],
        blockedByTruncated: false,
        issueNumber: 101,
        owner: "pmatos",
        projectName: "alpha",
        repo: "symphonika",
        title: "Add graph view"
      },
      {
        blockedBy: [],
        blockedByTruncated: false,
        issueNumber: 100,
        owner: "pmatos",
        projectName: "alpha",
        repo: "symphonika",
        title: "Design the dependency model"
      }
    ]);

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.every((node) => node.data.kind === "issue")).toBe(true);
    expect(result.edges).toEqual([
      {
        data: {
          id: "issue:pmatos/symphonika#100->issue:pmatos/symphonika#101",
          source: "issue:pmatos/symphonika#100",
          target: "issue:pmatos/symphonika#101"
        }
      }
    ]);
  });

  it("synthesizes a cross-repo external node using the blocker's own owner/repo", () => {
    const result = buildDependencyGraphElements([
      {
        blockedBy: [
          {
            number: 7,
            owner: "other-org",
            repo: "shared-lib",
            state: "OPEN",
            title: "Ship the upstream fix"
          }
        ],
        blockedByTruncated: false,
        issueNumber: 101,
        owner: "pmatos",
        projectName: "alpha",
        repo: "symphonika",
        title: "Add graph view"
      }
    ]);

    expect(result.nodes).toContainEqual({
      data: {
        id: "issue:other-org/shared-lib#7",
        issueNumber: 7,
        kind: "external",
        label: "other-org/shared-lib#7\nShip the upstream fix",
        owner: "other-org",
        repo: "shared-lib",
        state: "OPEN",
        title: "Ship the upstream fix"
      }
    });
  });

  it("clusters two children under one synthetic cluster node when their parent isn't in the snapshot", () => {
    const result = buildDependencyGraphElements([
      {
        blockedBy: [],
        blockedByTruncated: false,
        issueNumber: 101,
        owner: "pmatos",
        parentIssueNumber: 289,
        projectName: "alpha",
        repo: "symphonika",
        title: "Add graph view"
      },
      {
        blockedBy: [],
        blockedByTruncated: false,
        issueNumber: 102,
        owner: "pmatos",
        parentIssueNumber: 289,
        projectName: "alpha",
        repo: "symphonika",
        title: "Add gating"
      }
    ]);

    const clusterId = "issue:pmatos/symphonika#289";
    expect(result.nodes).toContainEqual({
      data: {
        id: clusterId,
        issueNumber: 289,
        kind: "cluster",
        label: "pmatos/symphonika#289\n(legacy ## Parent heading)",
        owner: "pmatos",
        parentSource: "legacy-heading",
        repo: "symphonika",
        title: "pmatos/symphonika#289"
      }
    });
    const child101 = result.nodes.find(
      (node) => node.data.id === "issue:pmatos/symphonika#101"
    );
    const child102 = result.nodes.find(
      (node) => node.data.id === "issue:pmatos/symphonika#102"
    );
    expect(child101?.data.parent).toBe(clusterId);
    expect(child102?.data.parent).toBe(clusterId);
    expect(
      result.nodes.filter((node) => node.data.kind === "cluster")
    ).toHaveLength(1);
  });

  it("nests a child under its parent's own node when the parent issue is itself in the snapshot", () => {
    const result = buildDependencyGraphElements([
      {
        blockedBy: [],
        blockedByTruncated: false,
        issueNumber: 289,
        owner: "pmatos",
        projectName: "alpha",
        repo: "symphonika",
        title: "Dependency epic"
      },
      {
        blockedBy: [],
        blockedByTruncated: false,
        issueNumber: 101,
        owner: "pmatos",
        parentIssueNumber: 289,
        projectName: "alpha",
        repo: "symphonika",
        title: "Add graph view"
      }
    ]);

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.every((node) => node.data.kind === "issue")).toBe(true);
    const child = result.nodes.find(
      (node) => node.data.id === "issue:pmatos/symphonika#101"
    );
    expect(child?.data.parent).toBe("issue:pmatos/symphonika#289");
  });

  it("leaves parent undefined for an issue with no parseable parent", () => {
    const result = buildDependencyGraphElements([
      {
        blockedBy: [],
        blockedByTruncated: false,
        issueNumber: 101,
        owner: "pmatos",
        projectName: "alpha",
        repo: "symphonika",
        title: "Add graph view"
      }
    ]);

    expect(result.nodes[0]?.data.parent).toBeUndefined();
  });

  it("links to the real node when the blocker's owner/repo differ only by case", () => {
    const result = buildDependencyGraphElements([
      {
        blockedBy: [
          {
            number: 100,
            owner: "PMatos",
            repo: "Symphonika",
            state: "OPEN",
            title: "Design the dependency model"
          }
        ],
        blockedByTruncated: false,
        issueNumber: 101,
        owner: "pmatos",
        projectName: "alpha",
        repo: "symphonika",
        title: "Add graph view"
      },
      {
        blockedBy: [],
        blockedByTruncated: false,
        issueNumber: 100,
        owner: "pmatos",
        projectName: "alpha",
        repo: "symphonika",
        title: "Design the dependency model"
      }
    ]);

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes.every((node) => node.data.kind === "issue")).toBe(true);
  });

  it("marks a node as truncated when the issue's blockedBy fetch was capped", () => {
    const result = buildDependencyGraphElements([
      {
        blockedBy: [],
        blockedByTruncated: true,
        issueNumber: 101,
        owner: "pmatos",
        projectName: "alpha",
        repo: "symphonika",
        title: "Add graph view"
      }
    ]);

    expect(result.nodes[0]?.data.truncated).toBe(true);
  });

  it("leaves truncated undefined for an issue whose fetch was not capped", () => {
    const result = buildDependencyGraphElements([
      {
        blockedBy: [],
        blockedByTruncated: false,
        issueNumber: 101,
        owner: "pmatos",
        projectName: "alpha",
        repo: "symphonika",
        title: "Add graph view"
      }
    ]);

    expect(result.nodes[0]?.data.truncated).toBeUndefined();
  });

  it("reuses the same synthetic node when an out-of-snapshot parent is also a blocker elsewhere", () => {
    const result = buildDependencyGraphElements([
      {
        blockedBy: [],
        blockedByTruncated: false,
        issueNumber: 101,
        owner: "pmatos",
        parentIssueNumber: 289,
        projectName: "alpha",
        repo: "symphonika",
        title: "Add graph view"
      },
      {
        blockedBy: [
          {
            number: 289,
            owner: "pmatos",
            repo: "symphonika",
            state: "CLOSED",
            title: "Dependency epic"
          }
        ],
        blockedByTruncated: false,
        issueNumber: 102,
        owner: "pmatos",
        projectName: "alpha",
        repo: "symphonika",
        title: "Add gating"
      }
    ]);

    const nodesFor289 = result.nodes.filter(
      (node) => node.data.owner === "pmatos" && node.data.issueNumber === 289
    );
    expect(nodesFor289).toHaveLength(1);
    const child101 = result.nodes.find(
      (node) => node.data.id === "issue:pmatos/symphonika#101"
    );
    expect(child101?.data.parent).toBe(nodesFor289[0]?.data.id);
    expect(result.edges).toContainEqual({
      data: {
        id: `${nodesFor289[0]?.data.id}->issue:pmatos/symphonika#102`,
        source: nodesFor289[0]?.data.id,
        target: "issue:pmatos/symphonika#102"
      }
    });
  });

  it("upgrades a parent placeholder to a full external node once the blocker pass reaches it", () => {
    const result = buildDependencyGraphElements([
      {
        blockedBy: [],
        blockedByTruncated: false,
        issueNumber: 101,
        owner: "pmatos",
        parentIssueNumber: 289,
        projectName: "alpha",
        repo: "symphonika",
        title: "Add graph view"
      },
      {
        blockedBy: [
          {
            number: 289,
            owner: "pmatos",
            repo: "symphonika",
            state: "CLOSED",
            title: "Dependency epic"
          }
        ],
        blockedByTruncated: false,
        issueNumber: 102,
        owner: "pmatos",
        projectName: "alpha",
        repo: "symphonika",
        title: "Add gating"
      }
    ]);

    const node289 = result.nodes.find(
      (node) => node.data.id === "issue:pmatos/symphonika#289"
    );
    expect(node289?.data.kind).toBe("external");
    expect(node289?.data.state).toBe("CLOSED");
    expect(node289?.data.title).toBe("Dependency epic");
    expect(node289?.data.label).toBe("pmatos/symphonika#289\nDependency epic");
  });

  it("never downgrades a real issue node when it's also referenced as a parent or blocker", () => {
    const result = buildDependencyGraphElements([
      {
        blockedBy: [
          {
            number: 289,
            owner: "pmatos",
            repo: "symphonika",
            state: "OPEN",
            title: "Stale blocker title"
          }
        ],
        blockedByTruncated: false,
        issueNumber: 101,
        owner: "pmatos",
        parentIssueNumber: 289,
        projectName: "alpha",
        repo: "symphonika",
        title: "Add graph view"
      },
      {
        blockedBy: [],
        blockedByTruncated: false,
        issueNumber: 289,
        owner: "pmatos",
        projectName: "alpha",
        repo: "symphonika",
        title: "Dependency epic"
      }
    ]);

    const node289 = result.nodes.find(
      (node) => node.data.id === "issue:pmatos/symphonika#289"
    );
    expect(node289?.data.kind).toBe("issue");
    expect(node289?.data.title).toBe("Dependency epic");
  });

  it("labels an external node with its owner/repo#N so it can't be mistaken for a local issue", () => {
    const result = buildDependencyGraphElements([
      {
        blockedBy: [
          {
            number: 7,
            owner: "other-org",
            repo: "shared-lib",
            state: "OPEN",
            title: "Ship the upstream fix"
          }
        ],
        blockedByTruncated: false,
        issueNumber: 101,
        owner: "pmatos",
        projectName: "alpha",
        repo: "symphonika",
        title: "Add graph view"
      }
    ]);

    const external = result.nodes.find(
      (node) => node.data.id === "issue:other-org/shared-lib#7"
    );
    expect(external?.data.label).toBe(
      "other-org/shared-lib#7\nShip the upstream fix"
    );
    expect(external?.data.title).toBe("Ship the upstream fix");
  });

  it("labels a real issue node with just its title", () => {
    const result = buildDependencyGraphElements([
      {
        blockedBy: [],
        blockedByTruncated: false,
        issueNumber: 101,
        owner: "pmatos",
        projectName: "alpha",
        repo: "symphonika",
        title: "Add graph view"
      }
    ]);

    expect(result.nodes[0]?.data.label).toBe("Add graph view");
  });

  describe("native parent evidence versus the ## Parent heading", () => {
    const child = {
      blockedBy: [],
      blockedByTruncated: false,
      issueNumber: 101,
      owner: "pmatos",
      projectName: "alpha",
      repo: "symphonika",
      title: "Add graph view"
    };
    const nativeParent = (number: number, overrides = {}) => ({
      availability: "present" as const,
      crossRepository: false,
      number,
      owner: "pmatos",
      repo: "symphonika",
      state: "OPEN" as const,
      title: `Epic ${number}`,
      ...overrides
    });
    const childNode = (
      result: ReturnType<typeof buildDependencyGraphElements>
    ) =>
      result.nodes.find(
        (node) => node.data.id === "issue:pmatos/symphonika#101"
      );

    it("clusters under the native parent when the heading names a different one", () => {
      const result = buildDependencyGraphElements([
        { ...child, nativeParent: nativeParent(300), parentIssueNumber: 289 }
      ]);

      expect(childNode(result)?.data.parent).toBe(
        "issue:pmatos/symphonika#300"
      );
      expect(childNode(result)?.data.parentSource).toBe("native");
      expect(result.nodes.some((node) => node.data.id.endsWith("#289"))).toBe(
        false
      );
      expect(
        result.nodes.find((node) => node.data.id.endsWith("#300"))?.data
      ).toMatchObject({
        kind: "cluster",
        label: "pmatos/symphonika#300\nEpic 300",
        state: "OPEN",
        title: "Epic 300"
      });
    });

    it("nests under the native parent's own node when it is in scope and the heading points elsewhere", () => {
      const result = buildDependencyGraphElements([
        { ...child, issueNumber: 300, title: "Real epic" },
        { ...child, issueNumber: 289, title: "Heading epic" },
        { ...child, nativeParent: nativeParent(300), parentIssueNumber: 289 }
      ]);

      expect(childNode(result)?.data.parent).toBe(
        "issue:pmatos/symphonika#300"
      );
      expect(result.nodes.every((node) => node.data.kind === "issue")).toBe(
        true
      );
    });

    it("does not let the heading create membership when native evidence says none", () => {
      const result = buildDependencyGraphElements([
        {
          ...child,
          nativeParent: { availability: "none" },
          parentIssueNumber: 289
        }
      ]);

      expect(result.nodes).toHaveLength(1);
      expect(childNode(result)?.data.parent).toBeUndefined();
      expect(childNode(result)?.data.parentSource).toBeUndefined();
    });

    it.each([
      ["unavailable", { availability: "unavailable" as const }],
      ["unrecorded", undefined]
    ])(
      "falls back to a labelled legacy heading cluster when native evidence is %s",
      (_name, nativeParentEvidence) => {
        const result = buildDependencyGraphElements([
          {
            ...child,
            ...(nativeParentEvidence === undefined
              ? {}
              : { nativeParent: nativeParentEvidence }),
            parentIssueNumber: 289
          }
        ]);

        expect(childNode(result)?.data.parent).toBe(
          "issue:pmatos/symphonika#289"
        );
        expect(childNode(result)?.data.parentSource).toBe("legacy-heading");
        const cluster = result.nodes.find((node) =>
          node.data.id.endsWith("#289")
        );
        expect(cluster?.data.kind).toBe("cluster");
        expect(cluster?.data.label).toContain("legacy ## Parent heading");
      }
    );

    it("uses the parent's own repository for a cross-repository native parent and a closed badge for a closed one", () => {
      const result = buildDependencyGraphElements([
        {
          ...child,
          nativeParent: nativeParent(7, {
            crossRepository: true,
            owner: "other-org",
            repo: "shared-lib",
            state: "CLOSED"
          }),
          parentIssueNumber: 7
        }
      ]);

      expect(childNode(result)?.data.parent).toBe(
        "issue:other-org/shared-lib#7"
      );
      expect(
        result.nodes.find((node) => node.data.id.endsWith("shared-lib#7"))?.data
      ).toMatchObject({
        owner: "other-org",
        repo: "shared-lib",
        state: "CLOSED"
      });
      expect(
        result.nodes.some(
          (node) => node.data.id === "issue:pmatos/symphonika#7"
        )
      ).toBe(false);
    });

    it("keeps the native cluster when a legacy-heading child shares the same parent", () => {
      const result = buildDependencyGraphElements([
        { ...child, issueNumber: 102, parentIssueNumber: 300 },
        { ...child, nativeParent: nativeParent(300) }
      ]);

      const cluster = result.nodes.find((node) =>
        node.data.id.endsWith("#300")
      );
      expect(cluster?.data.parentSource).toBe("native");
      expect(cluster?.data.label).toBe("pmatos/symphonika#300\nEpic 300");
      expect(
        result.nodes.find((node) => node.data.issueNumber === 102)?.data
          .parentSource
      ).toBe("legacy-heading");
    });

    it("never creates parentage from blockedBy, whatever the native evidence", () => {
      const blocker = {
        number: 289,
        owner: "pmatos",
        repo: "symphonika",
        state: "OPEN" as const,
        title: "Prerequisite"
      };
      for (const nativeParentEvidence of [
        { availability: "none" as const },
        { availability: "unavailable" as const },
        undefined
      ]) {
        const result = buildDependencyGraphElements([
          {
            ...child,
            blockedBy: [blocker],
            ...(nativeParentEvidence === undefined
              ? {}
              : { nativeParent: nativeParentEvidence })
          }
        ]);
        expect(childNode(result)?.data.parent).toBeUndefined();
        expect(result.edges).toHaveLength(1);
      }
    });
  });
});
