# Full-permission agent execution

Symphonika assumes coding agents run with full local permissions and without provider approval prompts or provider sandbox restrictions. The default Codex provider command is `codex -p symphonika -c sandbox_mode=danger-full-access -c approval_policy=never -c model_reasoning_summary=detailed -c model_verbosity=medium --dangerously-bypass-approvals-and-sandbox app-server` (the `-p symphonika` flag selects a named profile in `~/.codex/config.toml` — see ADR-0042 for the profile contract), the default Claude provider command is `claude -p --dangerously-skip-permissions --verbose --input-format stream-json --output-format stream-json`, and the default OMP provider command is `omp --mode rpc --auto-approve` (see ADR-0066). Any future sandboxing should be implemented outside the provider as host, container, VM, network, or credential isolation rather than as provider-level approval policy. Provider commands may be overridden, but the replacement command must still speak the provider adapter's expected protocol.

**Reaffirmed by ADR-0097:** Symphonika keeps these provider-neutral full-permission defaults rather
than adopting Claude's `--permission-mode auto` as a provider-specific interim default. Filesystem
sandboxing remains deferred until its provider state-path and host-compatibility contract is known;
operator-authored provider-command overrides remain supported.

**Amendment note:** "must still speak the provider adapter's expected protocol" means wire-protocol
conformance only — the flags each adapter's own parser requires to function (see SPEC.md §11.3).
Provider adapters originally also statically rejected an authored command unless it carried one
specific full-permission flag/value (Claude: `--dangerously-skip-permissions` or `--permission-mode
bypassPermissions`; OMP: `--auto-approve` or `--approval-mode yolo`). That extra gate is removed
(ADR-0067's second amendment): a provider CLI's permission/approval policy is the operator's own
authored choice, not something Symphonika's TypeScript should hardcode or allowlist — the gate could
not keep up with new modes a provider CLI added (e.g. Claude's `auto` mode) and stopped legitimate,
already-headless-compatible choices. The full-permission posture above remains Symphonika's
*default* and its documented recommendation, not a runtime-enforced invariant on an operator-overridden
command. `doctor --live-check <provider>` is the opt-in functional replacement for verifying a chosen
command and permission mode actually completes a real turn.
