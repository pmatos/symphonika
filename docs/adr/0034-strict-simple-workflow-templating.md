# Strict simple workflow templating

Symphonika workflow contracts will use simple strict Mustache-style templating over normalized objects such as project, issue, workspace, branch, run, and provider. Unknown variables fail prompt rendering, and templates do not execute arbitrary JavaScript; this keeps prompt construction predictable and easy for agents to validate.
