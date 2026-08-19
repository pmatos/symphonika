import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { locatedYamlErrorMessage } from "../src/yaml-errors.js";

describe("locatedYamlErrorMessage", () => {
  it("appends the parser's line and column when the error carries linePos", () => {
    let caught: unknown;
    try {
      parse("a: [1, 2\n");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();

    const message = locatedYamlErrorMessage(caught);

    expect(message).toMatch(/\(line \d+, column \d+\)/);
  });

  it("applies the given line offset", () => {
    let caught: unknown;
    try {
      parse("a: [1, 2\n");
    } catch (error) {
      caught = error;
    }

    const withoutOffset = locatedYamlErrorMessage(caught);
    const withOffset = locatedYamlErrorMessage(caught, 5);
    const [, baseLine] = /\(line (\d+), column \d+\)/.exec(withoutOffset) ?? [];
    const [, offsetLine] = /\(line (\d+), column \d+\)/.exec(withOffset) ?? [];

    expect(Number(offsetLine)).toBe(Number(baseLine) + 5);
  });

  it("reports only the offset-corrected position", () => {
    let caught: unknown;
    try {
      parse("a: [1, 2\n");
    } catch (error) {
      caught = error;
    }

    const message = locatedYamlErrorMessage(caught, 1);

    expect(message.match(/(?:at line|\(line) \d+, column \d+\)?/g)).toEqual([
      "(line 3, column 1)"
    ]);
  });

  it("strips only the real embedded clause, not a coincidental match inside the source snippet", () => {
    let caught: unknown;
    try {
      parse('a: [1, 2\ncomment: "value at line 2, column 1"\n');
    } catch (error) {
      caught = error;
    }

    const message = locatedYamlErrorMessage(caught, 1);

    // The parser's own clause (immediately followed by ":" and the snippet)
    // must be gone; the coincidental text inside the quoted snippet value
    // must survive untouched.
    expect(message).not.toContain(" at line 2, column 1:");
    expect(message).toContain('comment: "value at line 2, column 1"');
    expect(message).toContain("(line 3, column 1)");
  });

  it("preserves coordinate-like text in the parser reason", () => {
    let caught: unknown;
    try {
      parse("a: | at line 1, column 6 trailing\n x\n");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();

    const message = locatedYamlErrorMessage(caught, 1);

    expect(message).toContain(
      "Not a YAML token: at line 1, column 6 trailing:"
    );
    expect(message).toContain("a: | at line 1, column 6 trailing");
    expect(message).toContain("(line 2, column 6)");
  });

  it("returns the bare message when the error has no linePos", () => {
    const message = locatedYamlErrorMessage(new Error("plain failure"));
    expect(message).toBe("plain failure");
  });

  it("stringifies a non-Error thrown value", () => {
    const message = locatedYamlErrorMessage("boom");
    expect(message).toBe("boom");
  });
});
