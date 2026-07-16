import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { buildCli } from "../src/cli.js";
import {
  buildDaemonPath,
  renderServiceUnit,
  renderSliceUnit,
  runServiceInstall,
  type ServiceInstallOptions,
  type ServiceInstallReport
} from "../src/service.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const NODE = "/home/dev/.nvm/versions/node/v22.23.1/bin/node";
const CLI = "/home/dev/symphonika/dist/cli.js";
const DAEMON_PATH = "/home/dev/.nvm/versions/node/v22.23.1/bin:/usr/bin:/bin";

const tempRoots: string[] = [];

async function makeTempHome(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "symphonika-service-test-"));
  tempRoots.push(root);
  return root;
}

function userUnitDir(home: string): string {
  return path.join(home, ".config", "systemd", "user");
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("renderServiceUnit", () => {
  it("binds ExecStart and PATH to the running node runtime and cli.js", () => {
    const unit = renderServiceUnit({
      execPath: NODE,
      path: DAEMON_PATH,
      scriptPath: CLI
    });

    expect(unit).toContain(`exec "$1" "$2" daemon`);
    expect(unit).toContain(`"${NODE}"`);
    expect(unit).toContain(`"${CLI}"`);
    expect(unit).toContain(`Environment="PATH=${DAEMON_PATH}"`);
    expect(unit).toContain("t=$(gh auth token)");
    expect(unit).toContain("Slice=symphonika.slice");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("never hardcodes the ~/.npm-global bin path", () => {
    const unit = renderServiceUnit({
      execPath: NODE,
      path: DAEMON_PATH,
      scriptPath: CLI
    });

    expect(unit).not.toContain(".npm-global");
  });

  it("quotes ExecStart paths so spaces in the runtime or checkout survive", () => {
    const unit = renderServiceUnit({
      execPath: "/home/John Doe/.nvm/node",
      path: DAEMON_PATH,
      scriptPath: "/opt/my app/dist/cli.js"
    });

    expect(unit).toContain(`exec "$1" "$2" daemon`);
    expect(unit).toContain(`"/home/John Doe/.nvm/node"`);
    expect(unit).toContain(`"/opt/my app/dist/cli.js"`);
  });

  it("quotes the Environment=PATH assignment so a spaced PATH entry survives", () => {
    const unit = renderServiceUnit({
      execPath: NODE,
      path: "/home/John Doe/.nvm/bin:/usr/bin",
      scriptPath: CLI
    });

    expect(unit).toContain(
      `Environment="PATH=/home/John Doe/.nvm/bin:/usr/bin"`
    );
  });
});

describe("buildDaemonPath", () => {
  it("prepends the node runtime dir and drops empty and relative entries", () => {
    const result = buildDaemonPath("/opt/node/bin/node", {
      PATH: "/usr/bin::relative/bin:/opt/node/bin:/bin"
    });
    const entries = result.split(path.delimiter);

    expect(entries[0]).toBe("/opt/node/bin");
    expect(entries).not.toContain("");
    expect(entries).not.toContain("relative/bin");
    expect(entries.filter((entry) => entry === "/opt/node/bin")).toHaveLength(
      1
    );
    expect(entries).toContain("/usr/bin");
  });

  it("falls back to a sane PATH when the environment has none", () => {
    const result = buildDaemonPath("/opt/node/bin/node", {});

    expect(result).toBe("/opt/node/bin:/usr/local/bin:/usr/bin:/bin");
  });
});

describe("renderSliceUnit", () => {
  it("stays in sync with systemd/symphonika.slice on disk", async () => {
    const onDisk = await readFile(
      path.join(repoRoot, "systemd", "symphonika.slice"),
      "utf8"
    );

    expect(renderSliceUnit()).toBe(onDisk);
  });
});

describe("runServiceInstall", () => {
  const baseOptions = {
    env: { PATH: "/opt/node/bin:/usr/bin" },
    execPath: "/opt/node/bin/node",
    scriptPath: "/opt/symphonika/dist/cli.js"
  };

  it("writes both unit files under ~/.config/systemd/user and reloads", async () => {
    const home = await makeTempHome();
    let reloadCalls = 0;
    const report = await runServiceInstall({
      ...baseOptions,
      homeDir: home,
      runReload: () => {
        reloadCalls += 1;
        return Promise.resolve();
      }
    });

    expect(report.ok).toBe(true);
    expect(report.reloaded).toBe(true);
    expect(report.reloadError).toBeNull();
    expect(reloadCalls).toBe(1);

    const unitDir = userUnitDir(home);
    const service = await readFile(
      path.join(unitDir, "symphonika.service"),
      "utf8"
    );
    const slice = await readFile(
      path.join(unitDir, "symphonika.slice"),
      "utf8"
    );
    expect(service).toContain(`exec "$1" "$2" daemon`);
    expect(service).toContain(`"/opt/node/bin/node"`);
    expect(service).toContain(`"/opt/symphonika/dist/cli.js"`);
    expect(service).not.toContain(".npm-global");
    expect(slice).toBe(renderSliceUnit());
  });

  it("honors an absolute XDG_CONFIG_HOME for the unit directory", async () => {
    const home = await makeTempHome();
    const xdg = path.join(home, "custom-config");

    const report = await runServiceInstall({
      ...baseOptions,
      env: { PATH: "/opt/node/bin:/usr/bin", XDG_CONFIG_HOME: xdg },
      homeDir: home,
      runReload: () => Promise.resolve()
    });

    expect(report.ok).toBe(true);
    expect(report.unitDir).toBe(path.join(xdg, "systemd", "user"));
    await expect(
      readFile(path.join(xdg, "systemd", "user", "symphonika.service"), "utf8")
    ).resolves.toContain("daemon");
  });

  it("ignores a relative XDG_CONFIG_HOME and falls back to ~/.config", async () => {
    const home = await makeTempHome();

    const report = await runServiceInstall({
      ...baseOptions,
      env: {
        PATH: "/opt/node/bin:/usr/bin",
        XDG_CONFIG_HOME: "relative/config"
      },
      homeDir: home,
      runReload: () => Promise.resolve()
    });

    expect(report.unitDir).toBe(path.join(home, ".config", "systemd", "user"));
  });

  it("refuses to overwrite existing units without force", async () => {
    const home = await makeTempHome();
    const unitDir = userUnitDir(home);
    await mkdir(unitDir, { recursive: true });
    await writeFile(path.join(unitDir, "symphonika.service"), "OLD", "utf8");
    let reloadCalls = 0;

    const report = await runServiceInstall({
      ...baseOptions,
      homeDir: home,
      runReload: () => {
        reloadCalls += 1;
        return Promise.resolve();
      }
    });

    expect(report.ok).toBe(false);
    expect(report.errors.join("\n")).toContain("already exists");
    expect(reloadCalls).toBe(0);
    expect(
      await readFile(path.join(unitDir, "symphonika.service"), "utf8")
    ).toBe("OLD");
  });

  it("overwrites existing units with force", async () => {
    const home = await makeTempHome();
    const unitDir = userUnitDir(home);
    await mkdir(unitDir, { recursive: true });
    await writeFile(path.join(unitDir, "symphonika.service"), "OLD", "utf8");

    const report = await runServiceInstall({
      ...baseOptions,
      force: true,
      homeDir: home,
      runReload: () => Promise.resolve()
    });

    expect(report.ok).toBe(true);
    const service = await readFile(
      path.join(unitDir, "symphonika.service"),
      "utf8"
    );
    expect(service).not.toBe("OLD");
    expect(service).toContain("daemon");
  });

  it("prints without writing or reloading when print is set", async () => {
    const home = await makeTempHome();
    let reloadCalls = 0;

    const report = await runServiceInstall({
      ...baseOptions,
      homeDir: home,
      print: true,
      runReload: () => {
        reloadCalls += 1;
        return Promise.resolve();
      }
    });

    expect(report.printed).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.files).toHaveLength(2);
    expect(reloadCalls).toBe(0);
    await expect(access(path.join(home, ".config"))).rejects.toThrow();
  });

  it("skips daemon-reload when reload is false but still writes units", async () => {
    const home = await makeTempHome();
    let reloadCalls = 0;

    const report = await runServiceInstall({
      ...baseOptions,
      homeDir: home,
      reload: false,
      runReload: () => {
        reloadCalls += 1;
        return Promise.resolve();
      }
    });

    expect(report.ok).toBe(true);
    expect(report.reloaded).toBe(false);
    expect(reloadCalls).toBe(0);
    expect(
      await readFile(path.join(userUnitDir(home), "symphonika.service"), "utf8")
    ).toContain("daemon");
  });

  it("still succeeds and surfaces the error when daemon-reload fails", async () => {
    const home = await makeTempHome();

    const report = await runServiceInstall({
      ...baseOptions,
      homeDir: home,
      runReload: () => Promise.reject(new Error("systemctl: command not found"))
    });

    expect(report.ok).toBe(true);
    expect(report.reloaded).toBe(false);
    expect(report.reloadError).toContain("systemctl");
    expect(
      await readFile(path.join(userUnitDir(home), "symphonika.service"), "utf8")
    ).toContain("daemon");
  });
});

describe("CLI service install", () => {
  function successReport(
    overrides: Partial<ServiceInstallReport> = {}
  ): ServiceInstallReport {
    return {
      errors: [],
      files: [
        {
          content: "svc",
          path: "/home/u/.config/systemd/user/symphonika.service"
        },
        {
          content: "slc",
          path: "/home/u/.config/systemd/user/symphonika.slice"
        }
      ],
      ok: true,
      printed: false,
      reloaded: true,
      reloadError: null,
      unitDir: "/home/u/.config/systemd/user",
      ...overrides
    };
  }

  it("reports written files and reload on success", async () => {
    const output = { stderr: "", stdout: "" };
    const program = buildCli({
      registerSignalHandlers: false,
      runServiceInstall: () => Promise.resolve(successReport())
    });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });

    await program.parseAsync(["node", "symphonika", "service", "install"]);

    expect(output.stdout).toContain("service install ok");
    expect(output.stdout).toContain(
      "wrote:  /home/u/.config/systemd/user/symphonika.service"
    );
    expect(output.stdout).toContain("systemctl --user daemon-reload");
    expect(output.stdout).toContain(
      "systemctl --user enable --now symphonika.service"
    );
  });

  it("maps --force and --no-reload to install options", async () => {
    let received: ServiceInstallOptions | undefined;
    const program = buildCli({
      registerSignalHandlers: false,
      runServiceInstall: (options) => {
        received = options;
        return Promise.resolve(successReport());
      }
    });
    program.configureOutput({
      writeErr: () => undefined,
      writeOut: () => undefined
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "service",
      "install",
      "--force",
      "--no-reload"
    ]);

    expect(received?.force).toBe(true);
    expect(received?.print).toBe(false);
    expect(received?.reload).toBe(false);
  });

  it("streams unit contents to stdout when --print is passed", async () => {
    const output = { stderr: "", stdout: "" };
    let received: ServiceInstallOptions | undefined;
    const program = buildCli({
      registerSignalHandlers: false,
      runServiceInstall: (options) => {
        received = options;
        return Promise.resolve(
          successReport({
            files: [{ content: "UNIT-BODY\n", path: "/x/symphonika.service" }],
            printed: true,
            reloaded: false
          })
        );
      }
    });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "service",
      "install",
      "--print"
    ]);

    expect(received?.force).toBe(false);
    expect(received?.print).toBe(true);
    expect(received?.reload).toBe(true);
    expect(output.stdout).toContain("# /x/symphonika.service");
    expect(output.stdout).toContain("UNIT-BODY");
    expect(output.stdout).not.toContain("service install ok");
  });

  it("warns but succeeds when daemon-reload fails", async () => {
    const output = { stderr: "", stdout: "" };
    const program = buildCli({
      registerSignalHandlers: false,
      runServiceInstall: () =>
        Promise.resolve(
          successReport({
            reloadError: "systemctl: command not found",
            reloaded: false
          })
        )
    });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });

    await program.parseAsync(["node", "symphonika", "service", "install"]);

    expect(output.stdout).toContain("service install ok");
    expect(output.stderr).toContain("daemon-reload failed");
  });

  it("exits non-zero when the install refuses to clobber", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const output = { stderr: "", stdout: "" };
    const program = buildCli({
      registerSignalHandlers: false,
      runServiceInstall: () =>
        Promise.resolve(
          successReport({
            errors: [
              "/home/u/.config/systemd/user/symphonika.service already exists; pass --force to overwrite it"
            ],
            files: [],
            ok: false,
            reloaded: false
          })
        )
    });
    program.configureOutput({
      writeErr: (message) => {
        output.stderr += message;
      },
      writeOut: (message) => {
        output.stdout += message;
      }
    });

    try {
      await program.parseAsync(["node", "symphonika", "service", "install"]);

      expect(process.exitCode).toBe(1);
      expect(output.stderr).toContain("service install failed");
      expect(output.stderr).toContain("already exists");
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
