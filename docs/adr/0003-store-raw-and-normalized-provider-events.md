# Store raw and normalized provider events

Symphonika will persist both the raw provider stream for each run and a normalized provider-neutral event log. The normalized log keeps orchestration, tests, and observability independent of Codex JSON-RPC and Claude stream-json details, while the raw log preserves enough evidence to replay adapter behavior and debug provider protocol drift.
