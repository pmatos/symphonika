import { z } from "zod";

export const pathStringSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.includes("\0"), "path must not contain NUL bytes");

const workflowPathSchema = pathStringSchema;

const WORKSPACE_HOOK_LIFECYCLES = [
  "after_create",
  "before_run",
  "after_run",
  "before_remove"
] as const;

const allowedWorkspaceHookLifecycles = new Set<string>(
  WORKSPACE_HOOK_LIFECYCLES
);
const workspaceHookLifecycleList = WORKSPACE_HOOK_LIFECYCLES.join(", ");

const workspaceHookSchema = z
  .object({
    command: z.string().trim().min(1, "command must be a non-empty string"),
    timeout_ms: z.number().int().min(1000).optional()
  })
  .strict();

const workspaceHooksSchema = z
  .object({
    after_create: workspaceHookSchema.optional(),
    before_run: workspaceHookSchema.optional(),
    after_run: workspaceHookSchema.optional(),
    before_remove: workspaceHookSchema.optional()
  })
  .passthrough()
  .superRefine((value, context) => {
    for (const key of Object.keys(value)) {
      if (allowedWorkspaceHookLifecycles.has(key)) {
        continue;
      }

      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unknown workspace hook lifecycle "${key}"; allowed lifecycles: ${workspaceHookLifecycleList}`,
        path: [key]
      });
    }
  });

export const projectWorkspaceSchema = z
  .object({
    root: pathStringSchema,
    git: z
      .object({
        remote: z.string().trim().min(1),
        base_branch: z.string().trim().min(1)
      })
      .passthrough(),
    hooks: workspaceHooksSchema.optional()
  })
  .passthrough();

const workflowFormatSchema = z.enum(["markdown", "raw_fsm", "auto"]);
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
