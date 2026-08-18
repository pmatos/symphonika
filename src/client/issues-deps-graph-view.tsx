import cytoscape from "cytoscape";
import { useEffect, useRef, useState } from "react";

import {
  buildDependencyGraphElements,
  type DependencyGraphIssue,
  type DependencyGraphNode
} from "./dependency-graph-elements.js";

declare global {
  interface Window {
    __ISSUE_DEPS_GRAPH__?: { issues: DependencyGraphIssue[] };
  }
}

const NODE_STYLE: cytoscape.StylesheetJsonBlock[] = [
  {
    selector: "node",
    style: {
      "background-color": "#ffffff",
      "border-color": "#94a3b8",
      "border-width": 1.5,
      color: "#0f172a",
      label: "data(label)",
      "text-valign": "center",
      "text-wrap": "wrap"
    }
  },
  {
    selector: "node[kind='external']",
    style: { "background-color": "#fff7ed", "border-color": "#fb923c" }
  },
  {
    selector: "node[kind='cluster']",
    style: { "background-color": "#f8fafc", "border-color": "#cbd5e1" }
  },
  {
    selector: "node[?truncated]",
    style: {
      "border-color": "#f59e0b",
      "border-style": "dashed",
      "border-width": 2.5
    }
  },
  {
    selector: "edge",
    style: {
      "curve-style": "bezier",
      "line-color": "#9aa6b8",
      "target-arrow-color": "#9aa6b8",
      "target-arrow-shape": "triangle"
    }
  }
];

function hideFallback(): void {
  const fallback = document.getElementById("issues-deps-graph-fallback");
  if (fallback !== null) {
    fallback.style.display = "none";
  }
}

// ADR-0056's graceful-degradation guardrail, adapted for a bundled (not
// CDN) library: the server always renders a plain fallback list, and we
// only hide it once cytoscape has actually mounted without throwing --
// a script that fails to load can never reach this component at all, and
// a runtime error here leaves the fallback as the only thing the operator
// sees, rather than a blank canvas.
export function IssuesDepsGraphView() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [selected, setSelected] = useState<DependencyGraphNode["data"] | null>(
    null
  );
  const issues = window.__ISSUE_DEPS_GRAPH__?.issues ?? [];

  useEffect(() => {
    const container = containerRef.current;
    if (container === null || issues.length === 0) {
      return;
    }
    try {
      const { edges, nodes } = buildDependencyGraphElements(issues);
      const cy = cytoscape({
        container,
        elements: [...nodes, ...edges],
        layout: { name: "cose" },
        style: NODE_STYLE
      });
      cy.on("tap", "node", (event) => {
        const node = event.target as cytoscape.NodeSingular;
        setSelected(node.data() as DependencyGraphNode["data"]);
      });
      hideFallback();
      return () => {
        cy.destroy();
      };
    } catch {
      return undefined;
    }
  }, [issues]);

  if (issues.length === 0) {
    return null;
  }

  return (
    <div className="deps-graph-wrap">
      <div className="deps-graph-canvas" ref={containerRef} />
      <aside className="deps-graph-detail">
        {selected === null ? (
          <p>Click a node for details.</p>
        ) : (
          <dl>
            <dt>Issue</dt>
            <dd>
              {selected.kind === "issue" &&
              selected.projectName !== undefined ? (
                <a
                  href={`/issues/${encodeURIComponent(selected.projectName)}/${selected.issueNumber}`}
                >
                  #{selected.issueNumber}
                </a>
              ) : (
                <span>
                  {selected.owner}/{selected.repo}#{selected.issueNumber}
                </span>
              )}
            </dd>
            <dt>Title</dt>
            <dd>{selected.title}</dd>
            {selected.state === undefined ? null : (
              <>
                <dt>State</dt>
                <dd>{selected.state}</dd>
              </>
            )}
            {selected.truncated === true ? (
              <dd className="deps-graph-warning">
                ⚠ this issue has more dependency links than could be checked —
                the list shown here may be incomplete.
              </dd>
            ) : null}
          </dl>
        )}
      </aside>
    </div>
  );
}
