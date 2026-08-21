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
  return {
    ...process.env,
    ...additions,
    HOME: root,
    PATH: path.join(root, "bin")
  };
}

async function writeExecutable(filePath: string): Promise<void> {
  await writeFile(filePath, "#!/bin/sh\nexit 0\n");
  await chmod(filePath, 0o755);
}
