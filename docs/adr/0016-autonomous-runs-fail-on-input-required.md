# Autonomous runs fail on input required

Symphonika runs coding agents as autonomous full-permission workers. Workflow prompts should clearly tell agents that they are trusted to make reasonable implementation decisions and should not request operator input, but if a provider still emits an input-required signal, the orchestrator will fail the attempt, record a normalized `input_required` event, mark the issue with `sym:failed`, and preserve logs and workspace state for inspection.
