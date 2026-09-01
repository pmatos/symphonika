// Returns whichever settles first: the operation, or a rejection carrying the
// signal's abort reason. Callers that own teardown (a Git process group, a
// reserved concurrency slot) use this to stop *waiting* on a hung await while
// still awaiting the real cleanup afterwards. The abort reason is coerced to
// an Error so a `reject(reason)` never surfaces a bare string to a catch that
// expects `error.message`.
export async function raceAbortSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  abortMessage: string
): Promise<T> {
  if (signal === undefined) {
    return await operation;
  }
  const abortError = (): Error => {
    const reason: unknown = signal.reason;
    return reason instanceof Error
      ? reason
      : new Error(abortMessage, { cause: reason });
  };
  if (signal.aborted) {
    throw abortError();
  }
  let removeAbortListener = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    removeAbortListener();
  }
}
