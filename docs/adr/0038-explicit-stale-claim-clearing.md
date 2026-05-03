# Explicit stale-claim clearing

Symphonika v1 will not auto-clear stale claims with a TTL. `doctor` and the local UI surface stale issues for inspection, and `clear-stale` removes `sym:stale`, `sym:claimed`, and `sym:running` only after explicit operator confirmation. All three labels are required because stale detection treats `sym:claimed` or `sym:running` as evidence of a claim, so leaving either behind would cause the issue to be re-marked stale on the next poll.
