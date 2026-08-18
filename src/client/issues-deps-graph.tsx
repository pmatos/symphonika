import { createRoot } from "react-dom/client";

import { IssuesDepsGraphView } from "./issues-deps-graph-view.js";

const root = document.getElementById("issues-deps-graph-root");
if (root !== null) {
  createRoot(root).render(<IssuesDepsGraphView />);
}
