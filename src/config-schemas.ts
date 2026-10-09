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

export const projectDispatchSchema = z
  .object({
    overlap_guard: z.boolean().default(false)
  })
  .strict();

export const projectProgressGuardSchema = z
  .object({
    // Absolute accepted-claim budget for one directed park edge. Zero keeps
    // the fingerprint guard but disables this changing-cycle bound.
    max_claims_per_edge: z.number().int().nonnegative()
  })
  .strict();

// A Routine Host has no use for dispatch-only fields — ADR 0062 says they are
// "unused and rejected", so a stale or copy-pasted dispatch block must be a
// declaration-time error rather than silently ignored. Shared so `reload` and
// `doctor` cannot drift on which keys they reject.
const DISPATCH_ONLY_KEYS = [
  "dispatch",
  "epic_labels",
  "issue_filters",
  "priority",
  "progress_guard",
  "workflow"
] as const;

export function rejectDispatchOnlyKeysOnRoutineHost(
  rawProject: unknown,
  ctx: z.RefinementCtx
): void {
  if (rawProject === null || typeof rawProject !== "object") {
    return;
  }
  for (const key of DISPATCH_ONLY_KEYS) {
    if (key in rawProject) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `\`${key}\` is a dispatch-only field and is unused and rejected on a Routine Host (mode: routine_host); see ADR 0062`,
        path: [key]
      });
    }
  }
}

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

export const DEFAULT_READY_LABEL = "ready-for-agent";

// ADR-2026-10-08-1426: a Dispatch Project has exactly one Ready Label. Legacy
// `labels_all` is migrated here, at load time, so no consumer ever sees it.
// Several legacy labels collapse to the first; the full original list is kept
// in `migrated_from_labels_all` so doctor, the startup log, and the UI can
// report the resulting broadening of eligibility. The marker survives a
// re-parse of parsed output (it is a passthrough key), keeping this idempotent.
export const issueFiltersSchema = z
  .object({
    states: z.array(z.literal("open")).min(1),
    ready_label: z.string().trim().min(1).optional(),
    labels_all: z.array(z.string().trim().min(1)).optional(),
    labels_none: z.array(z.string().trim().min(1)),
    migrated_from_labels_all: z.array(z.string().trim().min(1)).optional()
  })
  .passthrough()
  .superRefine((filters, ctx) => {
    if (filters.labels_all !== undefined && filters.ready_label !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "`labels_all` and `ready_label` are both set; remove `labels_all` and keep the single `ready_label`",
        path: ["labels_all"]
      });
    } else if (filters.labels_all !== undefined) {
      if (filters.labels_all.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "`labels_all` is empty; choose a `ready_label` (for example `ready-for-agent`)",
          path: ["labels_all"]
        });
      }
    } else if (filters.ready_label === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "`ready_label` is required: set the single label that marks an issue ready for dispatch",
        path: ["ready_label"]
      });
    }
  })
  .transform(({ labels_all, ready_label, ...rest }) => {
    if (labels_all === undefined) {
      return { ...rest, ready_label: ready_label as string };
    }
    const distinct = [...new Set(labels_all)];
    const [first = DEFAULT_READY_LABEL] = distinct;
    return {
      ...rest,
      ready_label: first,
      ...(distinct.length > 1 ? { migrated_from_labels_all: distinct } : {})
    };
  });

// Epic Labels are display-only vocabulary (#857): they never feed eligibility
// or priority, so a label that does either cannot also be an Epic Label.
export const epicLabelsSchema = z
  .array(z.string().trim().min(1))
  .optional()
  .superRefine((labels = [], ctx) => {
    const seen = new Set<string>();
    labels.forEach((label, index) => {
      if (seen.has(label)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate epic label \`${label}\``,
          path: [index]
        });
      }
      seen.add(label);
    });
  });

export function rejectEpicLabelOverlap(
  project: {
    epic_labels?: string[] | undefined;
    issue_filters: { ready_label: string };
    priority: { labels: Record<string, number> };
  },
  ctx: z.RefinementCtx
): void {
  (project.epic_labels ?? []).forEach((label, index) => {
    if (label === project.issue_filters.ready_label) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `epic label \`${label}\` is the project's ready_label; epic labels must not carry eligibility`,
        path: ["epic_labels", index]
      });
    }
    if (label in project.priority.labels) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `epic label \`${label}\` is also a priority label; epic labels must not carry priority`,
        path: ["epic_labels", index]
      });
    }
  });
}

export function readyLabelBroadeningWarning(
  projectName: string,
  filters: {
    ready_label: string;
    migrated_from_labels_all?: string[] | undefined;
  }
): string | undefined {
  const legacy = filters.migrated_from_labels_all;
  if (legacy === undefined || legacy.length < 2) {
    return undefined;
  }
  return `project ${projectName}: legacy issue_filters.labels_all [${legacy.join(", ")}] was migrated to ready_label "${filters.ready_label}"; issues no longer need ${legacy
    .slice(1)
    .map((label) => `"${label}"`)
    .join(
      " or "
    )} to be eligible, so eligibility is broader than before. Set issue_filters.ready_label explicitly and remove labels_all`;
}
