# No provider-specific GitHub tools in v1

Symphonika v1 will not expose a provider-specific GitHub tool layer to coding agents. The orchestrator uses the GitHub API for polling, reconciliation, and operational labels, while workflow writes such as comments, pushes, pull requests, and handoff labels are performed by the agent through the repository's normal local tools and credentials.
