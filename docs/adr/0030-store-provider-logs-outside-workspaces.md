# Store provider logs outside workspaces

Symphonika will store raw provider logs, normalized event logs, stderr, and rendered prompts under the orchestrator's log root rather than inside issue workspaces. Workspaces are Git worktrees that full-permission agents may modify, while logs are orchestrator evidence and must remain separate from the agent's working tree.
