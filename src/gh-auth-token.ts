import { execFile } from "node:child_process";

const GH_AUTH_TOKEN_TIMEOUT_MS = 5_000;

export type GhAuthTokenReader = () => Promise<string | undefined>;

export const readGhAuthToken: GhAuthTokenReader = () =>
  new Promise((resolve) => {
    execFile(
      "gh",
      ["auth", "token"],
      { timeout: GH_AUTH_TOKEN_TIMEOUT_MS },
      (error, stdout) => {
        const token = error === null ? stdout.trim() : "";
        resolve(token.length > 0 ? token : undefined);
      }
    );
  });

export async function withGhAuthTokenFallback(
  env: NodeJS.ProcessEnv,
  readToken: GhAuthTokenReader = readGhAuthToken
): Promise<{ env: NodeJS.ProcessEnv; ghTokenUsed: boolean }> {
  if (env.GITHUB_TOKEN !== undefined && env.GITHUB_TOKEN.length > 0) {
    return { env, ghTokenUsed: false };
  }
  const token = await readToken();
  if (token === undefined) {
    return { env, ghTokenUsed: false };
  }
  return { env: { ...env, GITHUB_TOKEN: token }, ghTokenUsed: true };
}
