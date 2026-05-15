import { workflowReferenceSchema } from "../dist/config-schemas.js";
import {
  expandWorkflowDefinition,
  parseWorkflowContract,
  validateWorkflowTemplate
} from "../dist/workflow.js";

/**
 * @param {import("node:buffer").Buffer} data
 */
export function fuzz(data) {
  const contents = data.toString("utf8");

  parseWorkflowContract(contents, "fuzz/WORKFLOW.md");
  validateWorkflowTemplate(contents, "fuzz/WORKFLOW.md");
  expandWorkflowDefinition(contents, "fuzz/WORKFLOW.md", "markdown");
  expandWorkflowDefinition(contents, "fuzz/workflow.yml", "raw_fsm");

  workflowReferenceSchema.safeParse(contents);
  workflowReferenceSchema.safeParse({
    format: contents.includes("raw_fsm") ? "raw_fsm" : "auto",
    path: contents
  });
}
