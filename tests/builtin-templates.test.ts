import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { BUILTIN_WORKFLOW_TEMPLATES } from "../src/builtin-templates.js";
import { validatePromptTemplateExpressions } from "../src/workflow/autonomous-prompt.js";

const EXPECTED_BUILTINS = [
  "autofix-until-clean",
  "merge-when-green",
  "plan-tdd-pr",
  "refactor-swarm",
  "single-agent-pr"
] as const;

const TERMINAL_VALUES = new Set(["success", "blocked", "failure"]);

describe("built-in workflow template registry", () => {
  it("exposes the five built-in templates expected by the workflow contract", () => {
    expect(Object.keys(BUILTIN_WORKFLOW_TEMPLATES).sort()).toEqual([
      ...EXPECTED_BUILTINS
    ]);
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
          Record<string, Record<string, unknown>> | undefined;
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
          Record<string, Record<string, unknown>> | undefined;
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

describe("shipped refactor-swarm prompts", () => {
  const refactorSwarm = parse(
    BUILTIN_WORKFLOW_TEMPLATES["refactor-swarm"] ?? ""
  ) as { inputs: Record<string, { default?: unknown }> };

  const DEFAULT_PROMPT_PATHS = {
    red_team_prompt: "prompts/red-team.md",
    refactor_prompt: "prompts/refactor.md",
    verify_prompt: "prompts/verify.md"
  } as const;

  const readPrompt = (promptPath: string): Promise<string> =>
    readFile(path.resolve(promptPath), "utf8");

  it("points every prompt input default at a prompt file the repository ships", async () => {
    for (const [input, promptPath] of Object.entries(DEFAULT_PROMPT_PATHS)) {
      expect(refactorSwarm.inputs[input]?.default, input).toBe(promptPath);
      await expect(readPrompt(promptPath)).resolves.toContain("#");
    }
  });

  it("renders only supported prompt variables and names the issue in every state", async () => {
    for (const promptPath of Object.values(DEFAULT_PROMPT_PATHS)) {
      const template = await readPrompt(promptPath);
      expect(
        validatePromptTemplateExpressions(template, promptPath),
        promptPath
      ).toEqual([]);
      // Without these the agent has no way to identify the issue, the
      // refactor target named in its body, or the branch it must stay on.
      expect(template, promptPath).toContain("{{issue.number}}");
      expect(template, promptPath).toContain("{{issue.body}}");
      expect(template, promptPath).toContain("{{workspace.path}}");
      expect(template, promptPath).toContain("{{branch.name}}");
    }
  });

  it("keeps the immutable characterization-test baseline instructions", async () => {
    // Prose reflows on edit, so match against whitespace-collapsed text
    // rather than pinning these phrases to a particular line break.
    const readFlattened = async (promptPath: string): Promise<string> =>
      (await readPrompt(promptPath)).replace(/\s+/g, " ");
    const redTeam = await readFlattened(DEFAULT_PROMPT_PATHS.red_team_prompt);
    const refactor = await readFlattened(DEFAULT_PROMPT_PATHS.refactor_prompt);
    const verify = await readFlattened(DEFAULT_PROMPT_PATHS.verify_prompt);

    expect(redTeam).toContain("characterization tests");
    expect(redTeam).toContain("Commit only");
    expect(redTeam).toContain("git status --porcelain");
    expect(refactor).toContain("Do not edit, delete, rename, skip, or weaken");
    expect(verify).toContain("distinct refactor commit");
    expect(verify).toContain("Do not modify files or create commits");
    // Every state must spell out the concrete blocked-exit signal, matching
    // the convention the other shipped prompts already use.
    for (const prompt of [redTeam, refactor, verify]) {
      expect(prompt).toContain("`exit 1`");
      expect(prompt).toContain("blocked exit");
    }
  });
});
