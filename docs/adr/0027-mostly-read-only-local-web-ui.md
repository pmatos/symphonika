# Mostly read-only local web UI

The Symphonika v1 local web UI will be primarily an observability console for Projects, issues, runs, attempts, normalized events, raw logs, and validation status. The mutating v1 actions exposed through the local web/API surface are explicit active-run cancellation and the manual poll-now trigger from ADR-0036; poll-now reuses the daemon scheduler path rather than bypassing dispatch gates. Label creation, stale-claim reset, and workspace cleanup remain CLI-only.

Reaffirmed by ADR-0057: bringing richer visual design into the v1 dashboard scope changes presentation only. It adds no mutating action and leaves this observability boundary intact.
