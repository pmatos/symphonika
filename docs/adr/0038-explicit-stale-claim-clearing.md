# Explicit stale-claim clearing

Symphonika v1 will not auto-clear stale claims with a TTL. `doctor` and the local UI surface stale issues for inspection, and `clear-stale` removes `sym:stale` and `sym:claimed` only after explicit operator confirmation.
