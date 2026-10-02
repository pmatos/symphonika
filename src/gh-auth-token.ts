import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const GH_AUTH_TOKEN_TIMEOUT_MS = 5_000;

export type GhAuthTokenReader = () => Promise<string | undefined>;

export const readGhAuthToken: GhAuthTokenReader = async () => {
  try {
    const { stdout } = await execFile(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      { timeout: GH_AUTH_TOKEN_TIMEOUT_MS }
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
};
