# Environment-backed credentials

Symphonika will read GitHub credentials from environment variables and rely on each agent provider's native authentication for Codex and Claude. Service config may reference environment variable names, but literal tokens should not be stored in YAML or SQLite, and logs must redact token-like values. This keeps durable state inspectable without turning the run store or config files into secret stores.
