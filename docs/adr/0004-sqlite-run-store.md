# SQLite run store

Symphonika will use SQLite as the durable run store from the first version, while keeping raw provider streams in JSONL files referenced by database rows. The original Symphony spec allowed memory-only scheduler state, but Symphonika's multi-project model and GitHub operational labels need restart-time introspection, durable retry schedules, and evidence for stale-claim recovery without introducing a separate database service.
