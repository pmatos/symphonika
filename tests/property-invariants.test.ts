import path from "node:path";
import fc from "fast-check";
import type { Arbitrary } from "fast-check";
import { describe, expect, it } from "vitest";

import { workflowReferenceSchema } from "../src/config-schemas.js";
import {
  decideNextStep,
  type StateMachineSignals
} from "../src/lifecycle/state-machine-dispatch.js";
import { isPathInside } from "../src/path-safety.js";
import type {
  ExpandedWorkflowState,
  WorkflowPredicateValue
} from "../src/workflow.js";

const predicateKey = fc.constantFrom(
  "branch_ahead_of_base",
  "pr_open",
  "provider_success",
  "unresolved_review_threads"
);

const predicateValue: Arbitrary<WorkflowPredicateValue> = fc.oneof(
  fc.boolean(),
  fc.integer({ max: 3, min: -3 }),
  fc.string({ maxLength: 8 })
);

const predicateMap: Arbitrary<StateMachineSignals> = fc.dictionary(
  predicateKey,
  predicateValue,
  {
    maxKeys: 4
  }
);

const stateId = fc
  .string({ maxLength: 24, minLength: 1 })
  .filter((value) => value.trim().length > 0);

describe("property-based quality invariants", () => {
  it("normalizes any non-empty workflow path string to the auto format", () => {
    fc.assert(
      fc.property(
        fc
          .string({ maxLength: 80, minLength: 1 })
          .filter((value) => value.trim().length > 0 && !value.includes("\0")),
        (input) => {
          const parsed = workflowReferenceSchema.parse(input);
          expect(parsed).toEqual({ format: "auto", path: input.trim() });
        }
      )
    );
  });

  it("always terminates terminal workflow states before evaluating signals", () => {
    fc.assert(
      fc.property(
        stateId,
        fc.constantFrom("blocked", "failure", "success"),
        fc.boolean(),
        predicateMap,
        (id, terminal, actionExecuted, signals) => {
          const state: ExpandedWorkflowState = {
            completeWhen: {},
            id,
            terminal,
            transitions: []
          };

          expect(decideNextStep({ actionExecuted, signals, state })).toEqual({
            kind: "terminate",
            stateId: id,
            terminal
          });
        }
      )
    );
  });

  it("blocks immediately when a required complete_when boolean is false", () => {
    fc.assert(
      fc.property(predicateKey, fc.boolean(), (key, expected) => {
        const state: ExpandedWorkflowState = {
          completeWhen: { [key]: expected },
          id: "requires_signal",
          transitions: [{ to: "unreachable", when: {} }]
        };
        const signals: StateMachineSignals = { [key]: !expected };

        const decision = decideNextStep({
          actionExecuted: true,
          signals,
          state
        });

        expect(decision.kind).toBe("blocked");
        if (decision.kind === "blocked") {
          expect(decision.reason).toContain(key);
        }
      })
    );
  });

  it("treats descendants as inside a parent path and siblings as outside", () => {
    const segment = fc.constantFrom(
      "alpha",
      "beta",
      "delta",
      "project",
      "run",
      "workspace"
    );

    fc.assert(
      fc.property(
        fc.array(segment, { maxLength: 4, minLength: 1 }),
        (segments) => {
          const parent = path.join("/tmp/symphonika-property", ...segments);
          const child = path.join(parent, "child");
          const sibling = path.join(
            parent,
            "..",
            `${segments.at(-1) ?? "root"}-sibling`
          );

          expect(isPathInside(parent, parent)).toBe(true);
          expect(isPathInside(child, parent)).toBe(true);
          expect(isPathInside(sibling, parent)).toBe(false);
        }
      )
    );
  });
});
