# Immediate startup poll

After loading config, validating Projects, reconciling stale state, and starting the local operator surface, Symphonika performs an immediate poll before scheduling interval polling. Operators starting the daemon should see eligible work begin promptly rather than waiting for the first 30-second interval.
