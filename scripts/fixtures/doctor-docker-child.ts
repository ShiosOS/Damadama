import assert from "node:assert/strict";
import { captureCommand, doctor } from "../doctor";

const executable = process.env["DAMADAMA_DOCKER_CLI"];
assert.ok(executable);
const mode = process.argv[2];
const timeoutMs = Number(process.env["DAMADAMA_DOCKER_TIMEOUT_MS"] ?? "10000");
let observation: Awaited<ReturnType<typeof captureCommand>> | undefined;
let selected: string[] = [];

if (mode === "control") {
  assert.equal(
    process.platform,
    "win32",
    "Old info is isolated only on Windows.",
  );
  observation = await captureCommand(
    [
      executable,
      "info",
      "--format",
      '{{.OSType}} {{range .ClientInfo.Plugins}}{{if eq .Name "doctorprobe"}}{{.Vendor}} {{.Version}} {{.Err}}{{end}}{{end}}',
    ],
    { timeoutMs },
  );
  console.info(JSON.stringify({ observation }));
} else if (mode === "plugin") {
  observation = await captureCommand([executable, "doctorprobe"], {
    timeoutMs,
  });
  console.info(JSON.stringify({ observation }));
} else if (mode === "identity") {
  observation = await captureCommand([executable, "--version"], { timeoutMs });
  console.info(JSON.stringify({ observation }));
} else {
  assert.ok(mode === "doctor" || mode === "nonzero");
  const result = await doctor({
    args: ["backend"],
    environment: {},
    capture: async (command) => {
      if (command[0] !== "docker") {
        const output = { bun: "1.4.3", dotnet: "10.0.113", node: "v24.21.0" };
        if (
          command[0] === "bun" ||
          command[0] === "dotnet" ||
          command[0] === "node"
        )
          return { kind: "ok", output: output[command[0]] };
        throw new Error("Unexpected runtime observation.");
      }
      selected = command.slice(1);
      assert.ok(
        process.platform === "win32" || command[1] !== "info",
        "The Linux fixture refuses info before it can discover installed system plugins.",
      );
      let docker = command;
      if (mode === "nonzero") {
        docker = [
          "docker",
          "version",
          "--format",
          '{{print "linux"}}{{.Server.DoesNotExist}}',
        ];
      }
      observation = await captureCommand([executable, ...docker.slice(1)], {
        timeoutMs,
      });
      return observation;
    },
  });
  assert.ok(observation);
  console.info(
    JSON.stringify({
      result,
      selected,
      captureKind: observation.kind,
      linuxOutput: observation.kind === "ok" && observation.output === "linux",
    }),
  );
}
