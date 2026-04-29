import { Hono } from "hono";

export type HttpAppOptions = {
  stateRoot: string;
  version: string;
  startedAtMs?: number;
  now?: () => number;
};

export function createHttpApp(options: HttpAppOptions): Hono {
  const app = new Hono();
  const startedAtMs = options.startedAtMs ?? Date.now();
  const now = options.now ?? Date.now;

  app.get("/health", (context) =>
    context.json({
      ok: true,
      service: "symphonika",
      version: options.version,
      stateRoot: options.stateRoot,
      uptimeMs: uptimeMs(startedAtMs, now)
    })
  );

  app.get("/api/status", (context) =>
    context.json({
      service: "symphonika",
      state: "idle",
      dispatching: false,
      stateRoot: options.stateRoot,
      uptimeMs: uptimeMs(startedAtMs, now)
    })
  );

  return app;
}

function uptimeMs(startedAtMs: number, now: () => number): number {
  return Math.max(0, now() - startedAtMs);
}
