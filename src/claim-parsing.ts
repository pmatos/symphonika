import type { z } from "zod";

import type { NormalizedProviderEvent } from "./provider.js";

// A leading BOM is stripped first: JSON.parse otherwise rejects an
// otherwise well-formed claim that a file write or shell redirect prefixed
// with one.
export function parseClaimText<T>(
  text: string,
  schema: z.ZodType<T>
): T | null {
  const unprefixed = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let candidate: unknown;
  try {
    candidate = JSON.parse(unprefixed);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// Only the last turn_completed counts; its schema-enforced structuredOutput
// wins, and the final message text is the fallback for providers that cannot
// enforce a schema. A missing or schema-invalid claim is absent.
export function parseFinalMessageClaim<T>(
  events: readonly NormalizedProviderEvent[],
  schema: z.ZodType<T>
): T | null {
  let completed: NormalizedProviderEvent | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "turn_completed") {
      completed = events[index];
      break;
    }
  }
  if (completed === undefined) {
    return null;
  }
  if (completed.structuredOutput !== undefined) {
    const parsed = schema.safeParse(completed.structuredOutput);
    return parsed.success ? parsed.data : null;
  }
  if (typeof completed.result === "string") {
    return parseClaimText(completed.result, schema);
  }
  return null;
}
