// Hand-rolled FIFO async mutex. Single binary state (`locked`); waiters get
// the lock handed to them by `release()` in FIFO order. Used by RunController
// to serialize the narrowed dispatch claim section (see ADR 0052).

export type AsyncMutex = {
  acquire: () => Promise<void>;
  readonly held: boolean;
  release: () => void;
  tryAcquire: () => boolean;
};

export function createAsyncMutex(): AsyncMutex {
  const waiters: Array<() => void> = [];
  let locked = false;
  return {
    acquire(): Promise<void> {
      if (!locked) {
        locked = true;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    get held(): boolean {
      return locked;
    },
    release(): void {
      const next = waiters.shift();
      if (next !== undefined) {
        next();
        return;
      }
      locked = false;
    },
    tryAcquire(): boolean {
      if (locked) {
        return false;
      }
      locked = true;
      return true;
    }
  };
}
