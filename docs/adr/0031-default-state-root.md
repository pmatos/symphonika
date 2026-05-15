# Default state root

Symphonika's default state root is `.symphonika` next to the selected service config file, with an optional config override for locations such as `~/.local/state/symphonika`. The SQLite database, provider logs, rendered prompts, and local runtime files live under the state root; Project workspaces default to `state.root/workspaces/<project-name>` unless explicitly configured.
