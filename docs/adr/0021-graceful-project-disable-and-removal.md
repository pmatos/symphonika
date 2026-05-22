# Graceful project disable and removal

Disabling a Project stops new dispatch immediately but lets existing runs continue by default. Removing a Project from service config marks it inactive rather than killing active full-permission agents; operators can explicitly cancel runs through the CLI or UI when interruption is required.

Routine declarations are configuration-derived Project children, not the historical evidence itself. When a Project is omitted from the current valid service-config snapshot, its routine rows are marked inactive and pruned from operator routine listings; existing `routine_firings` rows remain in the run store for evidence and debugging.
