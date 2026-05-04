import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type DaemonEndpoint = {
  host: string;
  pid: number;
  port: number;
  startedAt: string;
  url: string;
};

export function daemonEndpointPath(stateRoot: string): string {
  return path.join(stateRoot, "daemon.json");
}

export async function writeDaemonEndpoint(
  stateRoot: string,
  endpoint: DaemonEndpoint
): Promise<void> {
  await writeFile(
    daemonEndpointPath(stateRoot),
    `${JSON.stringify(endpoint, null, 2)}\n`,
    "utf8"
  );
}

export async function readDaemonEndpoint(
  stateRoot: string
): Promise<DaemonEndpoint | undefined> {
  let raw: string;
  try {
    raw = await readFile(daemonEndpointPath(stateRoot), "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (!isDaemonEndpoint(parsed)) {
    return undefined;
  }
  return parsed;
}

export async function removeDaemonEndpoint(stateRoot: string): Promise<void> {
  await rm(daemonEndpointPath(stateRoot), { force: true });
}

function isDaemonEndpoint(value: unknown): value is DaemonEndpoint {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.host === "string" &&
    typeof candidate.pid === "number" &&
    typeof candidate.port === "number" &&
    typeof candidate.startedAt === "string" &&
    typeof candidate.url === "string"
  );
}
