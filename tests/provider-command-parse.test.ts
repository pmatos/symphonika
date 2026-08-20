import { describe, expect, it } from "vitest";

import { parseProviderCommand } from "../src/providers/command-parse.js";

describe("parseProviderCommand", () => {
  it("splits a plain command into executable and args", () => {
    expect(parseProviderCommand("claude -p --foo bar", "Claude")).toEqual({
      executable: "claude",
      args: ["-p", "--foo", "bar"]
    });
  });

  it("trims and collapses surrounding and interior whitespace", () => {
    expect(parseProviderCommand("   claude   -p  ", "Claude")).toEqual({
      executable: "claude",
      args: ["-p"]
    });
  });

  it("groups a double-quoted span into a single token", () => {
    expect(parseProviderCommand('claude "hello world"', "Claude")).toEqual({
      executable: "claude",
      args: ["hello world"]
    });
  });

  it("groups a single-quoted span into a single token", () => {
    expect(parseProviderCommand("claude 'a b'", "Claude")).toEqual({
      executable: "claude",
      args: ["a b"]
    });
  });

  it("preserves a backslash in an unquoted executable path", () => {
    // Runtime input: claude\bin -p  ->  executable claude\bin
    expect(parseProviderCommand("claude\\bin -p", "Codex")).toEqual({
      executable: "claude\\bin",
      args: ["-p"]
    });
  });

  it("preserves a backslash inside a quoted token", () => {
    // Runtime input: "a\b"  ->  token a\b
    expect(parseProviderCommand('"a\\b"', "Codex")).toEqual({
      executable: "a\\b",
      args: []
    });
  });

  it("keeps both backslashes in an unquoted doubled backslash", () => {
    // Runtime input: a\\b  ->  a\\b (backslashes are not collapsed outside quotes)
    expect(parseProviderCommand("a\\\\b", "Codex")).toEqual({
      executable: "a\\\\b",
      args: []
    });
  });

  it("collapses a doubled backslash inside a quoted token", () => {
    // Runtime input: "a\\b"  ->  a\b
    expect(parseProviderCommand('"a\\\\b"', "Codex")).toEqual({
      executable: "a\\b",
      args: []
    });
  });

  it("unescapes an escaped quote inside a double-quoted token", () => {
    // Runtime input: "a\"b"  ->  token a"b
    expect(parseProviderCommand('"a\\"b"', "Claude")).toEqual({
      executable: 'a"b',
      args: []
    });
  });

  it("treats a backslash-escaped quote outside quotes as a literal quote", () => {
    // Runtime input: a\"b  ->  single token a"b
    expect(parseProviderCommand('a\\"b', "Claude")).toEqual({
      executable: 'a"b',
      args: []
    });
  });

  it("escapes a backslash-escaped space into the surrounding token", () => {
    // Runtime input: a\ b  ->  single token "a b"
    expect(parseProviderCommand("a\\ b", "Claude")).toEqual({
      executable: "a b",
      args: []
    });
  });

  it("keeps a trailing lone backslash literally", () => {
    // Runtime input: claude\  ->  executable claude\
    expect(parseProviderCommand("claude\\", "Claude")).toEqual({
      executable: "claude\\",
      args: []
    });
  });

  it("preserves escaped quotes inside a quoted JSON argument", () => {
    // Runtime input: --settings "{\"a\":1}"
    expect(
      parseProviderCommand('claude --settings "{\\"a\\":1}"', "Claude")
    ).toEqual({
      executable: "claude",
      args: ["--settings", '{"a":1}']
    });
  });

  it("throws a provider-labelled error for an empty command", () => {
    expect(() => parseProviderCommand("", "Claude")).toThrow(
      "Claude provider command is empty"
    );
  });

  it("throws a provider-labelled error for a whitespace-only command", () => {
    expect(() => parseProviderCommand("   ", "Codex")).toThrow(
      "Codex provider command is empty"
    );
  });

  it("throws a provider-labelled error for an unterminated quote", () => {
    expect(() =>
      parseProviderCommand('claude "unterminated', "Oh My Pi")
    ).toThrow("Oh My Pi provider command has an unterminated quote");
  });
});
