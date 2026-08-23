# Graceful project disable and removal

**Amendment note (issue #424):** the Project cascade below applies to current Routine Targets. A
target already soft-disabled with `disabled_reason = "removed_from_config"` is durable declaration
history, so a later Project disable or removal preserves that disabled state and reason instead of
re-marking the target `inactive`.

Disabling a Project stops new dispatch immediately but lets existing runs continue by default. Removing a Project from service config marks it inactive rather than killing active full-permission agents; operators can explicitly cancel runs through the CLI or UI when interruption is required.

Routine declarations are configuration-derived Project children, not the historical evidence itself.
When a Project is disabled or omitted from the current valid Service Config snapshot, its current
Routine rows are marked inactive and pruned from default operator listings. Historical
`removed_from_config` rows retain that reason under the amendment above. Operators can opt in to
inactive rows through the Routine API, CLI, or dashboard query. Existing Routine Firings remain in
the Run Store for evidence and debugging. Re-enabling a Project restores its configured Routines
without discarding `last_fired_at`; an already-fired one-shot returns to `expired` and does not fire
again.

Hard deletion was rejected because re-enabling a Project could repeat already-completed one-shot
work. Keeping current disabled-Project targets in default listings was rejected because it presents
inactive configuration as current operator state. Filtering durable inactive rows while retaining
historical removal evidence preserves both lifecycle correctness and an accurate default view.
