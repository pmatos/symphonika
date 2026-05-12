import { z } from "zod";

const workflowPathSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.includes("\0"), "path must not contain NUL bytes");

export const workflowFormatSchema = z.enum(["markdown", "raw_fsm", "auto"]);
export type WorkflowFormat = z.infer<typeof workflowFormatSchema>;

export const workflowReferenceSchema = z.union([
  workflowPathSchema.transform((value) => ({
    format: "auto" as const,
    path: value
  })),
  z
    .object({
      format: workflowFormatSchema.default("auto"),
      path: workflowPathSchema
    })
    .strict()
]);

export type WorkflowReference = z.infer<typeof workflowReferenceSchema>;
