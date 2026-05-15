// Strip GitHub credentials from the test environment so that any test which
// resolves token: "$GITHUB_TOKEN" in a config fixture cannot accidentally
// authenticate against the live GitHub API. Without this, a daemon spun up by
// a test (with the helper YAML pointed at the real owner/repo) would inherit
// the real token from the parent process and mutate live issues. The failure
// mode is silent — the test still passes — and the side effect is writing
// sym:stale to a real issue, which cancels a running daemon's run.
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;
delete process.env.GH_ENTERPRISE_TOKEN;
delete process.env.GITHUB_ENTERPRISE_TOKEN;
