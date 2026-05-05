# Hot-reload service config and workflow contracts

Symphonika will hot-reload both the orchestrator-owned service config and each repository-owned workflow contract. Project additions, removals, and configuration edits should not require restarting the daemon, while in-flight runs continue using the configuration snapshot they started with so run behavior remains explainable.

The bootstrap implementation uses defensive re-read semantics rather than filesystem watchers: every daemon tick and manual poll-now trigger attempts to reload `symphonika.yml` plus the referenced `WORKFLOW.md` files before polling and dispatch. Successful reloads replace the effective snapshot for future work. Invalid reloads are operator-visible in structured logs, CLI/API status, and the local status API, but do not discard the last known good effective snapshot.
