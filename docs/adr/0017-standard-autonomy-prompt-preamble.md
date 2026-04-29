# Standard autonomy prompt preamble

Symphonika will prepend a standard provider-neutral autonomy preamble to every repository workflow prompt. The preamble tells the coding agent it is running as an autonomous full-permission worker, should not ask for operator input, should make reasonable decisions when ambiguity is low, should preserve evidence when blocked, and should operate from the prepared workspace and issue branch for the assigned issue.
