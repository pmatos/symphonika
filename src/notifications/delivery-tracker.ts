import type { Logger } from "pino";

export class NotificationDeliveryTracker {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly logger?: Logger) {}

  enqueue(
    deliver: () => Promise<void>,
    context?: Record<string, unknown>
  ): void {
    const task = Promise.resolve()
      .then(deliver)
      .catch((error: unknown) => {
        this.logger?.warn(
          { ...context, err: error },
          "symphonika background notification delivery failed"
        );
      });
    this.inFlight.add(task);
    // A trailing no-op .catch(): the .catch() above already contains a
    // delivery rejection, so this guards only against that handler itself
    // throwing (e.g. a logging failure), keeping the ADR 0085 guarantee that
    // a background task can never surface as an unhandled rejection.
    void task
      .finally(() => {
        this.inFlight.delete(task);
      })
      .catch(() => undefined);
  }

  async settled(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled(Array.from(this.inFlight));
    }
  }
}
