import { expect } from "vitest";

// `expect.any` is typed as `any`, which an argument matcher on a typed mock
// rejects. Narrowing it once here keeps the double cast out of every suite
// that asserts a call carried a signal.
export const abortSignalMatcher = expect.any(
  AbortSignal
) as unknown as AbortSignal;
