import { describe, expect, it } from "vitest";

import {
  ProviderCommandTemplateError,
  renderProviderCommandTemplate
} from "../src/provider-command-template.js";

describe("renderProviderCommandTemplate", () => {
  it("renders a command with no template tags byte-identical", () => {
    const command =
      "claude -p --dangerously-skip-permissions --input-format stream-json --output-format stream-json --verbose";
    const result = renderProviderCommandTemplate(command, {});
    expect(result.rendered).toBe(command);
  });

  it("substitutes a plain {{model}} value tag when model is provided", () => {
    const result = renderProviderCommandTemplate("claude --model {{model}}", {
      model: "claude-opus-4-8"
    });
    expect(result.rendered).toBe("claude --model claude-opus-4-8");
  });

  it("keeps a {{#model}}...{{/model}} section, substituting the inner tag, when model is provided", () => {
    const result = renderProviderCommandTemplate(
      "claude {{#model}}--model {{model}} {{/model}}--verbose",
      { model: "claude-opus-4-8" }
    );
    expect(result.rendered).toBe("claude --model claude-opus-4-8 --verbose");
  });

  it("drops a {{#model}}...{{/model}} section entirely when model is not provided", () => {
    const result = renderProviderCommandTemplate(
      "claude {{#model}}--model {{model}} {{/model}}--verbose",
      {}
    );
    expect(result.rendered).toBe("claude --verbose");
  });

  it("throws ProviderCommandTemplateError for an unrecognized tag", () => {
    expect(() =>
      renderProviderCommandTemplate("claude --model {{modle}}", {
        model: "claude-opus-4-8"
      })
    ).toThrow(ProviderCommandTemplateError);
  });

  it("throws ProviderCommandTemplateError for an unterminated section", () => {
    expect(() =>
      renderProviderCommandTemplate("claude {{#model}}--model {{model}}", {
        model: "claude-opus-4-8"
      })
    ).toThrow(ProviderCommandTemplateError);
  });

  it("throws ProviderCommandTemplateError for a stray closing tag with no opener", () => {
    expect(() =>
      renderProviderCommandTemplate("claude --model {{model}}{{/model}}", {
        model: "claude-opus-4-8"
      })
    ).toThrow(ProviderCommandTemplateError);
  });

  it("lists a provided field as unreferenced when the command never mentions it", () => {
    const result = renderProviderCommandTemplate("claude --verbose", {
      model: "claude-opus-4-8"
    });
    expect(result.unreferencedFields).toEqual(["model"]);
  });

  it("does not list a provided field as unreferenced when the command uses it as a plain tag", () => {
    const result = renderProviderCommandTemplate("claude --model {{model}}", {
      model: "claude-opus-4-8"
    });
    expect(result.unreferencedFields).toEqual([]);
  });

  it("does not list a provided field as unreferenced when the command uses it only as a section", () => {
    const result = renderProviderCommandTemplate(
      "claude {{#model}}--model {{model}}{{/model}}",
      { model: "claude-opus-4-8" }
    );
    expect(result.unreferencedFields).toEqual([]);
  });

  it("never lists a field that was not provided as unreferenced", () => {
    const result = renderProviderCommandTemplate("claude --verbose", {});
    expect(result.unreferencedFields).toEqual([]);
  });

  it("substitutes {{effort}} and {{permission_mode}} the same way as {{model}}", () => {
    const result = renderProviderCommandTemplate(
      "claude --effort {{effort}} --permission-mode {{permission_mode}}",
      { effort: "xhigh", permissionMode: "bypass" }
    );
    expect(result.rendered).toBe(
      "claude --effort xhigh --permission-mode bypass"
    );
  });

  it("renders a realistic composite command with mixed present and absent fields", () => {
    const result = renderProviderCommandTemplate(
      "claude -p {{#model}}--model {{model}} {{/model}}{{#effort}}--effort {{effort}} {{/effort}}--dangerously-skip-permissions --verbose",
      { model: "claude-sonnet-5" }
    );
    expect(result.rendered).toBe(
      "claude -p --model claude-sonnet-5 --dangerously-skip-permissions --verbose"
    );
    expect(result.unreferencedFields).toEqual([]);
  });

  it("never lists permission_mode as unreferenced, even when provided and never mentioned in the command", () => {
    const result = renderProviderCommandTemplate(
      "claude -p --dangerously-skip-permissions --verbose",
      { permissionMode: "bypass" }
    );
    expect(result.unreferencedFields).toEqual([]);
  });

  it("allows a section for one field to contain a tag for a different field", () => {
    const result = renderProviderCommandTemplate(
      "claude {{#model}}--model {{model}} --permission-mode {{permission_mode}}{{/model}}",
      { model: "claude-sonnet-5", permissionMode: "bypass" }
    );
    expect(result.rendered).toBe(
      "claude --model claude-sonnet-5 --permission-mode bypass"
    );
  });
});
