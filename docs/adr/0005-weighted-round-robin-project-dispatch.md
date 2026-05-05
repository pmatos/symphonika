# Weighted round-robin project dispatch

Symphonika will dispatch eligible issues with weighted round-robin fairness across Projects, then sort issues within each Project by configured priority and age. This avoids a noisy repository starving smaller Projects while still allowing each Project to express local issue urgency.

Project Cursor state is durable in SQLite by Project name. Cursor rows retain configured weight, runtime validation state, last poll outcome, scheduler current weight, and last dispatch details so operators can explain scheduling decisions after daemon restart. Removing a Project from service config marks its row inactive instead of deleting historical scheduler evidence.
