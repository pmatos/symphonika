// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import { WORKFLOW_GRAPH_CLIENT_JS } from "../src/http/pages.js";

describe("workflow graph client", () => {
  it("marks and labels the Run's current workflow state", () => {
    document.body.innerHTML = `
      <div id="wf-cy"></div>
      <div id="wf-detail"></div>
      <button id="wf-fit"></button>
      <button id="wf-relayout"></button>
    `;

    const graphWindow = window as unknown as Record<string, unknown>;
    graphWindow.__WORKFLOW_GRAPH__ = {
      initial: "implement",
      name: "self_driving",
      states: [
        {
          action: { kind: "agent" },
          completeWhen: {},
          id: "implement",
          transitions: [{ to: "wait_for_pr", when: {} }]
        },
        {
          action: { kind: "wait" },
          completeWhen: {},
          id: "wait_for_pr",
          transitions: []
        }
      ]
    };
    graphWindow.__WORKFLOW_CURRENT_STATE__ = "wait_for_pr";
    graphWindow.dagre = {};
    graphWindow.cytoscapeDagre = {};

    type CytoscapeOptions = {
      elements: Array<{
        classes: string;
        data: { id: string; label: string };
      }>;
      style: Array<{ selector: string }>;
    };
    const capturedOptions: CytoscapeOptions[] = [];
    const cytoscape = vi.fn((options: CytoscapeOptions) => {
      capturedOptions.push(options);
      return {
        fit: vi.fn(),
        layout: () => ({ run: vi.fn() }),
        on: vi.fn(),
        ready: (callback: () => void) => callback()
      };
    });
    Object.assign(cytoscape, { use: vi.fn() });
    graphWindow.cytoscape = cytoscape;

    // This executes the exact source embedded in /runs/:id/graph.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
    new Function(WORKFLOW_GRAPH_CLIENT_JS)();

    const options = capturedOptions[0];
    expect(options).toBeDefined();
    const currentNode = options?.elements.find(
      (element) => element.data.id === "wait_for_pr"
    );
    expect(currentNode?.classes).toContain("current");
    expect(currentNode?.data.id).toBe("wait_for_pr");
    expect(currentNode?.data.label).toBe("wait_for_pr\ncurrent");
    expect(options?.style).toContainEqual(
      expect.objectContaining({ selector: "node.current" })
    );
  });
});
