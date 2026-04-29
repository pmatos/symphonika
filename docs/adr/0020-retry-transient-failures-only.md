# Retry transient failures only

Symphonika will retry transient infrastructure and provider failures with exponential backoff, defaulting to three retries with delays around 10 seconds, 30 seconds, and 2 minutes capped at 5 minutes. Deterministic failures such as prompt rendering errors, invalid config, input-required signals, continuation caps, and workspace conflicts will not be retried automatically; they become operator-visible failures with logs and workspace state preserved.
