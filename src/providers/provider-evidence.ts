import { appendFile } from "node:fs/promises";

import type { NormalizedProviderEvent, ProviderEvent } from "../provider.js";
import { redactValueDeep } from "../redaction.js";
import { encodeRoutineEventIndexRecord } from "../routines/evidence.js";
import type { RunStore } from "../run-store.js";

type EvidencePaths = { normalizedLogPath: string; rawLogPath: string };
type EvidenceWriter = {
  write: (event: ProviderEvent) => Promise<NormalizedProviderEvent | undefined>;
};

// One writer per Attempt/Firing, over files initialized by the caller. Await
// each write before consuming the next event; an append failure stops the
// caller's iteration rather than retrying or rolling back partial evidence.
export function createRunProviderEvidenceWriter(
  input: EvidencePaths & {
    attemptId: string;
    redactSecrets: readonly string[];
    runId: string;
    runStore: Pick<
      RunStore,
      "recordProviderEvent" | "recordProviderStreamReceipt"
    >;
  }
): EvidenceWriter {
  let sequence = 0;
  return {
    async write(event) {
      // Prefer transport ingestion time, before a previous event's file I/O
      // could delay consumer hand-off. Synthesized events use this clock.
      const receivedAt = event.receivedAt ?? new Date().toISOString();
      sequence += 1;
      const redacted = redactEvent(event, input.redactSecrets);
      const receipt = {
        attemptId: input.attemptId,
        receivedAt,
        runId: input.runId,
        sequence
      };
      // ADR 0090: SQLite embeds the payload, so its live watermark must
      // advance before supplementary JSONL appends. A failed append leaves
      // the row intact and still rejects this write. Even serialization
      // happens after the row, preserving that ordering on malformed values.
      if (redacted.normalized === undefined) {
        input.runStore.recordProviderStreamReceipt(receipt);
      } else {
        input.runStore.recordProviderEvent({
          ...receipt,
          normalized: redacted.normalized,
          raw: redacted.raw
        });
      }
      await Promise.all([
        appendJsonl(input.rawLogPath, redacted.raw),
        ...(redacted.normalized === undefined
          ? []
          : [appendJsonl(input.normalizedLogPath, redacted.normalized)])
      ]);
      return event.normalized;
    }
  };
}

export function createRoutineProviderEvidenceWriter(
  input: EvidencePaths & {
    normalizedIndexPath: string;
    redactSecrets: () => readonly string[];
  }
): EvidenceWriter {
  let offset = 0;
  let sequence = 1;
  return {
    async write(event) {
      // Routine credential policy is refreshed for each event; Run policy
      // above remains the Attempt's captured inventory.
      const secrets = input.redactSecrets();
      const redacted =
        secrets.length === 0 ? event : redactEvent(event, secrets);
      if (redacted.normalized === undefined) {
        await appendJsonl(input.rawLogPath, redacted.raw);
      } else {
        const [, nextOffset] = await Promise.all([
          appendJsonl(input.rawLogPath, redacted.raw),
          appendIndexedJsonl({
            filePath: input.normalizedLogPath,
            indexPath: input.normalizedIndexPath,
            offset,
            sequence,
            value: redacted.normalized
          })
        ]);
        offset = nextOffset;
        sequence += 1;
      }
      return event.normalized;
    }
  };
}

function redactEvent(
  event: ProviderEvent,
  secrets: readonly string[]
): Pick<ProviderEvent, "raw" | "normalized"> {
  // Persist redacted copies; classification must receive the original event.
  // A secret such as "process" must never rewrite its lifecycle discriminator.
  return {
    raw: redactValueDeep(event.raw, secrets),
    ...(event.normalized === undefined
      ? {}
      : { normalized: redactValueDeep(event.normalized, secrets) })
  };
}

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await appendFile(filePath, serializeJsonl(value));
}

async function appendIndexedJsonl(input: {
  filePath: string;
  indexPath: string;
  offset: number;
  sequence: number;
  value: unknown;
}): Promise<number> {
  const line = serializeJsonl(input.value);
  const record = encodeRoutineEventIndexRecord(input.offset, input.sequence);
  await Promise.all([
    appendFile(input.filePath, line),
    appendFile(input.indexPath, record)
  ]);
  return input.offset + line.length;
}

function serializeJsonl(value: unknown): Buffer {
  // Redaction has already operated on values, before JSON.stringify escapes
  // quotes, backslashes, and controls. Offsets count these exact UTF-8 bytes.
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}
