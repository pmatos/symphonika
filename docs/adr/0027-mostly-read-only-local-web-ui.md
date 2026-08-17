# Mostly read-only local web UI

Status: Superseded by ADR 0075

The Symphonika v1 local web UI will be primarily an observability console for Projects, issues, runs, attempts, normalized events, raw logs, and validation status. The mutating v1 actions exposed through the local web/API surface are explicit active-run cancellation and the manual poll-now trigger from ADR-0036; poll-now reuses the daemon scheduler path rather than bypassing dispatch gates. Label creation, stale-claim reset, and workspace cleanup remain CLI-only.

Reaffirmed by ADR-0057: bringing richer visual design into the v1 dashboard scope changes presentation only. It adds no mutating action and leaves this observability boundary intact.

Superseded by ADR-0075 (`#306`): once the dashboard writes routine declarations, workflow contracts, service config, and labels, this "mostly read-only" boundary no longer holds. ADR-0075 records the new mutation-authentication model that gates every write; the actual set of writable surfaces expands with each editor slice that follows it.
