# Auto-create operational labels

Symphonika will ensure each Project repository has the required operational labels: `sym:claimed`, `sym:running`, `sym:failed`, and `sym:stale`. Label creation requires explicit operator confirmation through commands such as `symphonika init-project` or a deliberate startup flag, and must show an operator-visible warning naming the repository and labels to be created. The daemon refuses to dispatch a Project whose labels are missing; with multiple Projects, invalid Projects are disabled while valid Projects can continue.
