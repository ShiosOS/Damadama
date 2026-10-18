import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import { arch, platform } from "node:process";
import { join, resolve } from "node:path";
import { queueErrors } from "./workflow-policy.mjs";

const root = resolve(import.meta.dir, "../..");
const toolsDirectory = join(root, ".audit", "workflow-tools");
const fixturesDirectory = join(import.meta.dir, "fixtures");
const platformKey = `${platform}-${arch}`;
const releases = {
  actionlint: {
    version: "1.7.12",
    owner: "rhysd/actionlint",
    assets: {
      "win32-x64": {
        file: "actionlint_1.7.12_windows_amd64.zip",
        sha256:
          "6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9",
      },
      "linux-x64": {
        file: "actionlint_1.7.12_linux_amd64.tar.gz",
        sha256:
          "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
      },
    },
  },
  zizmor: {
    version: "1.31.1",
    owner: "zizmorcore/zizmor",
    assets: {
      "win32-x64": {
        file: "zizmor-x86_64-pc-windows-msvc.zip",
        sha256:
          "4de30371c8a3b483aecbcf0dec1fd6a2b6aae65051ca226b4f6527baac6a8c7a",
      },
      "linux-x64": {
        file: "zizmor-x86_64-unknown-linux-gnu.tar.gz",
        sha256:
          "d185f726bdaf92df78273217dfdd24ebcd6b0ef48cf3ce776ff5762b6e138c99",
      },
    },
  },
};

function run(command, args) {
  const result = Bun.spawnSync([command, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

async function install(name) {
  const release = releases[name];
  const asset = release.assets[platformKey];
  if (!asset) {
    throw new Error(`Unsupported workflow lint platform: ${platformKey}`);
  }

  const archive = join(toolsDirectory, asset.file);
  await mkdir(toolsDirectory, { recursive: true });
  let bytes;
  try {
    bytes = await readFile(archive);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const url = `https://github.com/${release.owner}/releases/download/v${release.version}/${asset.file}`;
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Cannot download ${name}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    const downloaded = `${archive}.download`;
    await Bun.write(downloaded, bytes);
    await rename(downloaded, archive);
  }

  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== asset.sha256) {
    throw new Error(
      `${name} archive SHA-256 mismatch: expected ${asset.sha256}, got ${actual}`,
    );
  }

  const directory = join(toolsDirectory, name);
  await mkdir(directory, { recursive: true });
  const extraction = run("tar", ["-xf", archive, "-C", directory]);
  if (extraction.code !== 0)
    throw new Error(`${name} extraction failed: ${extraction.output}`);
  return join(directory, `${name}${platform === "win32" ? ".exe" : ""}`);
}

function expectFailure(label, result, pattern) {
  if (result.code === 0 || !pattern.test(result.output)) {
    throw new Error(`${label} did not fail as expected:\n${result.output}`);
  }
}

async function selfTest(actionlint, zizmor) {
  const fixture = (name) => join(fixturesDirectory, `${name}.yml`);
  const valid = fixture("valid-queue");
  const validActionlint = run(actionlint, ["-oneline", valid]);
  const validZizmor = run(zizmor, ["--no-online-audits", valid]);
  const validQueue = await queueErrors([valid]);
  if (
    validActionlint.code !== 0 ||
    validZizmor.code !== 0 ||
    validQueue.length
  ) {
    throw new Error(
      `Valid queue fixture failed:\n${validActionlint.output}${validZizmor.output}${validQueue.join("\n")}`,
    );
  }

  expectFailure(
    "actionlint syntax",
    run(actionlint, ["-oneline", fixture("invalid-actionlint")]),
    /unexpected key "bogus".*\[syntax-check\]/,
  );
  expectFailure(
    "zizmor unpinned action",
    run(zizmor, ["--no-online-audits", fixture("invalid-zizmor")]),
    /error\[unpinned-uses\]/,
  );

  const invalidQueue = await queueErrors([fixture("invalid-queue")]);
  if (!invalidQueue.some((error) => error.includes('queue must be "max"'))) {
    throw new Error(`Invalid queue value passed: ${invalidQueue.join("\n")}`);
  }
  const invalidPair = await queueErrors([fixture("invalid-queue-cancel")]);
  if (
    !invalidPair.some((error) =>
      error.includes("queue requires cancel-in-progress"),
    )
  ) {
    throw new Error(
      `Invalid queue/cancel pairing passed: ${invalidPair.join("\n")}`,
    );
  }
  const invalidExpression = await queueErrors([
    fixture("invalid-queue-expression"),
  ]);
  if (
    !invalidExpression.some((error) =>
      error.includes("queue requires cancel-in-progress"),
    )
  ) {
    throw new Error(
      `Invalid queue/cancel expression passed: ${invalidExpression.join("\n")}`,
    );
  }
  console.log(
    "Workflow lint self-test passed: actionlint, zizmor, and queue policy rejected their negative fixtures.",
  );
}

const [actionlint, zizmor] = await Promise.all([
  install("actionlint"),
  install("zizmor"),
]);
if (process.argv[2] === "--self-test") {
  await selfTest(actionlint, zizmor);
} else if (process.argv.length === 2) {
  const directory = join(root, ".github", "workflows");
  const files = (await readdir(directory))
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => join(directory, file));
  const actionlintResult = run(actionlint, ["-oneline", ...files]);
  const zizmorResult = run(zizmor, ["--no-online-audits", directory]);
  const policyErrors = await queueErrors(files);
  if (
    actionlintResult.code !== 0 ||
    zizmorResult.code !== 0 ||
    policyErrors.length
  ) {
    throw new Error(
      `${actionlintResult.output}${zizmorResult.output}${policyErrors.join("\n")}`,
    );
  }
  console.log(
    `Workflow lint passed (${files.length} workflows; actionlint ${releases.actionlint.version}, zizmor ${releases.zizmor.version}).`,
  );
} else {
  throw new Error("Usage: bun .github/ci/workflow-lint.mjs [--self-test]");
}
