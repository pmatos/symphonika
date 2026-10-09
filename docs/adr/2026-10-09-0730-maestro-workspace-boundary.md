# Maestro reads repository content only through a fetched, read-only Maestro Workspace

Status: Accepted

## Context

Issue #867 (slice of epic #844) lets Maestro answer source-specific questions. ADR-2026-10-07-0813
made Maestro's read-only boundary structural: no write-shaped tool exists. Reading repository content
adds two new risks that boundary does not cover on its own: the model provider receives whatever
content is read (including from private repositories), and repository content is attacker-influenced
text just like an Issue body. Giving Maestro the Project's local checkout or a Coding Agent Workspace
would also expose uncommitted files, `.env` files, and unrelated local directories.

## Decision

- **Maestro Workspace** is a bare git mirror under `<state root>/maestro-workspace/<owner>/<repo>.git`,
  separate from every Coding Agent Workspace. Revisions are fetched with a fixed-argv `git fetch
  --depth=1` using a scrubbed environment (no user or system git config, no prompts, token passed via
  `GIT_CONFIG_*` `http.extraheader`, never argv). Every fetch lands in one scratch ref
  (`refs/maestro/fetched`) so the next fetch of the same repository negotiates from it instead of
  re-downloading the whole tree. Nothing is ever checked out, so no local file can be
  read; reads are `git ls-tree` / `cat-file` / `grep` object lookups with `GIT_LITERAL_PATHSPECS=1`.
  Model-supplied values reach git only as a validated `<sha>:<path>` operand, a `-e` pattern, or a
  `--`-separated literal pathspec.
- The tool surface stays fixed: `workspace_list_files`, `workspace_read_file`, `workspace_search`. No
  generic `gh` passthrough, shell, or write tool, and no tool lists or discovers repositories, so the
  default briefing can never inventory the accessible set. An outside repository is read only when
  named explicitly (`owner/name`); accessibility is whatever the operator's `gh` login (or the Project's
  token for a configured Project's own repository) can see.
- **Disclosure is an explicit setting**: `maestro.repository_content` is `none` (default; the workspace
  tools are not offered), `public`, or `public_and_private`. Visibility is checked through the GitHub API
  before any git subprocess runs, so `public` cannot read a private repository. The `/maestro` page
  states the configured setting.
- **Revision semantics**: general Project questions fetch the repository's default branch now. A Run
  question reads the head sha Symphonika recorded on the Run's tracked pull request snapshot, or, when
  none was recorded, the Run branch's tip fetched now; the result names which. A missing revision is
  reported as unavailable. It is never replaced by the default branch. Every result carries repository,
  ref, commit sha, fetch time, source, and visibility, and a session fetches each revision once per chat
  turn, so every new question re-fetches.
- Repository content is wrapped as untrusted evidence (`untrusted: true`, plus the system prompt), and
  files that look like secrets (`.env*`, keys, `.npmrc`, `.git-credentials`, `credentials*`) are withheld. Known token values
  are redacted from anything returned.
- No per-repository mutex: `/maestro/messages` already serializes turns on the single dashboard
  conversation. The mirror is not pruned in this slice.

## Consequences

Enabling `public` or `public_and_private` sends repository content to the configured model provider by
design; the operator opts in per deployment. Secret-path matching is a heuristic, not a guarantee, which
is why disclosure stays opt-in.
