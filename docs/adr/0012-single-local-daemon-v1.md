# Single local daemon for v1

Symphonika v1 will run as a single local daemon process that polls Projects, prepares local workspaces, launches local agent providers, and serves the local operator UI/API. Remote workers and distributed execution remain future extensions so the first implementation can focus on the multi-project scheduler, GitHub issue integration, provider adapters, durable run store, and local observability.
