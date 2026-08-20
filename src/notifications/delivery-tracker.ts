import type { Logger } from "pino";

export class NotificationDeliveryTracker {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly logger?: Logger) {}

  enqueue(deliver: () => Promise<void>): void {
    const task = Promise.resolve()
      .then(deliver)
      .catch((error: unknown) => {
        this.logger?.warn(
          { err: error },
          "symphonika background notification delivery failed"
        );
      });
    this.inFlight.add(task);
    void task.finally(() => {
      this.inFlight.delete(task);
    });
  }

  async settled(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled(Array.from(this.inFlight));
    }
  }
}
