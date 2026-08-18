// @vitest-environment happy-dom
import { act, render, screen } from "@testing-library/react";
import cytoscape from "cytoscape";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IssuesDepsGraphView } from "../../src/client/issues-deps-graph-view.js";

type CytoscapeFactory = (
  options?: cytoscape.CytoscapeOptions
) => cytoscape.Core;

vi.mock("cytoscape", () => ({ default: vi.fn() }));

const mockedCytoscape = vi.mocked(cytoscape as unknown as CytoscapeFactory);

function renderWithFallback(): void {
  document.body.innerHTML = `
    <div id="issues-deps-graph-fallback"><ul><li>#101 blocked by #42</li></ul></div>
    <div id="issues-deps-graph-root"></div>
  `;
  render(<IssuesDepsGraphView />, {
    container: document.getElementById("issues-deps-graph-root") ?? undefined
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
  mockedCytoscape.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.__ISSUE_DEPS_GRAPH__;
});

describe("IssuesDepsGraphView", () => {
  it("renders nothing and leaves the fallback list visible when there is no graph data", () => {
    renderWithFallback();
    expect(cytoscape).not.toHaveBeenCalled();
    const fallback = document.getElementById("issues-deps-graph-fallback");
    expect(fallback?.style.display).not.toBe("none");
  });

  it("mounts a cytoscape graph and hides the fallback list once it renders successfully", () => {
    window.__ISSUE_DEPS_GRAPH__ = {
      issues: [
        {
          blockedBy: [],
          blockedByTruncated: false,
          issueNumber: 101,
          owner: "pmatos",
          projectName: "alpha",
          repo: "symphonika",
          title: "Add graph view"
        }
      ]
    };
    mockedCytoscape.mockReturnValue({
      destroy: vi.fn(),
      on: vi.fn()
    } as unknown as cytoscape.Core);

    renderWithFallback();

    expect(cytoscape).toHaveBeenCalledTimes(1);
    const fallback = document.getElementById("issues-deps-graph-fallback");
    expect(fallback?.style.display).toBe("none");
  });

  it("leaves the fallback list visible when cytoscape throws during render", () => {
    window.__ISSUE_DEPS_GRAPH__ = {
      issues: [
        {
          blockedBy: [],
          blockedByTruncated: false,
          issueNumber: 101,
          owner: "pmatos",
          projectName: "alpha",
          repo: "symphonika",
          title: "Add graph view"
        }
      ]
    };
    mockedCytoscape.mockImplementation(() => {
      throw new Error("boom");
    });

    renderWithFallback();

    const fallback = document.getElementById("issues-deps-graph-fallback");
    expect(fallback?.style.display).not.toBe("none");
  });

  it("shows issue details, including a link into the issue page, when a node is clicked", () => {
    window.__ISSUE_DEPS_GRAPH__ = {
      issues: [
        {
          blockedBy: [],
          blockedByTruncated: false,
          issueNumber: 101,
          owner: "pmatos",
          projectName: "alpha",
          repo: "symphonika",
          title: "Add graph view"
        }
      ]
    };
    let tapHandler: ((event: unknown) => void) | undefined;
    mockedCytoscape.mockReturnValue({
      destroy: vi.fn(),
      on: vi.fn(
        (
          eventName: string,
          _selector: string,
          handler: (event: unknown) => void
        ) => {
          if (eventName === "tap") {
            tapHandler = handler;
          }
        }
      )
    } as unknown as cytoscape.Core);

    renderWithFallback();

    expect(tapHandler).toBeDefined();
    act(() => {
      tapHandler?.({
        target: {
          data: () => ({
            id: "issue:pmatos/symphonika#101",
            issueNumber: 101,
            kind: "issue",
            owner: "pmatos",
            projectName: "alpha",
            repo: "symphonika",
            title: "Add graph view"
          })
        }
      });
    });

    expect(screen.getByText("Add graph view")).toBeDefined();
    const link = screen.getByRole("link", { name: /#101/ });
    expect(link.getAttribute("href")).toBe("/issues/alpha/101");
  });

  it("URL-encodes a project name containing reserved characters in the issue link", () => {
    window.__ISSUE_DEPS_GRAPH__ = {
      issues: [
        {
          blockedBy: [],
          blockedByTruncated: false,
          issueNumber: 101,
          owner: "pmatos",
          projectName: "team a/b",
          repo: "symphonika",
          title: "Add graph view"
        }
      ]
    };
    let tapHandler: ((event: unknown) => void) | undefined;
    mockedCytoscape.mockReturnValue({
      destroy: vi.fn(),
      on: vi.fn(
        (
          eventName: string,
          _selector: string,
          handler: (event: unknown) => void
        ) => {
          if (eventName === "tap") {
            tapHandler = handler;
          }
        }
      )
    } as unknown as cytoscape.Core);

    renderWithFallback();

    act(() => {
      tapHandler?.({
        target: {
          data: () => ({
            id: "issue:pmatos/symphonika#101",
            issueNumber: 101,
            kind: "issue",
            owner: "pmatos",
            projectName: "team a/b",
            repo: "symphonika",
            title: "Add graph view"
          })
        }
      });
    });

    const link = screen.getByRole("link", { name: /#101/ });
    expect(link.getAttribute("href")).toBe("/issues/team%20a%2Fb/101");
  });

  it("warns in the detail panel when the selected node's dependency fetch was truncated", () => {
    window.__ISSUE_DEPS_GRAPH__ = {
      issues: [
        {
          blockedBy: [],
          blockedByTruncated: true,
          issueNumber: 101,
          owner: "pmatos",
          projectName: "alpha",
          repo: "symphonika",
          title: "Add graph view"
        }
      ]
    };
    let tapHandler: ((event: unknown) => void) | undefined;
    mockedCytoscape.mockReturnValue({
      destroy: vi.fn(),
      on: vi.fn(
        (
          eventName: string,
          _selector: string,
          handler: (event: unknown) => void
        ) => {
          if (eventName === "tap") {
            tapHandler = handler;
          }
        }
      )
    } as unknown as cytoscape.Core);

    renderWithFallback();

    act(() => {
      tapHandler?.({
        target: {
          data: () => ({
            id: "issue:pmatos/symphonika#101",
            issueNumber: 101,
            kind: "issue",
            owner: "pmatos",
            projectName: "alpha",
            repo: "symphonika",
            title: "Add graph view",
            truncated: true
          })
        }
      });
    });

    expect(screen.getByText(/may be incomplete/i)).toBeDefined();
  });

  it("selects and centers the focusIssue node once the layout settles", () => {
    window.__ISSUE_DEPS_GRAPH__ = {
      focusIssue: { issueNumber: 101, owner: "pmatos", repo: "symphonika" },
      issues: [
        {
          blockedBy: [],
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
          issueNumber: 102,
          owner: "pmatos",
          projectName: "alpha",
          repo: "symphonika",
          title: "Add gating"
        }
      ]
    };
    let layoutstopHandler: (() => void) | undefined;
    const centerMock = vi.fn();
    const selectMock = vi.fn();
    const focusNodeData = {
      id: "issue:pmatos/symphonika#101",
      issueNumber: 101,
      kind: "issue",
      label: "Add graph view",
      owner: "pmatos",
      projectName: "alpha",
      repo: "symphonika",
      title: "Add graph view"
    };
    mockedCytoscape.mockReturnValue({
      $id: vi.fn(() => ({
        data: () => focusNodeData,
        length: 1,
        select: selectMock
      })),
      center: centerMock,
      destroy: vi.fn(),
      on: vi.fn(),
      one: vi.fn((eventName: string, handler: () => void) => {
        if (eventName === "layoutstop") {
          layoutstopHandler = handler;
        }
      })
    } as unknown as cytoscape.Core);

    renderWithFallback();

    expect(layoutstopHandler).toBeDefined();
    act(() => {
      layoutstopHandler?.();
    });

    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(centerMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Add graph view")).toBeDefined();
  });

  it("does nothing when the focusIssue node isn't in the graph", () => {
    window.__ISSUE_DEPS_GRAPH__ = {
      focusIssue: { issueNumber: 999, owner: "pmatos", repo: "symphonika" },
      issues: [
        {
          blockedBy: [],
          blockedByTruncated: false,
          issueNumber: 101,
          owner: "pmatos",
          projectName: "alpha",
          repo: "symphonika",
          title: "Add graph view"
        }
      ]
    };
    let layoutstopHandler: (() => void) | undefined;
    const centerMock = vi.fn();
    mockedCytoscape.mockReturnValue({
      $id: vi.fn(() => ({ data: () => undefined, length: 0, select: vi.fn() })),
      center: centerMock,
      destroy: vi.fn(),
      on: vi.fn(),
      one: vi.fn((eventName: string, handler: () => void) => {
        if (eventName === "layoutstop") {
          layoutstopHandler = handler;
        }
      })
    } as unknown as cytoscape.Core);

    renderWithFallback();

    act(() => {
      layoutstopHandler?.();
    });

    expect(centerMock).not.toHaveBeenCalled();
    expect(screen.getByText("Click a node for details.")).toBeDefined();
  });
});
