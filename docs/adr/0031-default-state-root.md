# Default state root

Symphonika's default state root is `$XDG_STATE_HOME/symphonika` (or `~/.local/state/symphonika`) when the selected service config is the user config at `$XDG_CONFIG_HOME/symphonika/symphonika.yml`. For an explicit or project-local service config, the default remains `.symphonika` next to that config file. The SQLite database, provider logs, rendered prompts, and local runtime files live under the state root; Project workspaces default to `state.root/workspaces/<project-name>` unless explicitly configured.
