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

  it("returns the bare message when the error has no linePos", () => {
    const message = locatedYamlErrorMessage(new Error("plain failure"));
    expect(message).toBe("plain failure");
  });

  it("stringifies a non-Error thrown value", () => {
    const message = locatedYamlErrorMessage("boom");
    expect(message).toBe("boom");
  });
});
