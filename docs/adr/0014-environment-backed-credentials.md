# Environment-backed credentials

Symphonika will read GitHub credentials from environment variables and rely on each agent provider's native authentication for Codex, Claude, and OMP. Service config may reference environment variable names, but literal tokens should not be stored in YAML or SQLite, and logs must redact token-like values. This keeps durable state inspectable without turning the run store or config files into secret stores.

The execution-time redaction inventory is explicit: the effective tracker token for the Project and,
whenever an email sink is configured, the value of the variable named by `email.smtp_password_env` —
whether or not SMTP authentication is enabled, since the provider inherits that variable either way.
Issue Runs and Routine
Firings apply those resolved values before persisting provider-authored files, provider-event rows,
or provider-derived terminal evidence. Symphonika does not classify every inherited environment
value as a credential: provider-native credentials and unrelated operator variables have no
orchestrator-owned configuration boundary from which to resolve a reliable inventory.
