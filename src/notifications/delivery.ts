import type { NotificationMessage, NotificationSink } from "./types.js";

export const DEFAULT_DELIVERY_TIMEOUT_MS = 30_000;

export type NotificationDeliveryResult =
  { state: "sent" } | { error: string; state: "failed" };

export async function deliverNotificationBestEffort(input: {
  message: NotificationMessage;
  sink: NotificationSink;
  timeoutMs?: number;
}): Promise<NotificationDeliveryResult> {
  const timeoutMs = Math.max(1, input.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS);
  const timeoutError = `notification delivery timed out after ${timeoutMs}ms`;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<NotificationDeliveryResult>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve({ error: timeoutError, state: "failed" });
    }, timeoutMs);
  });
  const delivery = (async (): Promise<NotificationDeliveryResult> => {
    let lastError = "notification delivery failed";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await input.sink.deliver(input.message);
        return timedOut
          ? { error: timeoutError, state: "failed" }
          : { state: "sent" };
      } catch (error) {
        if (timedOut) {
          return { error: timeoutError, state: "failed" };
        }
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    return { error: lastError, state: "failed" };
  })();
  const outcome = await Promise.race([delivery, timeout]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  return outcome;
}
