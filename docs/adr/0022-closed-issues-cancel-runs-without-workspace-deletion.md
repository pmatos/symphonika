# Closed issues cancel runs without workspace deletion

When GitHub reconciliation finds that an issue is closed, Symphonika will cancel any active provider process for that issue, mark the run cancelled, and remove operational labels best-effort. The issue workspace and logs are preserved by default in v1 so operators can inspect partial work and provider evidence.
