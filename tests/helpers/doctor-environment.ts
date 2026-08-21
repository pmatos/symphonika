import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DoctorReport } from "../../src/doctor.js";

// Stub environment for suites that mock runDoctor outright: they assert CLI
// rendering, not the probes, so every field is a fixed placeholder.
export function doctorEnvironmentFixture(
  overrides: Partial<DoctorReport["environment"]> = {}
): DoctorReport["environment"] {
  return {
    codexProfile: {
      checks: [],
      path: "/home/operator/.codex/config.toml",
      status: "not_required"
    },
    gh: { executablePath: "/usr/bin/gh", status: "authenticated" },
    installedUnit: {
      binaries: [],
      environmentPath: null,
      servicePath: "/home/operator/.config/systemd/user/symphonika.service",
      status: "not_installed"
    },
    providerBinaries: [],
    ...overrides
  };
}

export async function prepareDoctorTestEnvironment(
  root: string
): Promise<void> {
  await writeStubExecutables(path.join(root, "bin"), ["codex", "gh"]);

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

const SUCCESSFUL_STUB = "#!/bin/sh\nexit 0\n";

export async function writeStubExecutables(
  dir: string,
  names: string[],
  body: string = SUCCESSFUL_STUB
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await Promise.all(
    names.map(async (name) => {
      const filePath = path.join(dir, name);
      await writeFile(filePath, body);
      await chmod(filePath, 0o755);
    })
  );
}
