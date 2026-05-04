import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type DaemonEndpoint = {
  pid?: number;
  startedAt?: string;
  stateRoot?: string;
  url: string;
};

export function daemonEndpointPath(stateRoot: string): string {
  return path.join(stateRoot, "daemon.json");
}

export function readDaemonEndpoint(stateRoot: string): DaemonEndpoint | undefined {
  const descriptorPath = daemonEndpointPath(stateRoot);
  if (!existsSync(descriptorPath)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(descriptorPath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.url !== "string" || parsed.url.length === 0) {
    return undefined;
  }

  const endpoint: DaemonEndpoint = { url: parsed.url };
  if (typeof parsed.pid === "number") {
    endpoint.pid = parsed.pid;
  }
  if (typeof parsed.startedAt === "string") {
    endpoint.startedAt = parsed.startedAt;
  }
  if (typeof parsed.stateRoot === "string") {
    endpoint.stateRoot = parsed.stateRoot;
  }
  return endpoint;
}

export async function writeDaemonEndpoint(
  stateRoot: string,
  endpoint: DaemonEndpoint
): Promise<void> {
  await mkdir(stateRoot, { recursive: true });
  await writeFile(
    daemonEndpointPath(stateRoot),
    `${JSON.stringify(endpoint, null, 2)}\n`,
    "utf8"
  );
}

export async function removeDaemonEndpoint(stateRoot: string): Promise<void> {
  await rm(daemonEndpointPath(stateRoot), { force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
