# Capped continuations after successful runs

After a provider completes successfully, Symphonika will re-check the GitHub issue and schedule a short continuation if the issue remains open and eligible. Continuations are distinct from failure retries and default to a cap of three per issue so a workflow that forgets to clear eligibility cannot loop forever.
