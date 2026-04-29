# Automatic polling with manual refresh

Symphonika dispatches automatically from the daemon on a default poll interval of 30 seconds, while also providing a manual poll-now trigger through the CLI or local UI/API for debugging and operator control. Validation and status commands never dispatch work, and invalid Projects are skipped without stopping valid Projects.
