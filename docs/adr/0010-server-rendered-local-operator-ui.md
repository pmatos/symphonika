# Server-rendered local operator UI

Symphonika will start with a local HTTP API and lightweight server-rendered operator pages rather than a separate frontend application. This keeps the v1 observability surface easy for coding agents to inspect and debug while the run model, event model, and provider adapters are still stabilizing.

Amended by ADR-0056: the "separate frontend application" this ADR rules out means a standalone single-page app with its own build and routing, not client-side enhancement within a server-rendered page. A server-rendered operator page may embed a self-contained, read-only interactive visualization (e.g. the workflow-graph view) that degrades gracefully when its external visualization dependencies are unavailable.
