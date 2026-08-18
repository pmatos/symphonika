import { createRoot } from "react-dom/client";

import { IssuesBulkSelect } from "./issues-bulk-select.js";

const root = document.getElementById("issues-bulk-root");
if (root !== null) {
  createRoot(root).render(<IssuesBulkSelect />);
}
