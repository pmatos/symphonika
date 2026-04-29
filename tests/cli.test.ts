import { describe, expect, it } from "vitest";

import { buildCli } from "../src/cli.js";
import type { StartDaemonOptions } from "../src/daemon.js";
import type { InitProjectOptions } from "../src/doctor.js";

describe("CLI", () => {
  it("starts the daemon with the selected config path and port", async () => {
    const starts: StartDaemonOptions[] = [];
    const program = buildCli({
      registerSignalHandlers: false,
      startDaemon: (options) => {
        starts.push(options);
        return Promise.resolve({
          host: "127.0.0.1",
          port: options.port ?? 3000,
          stateRoot: "/tmp/symphonika",
          stop: () => Promise.resolve(),
          url: "http://127.0.0.1:4001"
        });
      }
    });

    await program.parseAsync([
      "node",
      "symphonika",
      "daemon",
      "--config",
      "custom.yml",
      "--port",
      "4001"
    ]);

    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      configPath: "custom.yml",
      port: 4001
    });
  });

  it("runs init-project with the selected config path and explicit confirmation", async () => {
    const initializations: InitProjectOptions[] = [];
    const output = { stderr: "", stdout: "" };
    const program = buildCli({
      registerSignalHandlers: false,
      runInitProject: (options) => {
        initializations.push(options);
        return Promise.resolve({
          configPath: "/tmp/custom.yml",
          errors: [],
          ok: true,
          projects: [
            {
              createdOperationalLabels: ["sym:running"],
              missingOperationalLabels: ["sym:running"],
              name: "symphonika",
              repository: "pmatos/symphonika"
            }
          ],
          warnings: [
            "init-project will create operational labels in pmatos/symphonika: sym:running"
          ]
        });
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
      "init-project",
      "--config",
      "custom.yml",
      "--yes"
    ]);

    expect(initializations).toHaveLength(1);
    expect(initializations[0]).toMatchObject({
      configPath: "custom.yml",
      yes: true
    });
    expect(output.stderr).toContain("will create operational labels");
    expect(output.stdout).toContain("init-project ok");
    expect(output.stdout).toContain("sym:running");
  });
});
