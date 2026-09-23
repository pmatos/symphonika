import type { PollNowResult } from "./http/app.js";

export function createPollNowTrigger(input: {
  enqueueScheduledWork: (work: () => Promise<void>) => void;
  summarize: (kind: PollNowResult["kind"]) => PollNowResult;
  tick: () => Promise<void>;
}): () => Promise<PollNowResult> {
  let pending: Promise<PollNowResult> | undefined;

  return () => {
    if (pending !== undefined) {
      return pending.then((result) => ({ ...result, kind: "coalesced" }));
    }

    const queued = new Promise<PollNowResult>((resolve, reject) => {
      input.enqueueScheduledWork(async () => {
        try {
          await input.tick();
          resolve(input.summarize("queued"));
        } catch (error) {
          const reason =
            error instanceof Error ? error : new Error(String(error));
          reject(reason);
          throw reason;
        }
      });
    });
    pending = queued.finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
