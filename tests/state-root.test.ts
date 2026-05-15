import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveStateRoot } from "../src/state.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true })
    )
  );
});

describe("resolveStateRoot", () => {
  it("defaults the state root beside an explicit service config", async () => {
    const cwd = await makeTempRoot();
    const configPath = path.join(cwd, "symphonika.yml");

    const resolved = resolveStateRoot({ configPath, cwd });

    expect(resolved.configPath).toBe(path.join(cwd, "symphonika.yml"));
    expect(resolved.stateRoot).toBe(path.join(cwd, ".symphonika"));
    expect(resolved.configExists).toBe(false);
  });

  it("uses the initialized user config and XDG state root when no local config exists", async () => {
    const cwd = await makeTempRoot();
    const xdgConfigHome = path.join(cwd, "config");
    const xdgStateHome = path.join(cwd, "state");
    const userConfigPath = path.join(
      xdgConfigHome,
      "symphonika",
      "symphonika.yml"
    );
    await mkdir(path.dirname(userConfigPath), { recursive: true });
    await writeFile(userConfigPath, "providers:\n  codex:\n    command: codex\n");

    const resolved = resolveStateRoot({
      cwd,
      env: {
        XDG_CONFIG_HOME: xdgConfigHome,
        XDG_STATE_HOME: xdgStateHome
      }
    });

    expect(resolved.configPath).toBe(userConfigPath);
    expect(resolved.stateRoot).toBe(path.join(xdgStateHome, "symphonika"));
    expect(resolved.configExists).toBe(true);
  });

  it("honors a relative state root from an existing service config", async () => {
    const cwd = await makeTempRoot();
    const configDir = path.join(cwd, "config");
    const configPath = path.join(configDir, "service.yml");
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, "state:\n  root: ./runtime\n");

    const resolved = resolveStateRoot({ configPath, cwd });

    expect(resolved.configExists).toBe(true);
    expect(resolved.stateRoot).toBe(path.join(configDir, "runtime"));
  });

  it("expands home-relative configured state roots", async () => {
    const cwd = await makeTempRoot();
    const configPath = path.join(cwd, "symphonika.yml");
    const homeDir = path.join(cwd, "home");
    await writeFile(configPath, "state:\n  root: ~/.local/state/symphonika\n");

    const resolved = resolveStateRoot({ configPath, cwd, homeDir });

    expect(resolved.stateRoot).toBe(
      path.join(homeDir, ".local/state/symphonika")
    );
  });
});
