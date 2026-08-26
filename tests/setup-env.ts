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

// `git commit` (and rebase/merge/fetch) spawns a detached
// `git maintenance run --auto --quiet --detach` grandchild that outlives the
// git process a test awaits. It keeps writing under `.git/objects` -- the
// maintenance lock, and pack files once auto-gc decides to repack -- while an
// afterEach hook is already rm -rf'ing the throwaway repo, so the cleanup can
// fail with ENOTEMPTY. Injecting the config here (rather than per repo) covers
// every git invocation made by a test or by the code under test.
process.env.GIT_CONFIG_COUNT = "2";
process.env.GIT_CONFIG_KEY_0 = "maintenance.auto";
process.env.GIT_CONFIG_VALUE_0 = "false";
process.env.GIT_CONFIG_KEY_1 = "gc.auto";
process.env.GIT_CONFIG_VALUE_1 = "0";
