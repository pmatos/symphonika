// Shared tokenizer for provider command strings. Each provider renders its
// configured command template into a single string (see
// renderProviderCommandTemplate), then splits it into an executable plus argv
// with this parser. Keeping one implementation means the same operator command
// tokenizes identically regardless of provider — the "consistently with
// existing providers" contract in the Oh My Pi provider design spec — rather
// than drifting (codex previously stripped backslashes the others preserved).

export type ProviderLabel = "Claude" | "Codex" | "Oh My Pi";

export type ParsedProviderCommand = {
  args: string[];
  executable: string;
};

export function parseProviderCommand(
  command: string,
  providerLabel: ProviderLabel
): ParsedProviderCommand {
  const parts = splitCommand(command, providerLabel);
  const executable = parts[0];
  if (executable === undefined) {
    throw new Error(`${providerLabel} provider command is empty`);
  }

  return {
    args: parts.slice(1),
    executable
  };
}

function splitCommand(command: string, providerLabel: ProviderLabel): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  const trimmedCommand = command.trim();

  for (let index = 0; index < trimmedCommand.length; index += 1) {
    const character = trimmedCommand[index] ?? "";
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (quote !== undefined) {
      if (character === "\\") {
        const nextCharacter = trimmedCommand[index + 1];
        if (nextCharacter === quote || nextCharacter === "\\") {
          current += nextCharacter;
          index += 1;
        } else {
          current += character;
        }
        continue;
      }

      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "\\") {
      const nextCharacter = trimmedCommand[index + 1];
      if (
        nextCharacter === "'" ||
        nextCharacter === '"' ||
        (nextCharacter !== undefined && /\s/.test(nextCharacter))
      ) {
        escaping = true;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (quote !== undefined) {
    throw new Error(
      `${providerLabel} provider command has an unterminated quote`
    );
  }

  if (current.length > 0) {
    parts.push(current);
  }

  return parts;
}
