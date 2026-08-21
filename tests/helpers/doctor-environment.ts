import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function prepareDoctorTestEnvironment(
  root: string
): Promise<void> {
  const binDir = path.join(root, "bin");
  await mkdir(binDir, { recursive: true });
  await Promise.all([
    writeExecutable(path.join(binDir, "codex")),
    writeExecutable(path.join(binDir, "gh"))
  ]);

  const codexDir = path.join(root, ".codex");
  await mkdir(codexDir, { recursive: true });
  await writeFile(
    path.join(codexDir, "config.toml"),
    [
      "[profiles.symphonika]",
      'sandbox_mode = "danger-full-access"',
      'approval_policy = "never"',
      ""
    ].join("\n")
  );
}

export function doctorTestEnv(
  root: string,
  additions: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...additions,
    HOME: root,
    PATH: path.join(root, "bin")
  };
  // Overriding HOME is not enough to keep these runs off the host: doctor
  // resolves the installed unit through XDG_CONFIG_HOME first and the Codex
  // profile through CODEX_HOME first, so both must be cleared or the suite
  // reads whatever is installed on the machine running it.
  delete env.XDG_CONFIG_HOME;
  delete env.CODEX_HOME;
  return env;
}

async function writeExecutable(filePath: string): Promise<void> {
  await writeFile(filePath, "#!/bin/sh\nexit 0\n");
  await chmod(filePath, 0o755);
}
