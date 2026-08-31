// Leaf accessors for reading loosely-typed values out of a parsed Codex
// app-server JSON-RPC message. Kept in their own module so both the process
// loop in `codex.ts` and the pure reducer in `codex-events.ts` can share them
// without either importing the other.

export type JsonObject = Record<string, unknown>;

function field(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) {
    return value[key as keyof typeof value];
  }

  return undefined;
}

export function responseId(value: unknown): string | number | undefined {
  const id = field(value, "id");
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

export function objectField(
  value: unknown,
  key: string
): JsonObject | undefined {
  const valueAtKey = field(value, key);
  if (typeof valueAtKey === "object" && valueAtKey !== null) {
    return valueAtKey as JsonObject;
  }

  return undefined;
}

export function stringField(value: unknown, key: string): string | undefined {
  const valueAtKey = field(value, key);
  if (typeof valueAtKey === "string") {
    return valueAtKey;
  }

  return undefined;
}

export function booleanField(value: unknown, key: string): boolean | undefined {
  const valueAtKey = field(value, key);
  if (typeof valueAtKey === "boolean") {
    return valueAtKey;
  }

  return undefined;
}

export function stringArrayField(value: unknown, key: string): string[] {
  const valueAtKey = field(value, key);
  return Array.isArray(valueAtKey)
    ? valueAtKey.filter((item): item is string => typeof item === "string")
    : [];
}

export function numberField(value: unknown, key: string): number | undefined {
  const valueAtKey = field(value, key);
  if (typeof valueAtKey === "number") {
    return valueAtKey;
  }

  return undefined;
}
