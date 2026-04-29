# Eligibility loss cancels active runs

If a running issue stops matching its Project eligibility filters, Symphonika will cancel the active provider process, mark the run cancelled, remove `sym:running`, and preserve workspace and logs. Eligibility labels are the operator's live control surface, so removing `agent-ready` or adding excluded labels such as `blocked` or `needs-human` should stop further autonomous work.
