// #860: progressive enhancement for the Issue page's graph drill-down. The
// server already renders every state, transition, provider and timeline link
// as a <details> outline; this script only adds an optional diagram on top
// and must never be the sole carrier of any status or control (ADR 0056).
export const CHAIN_GRAPH_CLIENT_JS = `(function () {
  var UNAVAILABLE = "Interactive graph unavailable; use the state list below.";
  var AVAILABLE = "The diagram is a visual aid. The state list is the keyboard-accessible version; selecting a node opens its entry there.";

  var mounts = document.querySelectorAll("details.chain-graph-drilldown[data-chain-graph-root]");
  Array.prototype.forEach.call(mounts, initMount);

  function initMount(details) {
    var dataEl = details.querySelector("script[data-chain-graph-data]");
    var canvas = details.querySelector("[data-chain-graph]");
    var statusEl = details.querySelector("[data-chain-graph-status]");
    if (!dataEl || !canvas || !statusEl) return;
    var data;
    try { data = JSON.parse(dataEl.textContent || ""); } catch (e) { return; }
    var started = false;

    function start() {
      if (started) return;
      started = true;
      render(details, canvas, statusEl, data);
    }
    details.addEventListener("toggle", function (evt) {
      if (evt.target === details && details.open) start();
    });
    if (details.open) start();
  }

  function unavailable(canvas, statusEl) {
    canvas.hidden = true;
    statusEl.textContent = UNAVAILABLE;
  }

  function render(details, canvas, statusEl, data) {
    if (typeof window.cytoscape === "undefined" || typeof window.dagre === "undefined" || typeof window.cytoscapeDagre === "undefined") {
      unavailable(canvas, statusEl);
      return;
    }
    var states = Array.isArray(data.states) ? data.states : [];
    var current = data.current || {};
    var visited = {};
    (data.visits || []).forEach(function (v) { visited[v.stateId] = v.anchors || []; });
    var real = {};
    states.forEach(function (s) { real[s.id] = true; });
    var missing = {};
    (data.missingStateIds || []).forEach(function (id) { missing[id] = true; });
    var traversed = {};
    (data.traversed || []).forEach(function (t) {
      if (t.declared) traversed[t.from + "\\u0000" + t.to] = t.kind;
    });

    function nodeClasses(st) {
      var cls = [];
      if (Object.prototype.hasOwnProperty.call(visited, st.id)) cls.push("visited");
      if (st.id === current.stateId) {
        cls.push("current");
        cls.push("cur-" + current.kind);
        if (current.kind === "terminal") cls.push(st.terminal === "success" ? "term-ok" : "term-block");
      } else if (st.terminal === "success") cls.push("term-ok");
      else if (st.terminal) cls.push("term-block");
      else if (st.actionKind) cls.push("act-" + st.actionKind);
      if (st.id === data.initial) cls.push("initial");
      return cls.join(" ");
    }

    var elements = [];
    states.forEach(function (st) {
      elements.push({ data: { id: st.id, label: st.id === current.stateId ? st.id + "\\ncurrent" : st.id }, classes: nodeClasses(st) });
    });
    Object.keys(missing).forEach(function (id) {
      var cls = "missing visited" + (id === current.stateId ? " current cur-" + current.kind : "");
      elements.push({ data: { id: id, label: id + "\\n(not in graph)" }, classes: cls });
    });
    states.forEach(function (st) {
      (st.transitions || []).forEach(function (tr, i) {
        var target = tr.to;
        if (!real[target] && !missing[target]) {
          target = "__undeclared__" + tr.to;
          if (!missing[target]) {
            missing[target] = true;
            elements.push({ data: { id: target, label: tr.to }, classes: "missing" });
          }
        }
        var kind = traversed[st.id + "\\u0000" + tr.to];
        elements.push({
          data: { id: st.id + "->" + tr.to + "#" + i, source: st.id, target: target, label: tr.when },
          classes: kind === "transition" ? "traversed" : kind === "handoff_pending" ? "traversed handoff" : ""
        });
      });
    });

    canvas.hidden = false;
    var cy;
    try {
      window.cytoscape.use(window.cytoscapeDagre);
    } catch (e) {}
    try {
      cy = window.cytoscape({
        container: canvas,
        elements: elements,
        wheelSensitivity: 0.2,
        style: [
          { selector: "node", style: { "label": "data(label)", "text-valign": "center", "text-halign": "center", "font-size": 12, "font-weight": 600, "color": "#0f172a", "shape": "round-rectangle", "width": "label", "height": "label", "padding": "10px", "border-width": 1.5, "border-color": "#94a3b8", "background-color": "#ffffff", "text-wrap": "wrap", "text-max-width": 160, "opacity": 0.6 } },
          { selector: "node.act-agent", style: { "background-color": "#eff6ff", "border-color": "#60a5fa" } },
          { selector: "node.act-wait", style: { "background-color": "#f1f5f9", "border-style": "dashed" } },
          { selector: "node.act-merge_pr", style: { "background-color": "#f5f3ff", "border-color": "#8b5cf6" } },
          { selector: "node.term-ok", style: { "background-color": "#dcfce7", "border-color": "#22c55e" } },
          { selector: "node.term-block", style: { "background-color": "#fee2e2", "border-color": "#ef4444" } },
          { selector: "node.missing", style: { "background-color": "#fff7ed", "border-color": "#fb923c", "border-style": "dotted" } },
          { selector: "node.visited", style: { "opacity": 1, "border-width": 2.5 } },
          { selector: "node.current", style: { "opacity": 1, "border-width": 5, "border-color": "#0e7490", "underlay-color": "#06b6d4", "underlay-opacity": 0.16, "underlay-padding": 8 } },
          { selector: "node.cur-blocked, node.cur-input_required, node.cur-pending_handoff", style: { "background-color": "#fee2e2", "border-color": "#b91c1c" } },
          { selector: "node.cur-current_running, node.cur-current_waiting", style: { "background-color": "#ecfeff" } },
          { selector: "node.cur-not_recorded", style: { "background-color": "#f1f5f9", "border-style": "dotted" } },
          { selector: "edge", style: { "width": 1.4, "line-color": "#cbd5e1", "target-arrow-color": "#cbd5e1", "target-arrow-shape": "triangle", "curve-style": "bezier", "label": "data(label)", "font-size": 9, "color": "#64748b", "text-wrap": "wrap", "text-max-width": 140, "text-background-color": "#ffffff", "text-background-opacity": 1, "text-background-padding": 2 } },
          { selector: "edge.traversed", style: { "width": 3, "line-color": "#2563eb", "target-arrow-color": "#2563eb", "color": "#1e3a8a" } },
          { selector: "edge.handoff", style: { "line-style": "dashed" } }
        ],
        layout: { name: "dagre", rankDir: "TB", nodeSep: 50, rankSep: 90, padding: 20 }
      });
    } catch (e) {
      unavailable(canvas, statusEl);
      return;
    }
    statusEl.textContent = AVAILABLE;
    canvas.setAttribute("aria-hidden", "true");

    cy.on("tap", "node", function (evt) { select(details, statusEl, visited, evt.target.id()); });
    cy.ready(function () { cy.fit(undefined, 20); });
  }

  function select(details, statusEl, visited, stateId) {
    var entries = details.querySelectorAll("ul.chain-graph-outline details[data-state-id]");
    var entry;
    Array.prototype.forEach.call(entries, function (el) {
      if (el.getAttribute("data-state-id") === stateId) entry = el;
    });
    if (entry) {
      entry.open = true;
      var summary = entry.querySelector("summary");
      if (summary) summary.focus();
    }
    var anchors = Object.prototype.hasOwnProperty.call(visited, stateId) ? visited[stateId] : [];
    statusEl.textContent = AVAILABLE + " Selected: " + stateId + ". ";
    if (anchors.length === 0) {
      statusEl.appendChild(document.createTextNode("Not executed in this chain."));
      return;
    }
    anchors.forEach(function (anchor, i) {
      var link = document.createElement("a");
      link.setAttribute("href", "#" + anchor);
      link.setAttribute("data-chain-graph-timeline-link", "");
      link.textContent = anchors.length === 1 ? "View in timeline" : "View visit " + (i + 1) + " in timeline";
      if (i > 0) statusEl.appendChild(document.createTextNode(" · "));
      statusEl.appendChild(link);
    });
  }
})();`;
