# No orchestrator PR detection in v1

Symphonika v1 will not inspect pull requests to decide issue eligibility. Repository workflows and coding agents are responsible for removing `agent-ready`, adding handoff labels, commenting, or closing issues when PR work is underway; the orchestrator remains label-based.
