import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { BUILTIN_WORKFLOW_TEMPLATES } from "../src/builtin-templates.js";

const EXPECTED_BUILTINS = [
  "autofix-until-clean",
  "merge-when-green",
  "plan-tdd-pr",
  "single-agent-pr"
] as const;

const TERMINAL_VALUES = new Set(["success", "blocked", "failure"]);

describe("built-in workflow template registry", () => {
  it("exposes the four built-in templates expected by SPEC §Built-In Templates", () => {
    expect(Object.keys(BUILTIN_WORKFLOW_TEMPLATES).sort()).toEqual(
      [...EXPECTED_BUILTINS]
    );
  });

  for (const name of EXPECTED_BUILTINS) {
    describe(`${name}`, () => {
      const yamlText = BUILTIN_WORKFLOW_TEMPLATES[name];
      if (yamlText === undefined) {
        throw new Error(`BUILTIN_WORKFLOW_TEMPLATES missing ${name}`);
      }
      const parsed = parse(yamlText) as Record<string, unknown>;

      it("has an entry that points at a declared state", () => {
        const entry = parsed.entry;
        const states = parsed.states as Record<string, unknown>;
        expect(typeof entry).toBe("string");
        expect(states[entry as string]).toBeDefined();
      });

      it("declares success and blocked exits", () => {
        const exits = parsed.exits as Record<string, string>;
        expect(exits).toBeDefined();
        expect(exits.success).toBeDefined();
        expect(exits.blocked).toBeDefined();
      });

      it("maps every exit to a state that declares matching exit and terminal markers", () => {
        const exits = parsed.exits as Record<string, string>;
        const states = parsed.states as Record<string, Record<string, unknown>>;
        for (const [exitName, targetState] of Object.entries(exits)) {
          const state = states[targetState];
          if (state === undefined) {
            throw new Error(
              `exit ${exitName} target ${targetState} missing from states`
            );
          }
          expect(state.exit).toBe(exitName);
          expect(state.terminal).toBeDefined();
          expect(TERMINAL_VALUES).toContain(state.terminal);
        }
      });

      it("declares a default for every input", () => {
        const inputs = parsed.inputs as
          | Record<string, Record<string, unknown>>
          | undefined;
        if (inputs === undefined) {
          return;
        }
        for (const [inputName, input] of Object.entries(inputs)) {
          expect(input.type, `${inputName} has no type`).toBeDefined();
          expect(
            input.default,
            `${inputName} has no default`
          ).not.toBeUndefined();
        }
      });

      it("references only declared inputs from {{ tag }} interpolations", () => {
        const inputs = parsed.inputs as
          | Record<string, Record<string, unknown>>
          | undefined;
        const declared = new Set(Object.keys(inputs ?? {}));
        const tagRe = /{{\s*([A-Za-z_][A-Za-z0-9_]*)\s*}}/g;
        let match: RegExpExecArray | null;
        const seen = new Set<string>();
        while ((match = tagRe.exec(yamlText)) !== null) {
          const tag = match[1];
          if (tag !== undefined) {
            seen.add(tag);
          }
        }
        for (const tag of seen) {
          expect(declared, `tag {{${tag}}} not declared as input`).toContain(
            tag
          );
        }
      });
    });
  }
});
