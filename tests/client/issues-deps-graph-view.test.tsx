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
});
