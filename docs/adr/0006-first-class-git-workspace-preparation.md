# First-class Git workspace preparation

Symphonika will prepare GitHub Project workspaces with built-in Git clone/fetch behavior before running repository-defined hooks. The Symphony spec leaves workspace population to hooks, but Symphonika treats the GitHub repository as core Project configuration, so first-class preparation gives more predictable validation, logging, and debugging while preserving hooks for repository-specific bootstrap.
