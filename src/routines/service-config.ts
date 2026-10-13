import { z } from "zod";

import { pathStringSchema } from "../config-schemas.js";
import type { RoutineExecutionOverrides } from "./types.js";

// A Routine explicitly targets a non-empty list of declared Projects. Keep
// migration diagnostics ahead of the missing-list error (ADR 0069).
const serviceRoutineSchema = z
  .object({
    projects: z.array(z.string().trim().min(1)).min(1).optional(),
    path: pathStringSchema
  })
  .passthrough()
  .superRefine((entry, ctx) => {
    if ("project" in entry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "service-level `project:` was replaced by the explicit `projects: [<name>, ...]` target list (see ADR 0069)",
        path: ["project"]
      });
    }
    if (entry.projects === undefined) {
      if (!("project" in entry)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "an explicit non-empty `projects: [<name>, ...]` target list is required",
          path: ["projects"]
        });
      }
      return;
    }
    const seen = new Set<string>();
    for (const [index, projectName] of entry.projects.entries()) {
      if (seen.has(projectName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate target project "${projectName}"`,
          path: ["projects", index]
        });
      }
      seen.add(projectName);
    }
  })
  .transform((entry) => ({ ...entry, projects: entry.projects! }));

// Compose these fields at their existing position in each reader's root
// schema. The order preserves doctor's effort-first and reload's model-first
// diagnostics without exposing separate validation or normalization steps.
export function routineServiceConfigFields(
  defaultsOrder: "effort-first" | "model-first"
) {
  const tuningString = z.string().trim().min(1).optional();
  const tuning =
    defaultsOrder === "effort-first"
      ? { effort: tuningString, model: tuningString }
      : { model: tuningString, effort: tuningString };
  const defaults = z
    .object({
      ...tuning,
      permission_mode: tuningString,
      timeout_minutes: z.number().positive().optional()
    })
    .strict()
    .transform((raw): RoutineExecutionOverrides => {
      // Retain each reader's historical normalized property order too.
      const model = raw.model === undefined ? {} : { model: raw.model };
      const effort = raw.effort === undefined ? {} : { effort: raw.effort };
      return {
        ...(defaultsOrder === "effort-first"
          ? { ...model, ...effort }
          : { ...effort, ...model }),
        ...(raw.permission_mode === undefined
          ? {}
          : { permissionMode: raw.permission_mode }),
        ...(raw.timeout_minutes === undefined
          ? {}
          : { timeoutMinutes: raw.timeout_minutes })
      };
    });
  return {
    routine_defaults: defaults.optional(),
    routines: z.array(serviceRoutineSchema).optional()
  };
}

// Project schemas are passthrough: explicitly refuse the removed syntax so
// legacy declarations cannot silently validate and stop firing (ADR 0069).
export function rejectProjectRoutineDeclarations(
  rawProject: unknown,
  ctx: z.RefinementCtx
): void {
  if (
    rawProject !== null &&
    typeof rawProject === "object" &&
    "routines" in rawProject
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "per-project `routines:` was removed; move routine entries to the top-level `routines:` block with a `projects: [<name>, ...]` target list (see ADR 0069)",
      path: ["routines"]
    });
  }
}
