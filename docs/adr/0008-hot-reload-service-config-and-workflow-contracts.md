# Hot-reload service config and workflow contracts

Symphonika will hot-reload both the orchestrator-owned service config and each repository-owned workflow contract. Project additions, removals, and configuration edits should not require restarting the daemon, while in-flight runs continue using the configuration snapshot they started with so run behavior remains explainable.
