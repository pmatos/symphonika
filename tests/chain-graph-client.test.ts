// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHAIN_GRAPH_CLIENT_JS } from "../src/http/chain-graph-client.js";

type Element = {
  classes: string;
  data: { id: string; label: string; source?: string; target?: string };
};
type CytoscapeOptions = {
  elements: Element[];
  style: Array<{ selector: string }>;
};

const DATA = {
  current: { kind: "blocked", stateId: "done" },
  initial: "implement",
  missingStateIds: ["legacy"],
  name: "g",
  states: [
    {
      actionKind: "agent",
      id: "implement",
      terminal: null,
      transitions: [
        { to: "review_wait", when: "provider_success: true" },
        { to: "done", when: "otherwise" }
      ]
    },
    {
      actionKind: "wait",
      id: "review_wait",
      terminal: null,
      transitions: [{ to: "done", when: "checks: success" }]
    },
    { actionKind: null, id: "done", terminal: "success", transitions: [] },
    { actionKind: null, id: "idle", terminal: null, transitions: [] }
  ],
  traversed: [
    {
      declared: true,
      from: "implement",
      kind: "transition",
      to: "review_wait"
    },
    { declared: true, from: "review_wait", kind: "transition", to: "done" },
    { declared: false, from: "legacy", kind: "transition", to: "implement" }
  ],
  visits: [
    { anchors: ["chain-r-state-0"], stateId: "implement" },
    { anchors: ["chain-r-state-1"], stateId: "review_wait" },
    { anchors: ["chain-r-state-2", "chain-r-state-3"], stateId: "done" },
    { anchors: ["chain-r-state-4"], stateId: "legacy" }
  ]
};

const globals = window as unknown as Record<string, unknown>;

function mount(open: boolean): HTMLDetailsElement {
  document.body.innerHTML = `
    <details class="chain-graph-drilldown" data-chain-graph-root="r"${open ? " open" : ""}>
      <summary>Graph drill-down (optional)</summary>
      <div class="chain-graph" data-chain-graph hidden></div>
      <p data-chain-graph-status></p>
      <ul class="chain-graph-outline">
        ${DATA.states.map((s) => `<li><details data-state-id="${s.id}"><summary>${s.id}</summary></details></li>`).join("")}
      </ul>
      <script type="application/json" data-chain-graph-data>${JSON.stringify(DATA)}</script>
    </details>`;
  return document.querySelector("details.chain-graph-drilldown")!;
}

function run(): void {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
  new Function(CHAIN_GRAPH_CLIENT_JS)();
}

function stubCytoscape(): {
  captured: CytoscapeOptions[];
  handlers: Map<string, (evt: unknown) => void>;
  ctor: ReturnType<typeof vi.fn>;
} {
  const captured: CytoscapeOptions[] = [];
  const handlers = new Map<string, (evt: unknown) => void>();
  const ctor = vi.fn((options: CytoscapeOptions) => {
    captured.push(options);
    return {
      fit: vi.fn(),
      on: (event: string, selector: string, cb: (evt: unknown) => void) =>
        handlers.set(`${event}:${selector}`, cb),
      ready: (cb: () => void) => cb()
    };
  });
  Object.assign(ctor, { use: vi.fn() });
  globals.cytoscape = ctor;
  globals.dagre = {};
  globals.cytoscapeDagre = {};
  return { captured, ctor, handlers };
}

function open(details: HTMLDetailsElement): void {
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
}

beforeEach(() => {
  delete globals.cytoscape;
  delete globals.dagre;
  delete globals.cytoscapeDagre;
});

describe("chain graph client (#860)", () => {
  it("classes nodes and edges from the embedded evidence, styling the current node by timeline row kind", () => {
    const { captured } = stubCytoscape();
    const details = mount(true);
    run();

    expect(
      details.querySelector<HTMLElement>("[data-chain-graph]")?.hidden
    ).toBe(false);
    const els = captured[0]?.elements ?? [];
    const node = (id: string) => els.find((e) => e.data.id === id);
    expect(node("done")?.classes).toContain("current");
    expect(node("done")?.classes).toContain("cur-blocked");
    expect(node("done")?.classes).not.toContain("term-ok");
    expect(node("done")?.data.label).toBe("done\ncurrent");
    expect(node("implement")?.classes).toContain("visited");
    expect(node("idle")?.classes).not.toContain("visited");
    expect(node("legacy")?.classes).toContain("missing");

    const edge = (source: string, target: string) =>
      els.find((e) => e.data.source === source && e.data.target === target);
    expect(edge("implement", "review_wait")?.classes).toContain("traversed");
    expect(edge("review_wait", "done")?.classes).toContain("traversed");
    expect(edge("implement", "done")?.classes).not.toContain("traversed");
    expect(els.some((e) => e.data.source === "legacy")).toBe(false);
  });

  it("defers cytoscape until the closed drill-down is opened", () => {
    const { ctor } = stubCytoscape();
    const details = mount(false);
    run();
    expect(ctor).not.toHaveBeenCalled();

    open(details);
    expect(ctor).toHaveBeenCalledTimes(1);
    open(details);
    expect(ctor).toHaveBeenCalledTimes(1);
  });

  it("opens the matching outline entry, focuses it and links to the timeline rows on node tap", () => {
    const { handlers } = stubCytoscape();
    const details = mount(true);
    run();

    handlers.get("tap:node")?.({ target: { id: () => "done" } });

    const entry = details.querySelector<HTMLDetailsElement>(
      '[data-state-id="done"]'
    );
    expect(entry?.open).toBe(true);
    expect(document.activeElement).toBe(entry?.querySelector("summary"));
    const links = [
      ...details.querySelectorAll("[data-chain-graph-timeline-link]")
    ].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["#chain-r-state-2", "#chain-r-state-3"]);
  });

  it("says so when a selected node was never executed", () => {
    const { handlers } = stubCytoscape();
    const details = mount(true);
    run();

    handlers.get("tap:node")?.({ target: { id: () => "idle" } });

    expect(
      details.querySelector("[data-chain-graph-status]")?.textContent
    ).toContain("Not executed in this chain.");
  });

  it("leaves the outline usable and says the graph is unavailable when cytoscape is missing", () => {
    const details = mount(true);
    expect(() => run()).not.toThrow();

    expect(
      details.querySelector("[data-chain-graph-status]")?.textContent
    ).toContain("Interactive graph unavailable");
    expect(
      details.querySelector<HTMLElement>("[data-chain-graph]")?.hidden
    ).toBe(true);
    expect(
      details.querySelectorAll("ul.chain-graph-outline details")
    ).toHaveLength(4);
  });

  it("falls back the same way when constructing the diagram throws", () => {
    const { ctor } = stubCytoscape();
    ctor.mockImplementation(() => {
      throw new Error("no canvas");
    });
    const details = mount(true);
    expect(() => run()).not.toThrow();

    expect(ctor).toHaveBeenCalled();
    expect(
      details.querySelector("[data-chain-graph-status]")?.textContent
    ).toContain("Interactive graph unavailable");
    expect(
      details.querySelector<HTMLElement>("[data-chain-graph]")?.hidden
    ).toBe(true);
  });
});
