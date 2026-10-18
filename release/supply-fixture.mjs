import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { buildTinyWithWebEvidence } from "./supply-web-build.mjs";
import { isolated, run, save } from "./supply-internal.mjs";
import { candidateVersion } from "./policy.mjs";

export async function createFixture(directory, vulnerable = false) {
  directory = resolve(directory);
  const layer = join(directory, "root", "app", "node_modules", "lodash");
  await mkdir(layer, { recursive: true });
  const version = vulnerable ? "4.17.15" : "4.18.1";
  await writeFile(
    join(layer, "package.json"),
    JSON.stringify({ name: "lodash", version, license: "MIT" }),
  );
  await writeFile(join(layer, "index.js"), "module.exports = {};\n");
  execFileSync("tar", [
    "-cf",
    join(directory, "layer.tar"),
    "-C",
    join(directory, "root"),
    ".",
  ]);
  const digest = createHash("sha256")
    .update(await readFile(join(directory, "layer.tar")))
    .digest("hex");
  const config = JSON.stringify({
    architecture: "amd64",
    os: "linux",
    config: {},
    rootfs: { type: "layers", diff_ids: [`sha256:${digest}`] },
    history: [{ created_by: "Damadama scanner fixture" }],
  });
  const configName = `${createHash("sha256").update(config).digest("hex")}.json`;
  await writeFile(join(directory, configName), config);
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify([
      {
        Config: configName,
        RepoTags: ["damadama-supply-fixture:latest"],
        Layers: ["layer.tar"],
      },
    ]),
  );
  const archive = join(directory, "image.tar");
  execFileSync("tar", [
    "-cf",
    archive,
    "-C",
    directory,
    "manifest.json",
    configName,
    "layer.tar",
  ]);
  return archive;
}

const fixturePackages = Object.freeze({
  clean: {
    name: "lodash",
    version: "4.18.1",
    integrity:
      "dMInicTPVE8d1e5otfwmmjlxkZoUpiVLwyeTdUsi/Caj/gfzzblBcCE5sRHV/AsjuCmxWrte2TNGSYuCeCq+0Q==",
  },
  vulnerable: {
    name: "lodash",
    version: "4.17.15",
    integrity:
      "8xOcRHvCjnocdS5cpwXQXVzmmh5e5+saE2QGoeQmbKmRS6J3VQppPOIt0MnmE+4xlZoumy0GPG0D0MVIQbNA1A==",
  },
  runtime: {
    name: "is-number",
    version: "7.0.0",
    integrity:
      "41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==",
  },
});

async function installFixturePackage(pin, destination, work) {
  const response = await fetch(
    `https://registry.npmjs.org/${pin.name}/-/${pin.name}-${pin.version}.tgz`,
    { signal: AbortSignal.timeout(60_000), redirect: "error" },
  );
  assert(response.ok, "fixture package download failed");
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    assert(length <= 2 * 1024 * 1024, "fixture package exceeds bound");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  assert.equal(
    createHash("sha512").update(bytes).digest("base64"),
    pin.integrity,
    "fixture package integrity differs",
  );
  const archive = join(work, `${pin.name}-${pin.version}.tgz`);
  await writeFile(archive, bytes);
  await mkdir(destination, { recursive: true });
  run("tar", ["-xzf", archive, "--strip-components=1", "-C", destination]);
}

export async function createPairedFixture(
  directory,
  identity,
  vulnerable = false,
) {
  return isolated(async (context) => {
    const lodash = join(context, "src/web/node_modules/lodash");
    const web = join(context, "src/server/wwwroot");
    await installFixturePackage(
      fixturePackages.clean,
      join(context, "src/node_modules/lodash"),
      context,
    );
    await installFixturePackage(
      vulnerable ? fixturePackages.vulnerable : fixturePackages.clean,
      lodash,
      context,
    );
    await installFixturePackage(
      fixturePackages.runtime,
      join(web, "node_modules/is-number"),
      context,
    );
    await mkdir(join(lodash, "helper"));
    await copyFile(
      join(lodash, "package.json"),
      join(lodash, "helper/package.json"),
    );
    await mkdir(join(lodash, "unversioned"));
    await save(join(lodash, "unversioned/package.json"), { private: true });
    await save(join(context, "src/package.json"), {
      private: true,
      workspaces: ["web"],
      dependencies: { lodash: fixturePackages.clean.version },
    });
    await save(join(context, "src/web/package.json"), {
      private: true,
      dependencies: {
        lodash: vulnerable
          ? fixturePackages.vulnerable.version
          : fixturePackages.clean.version,
      },
    });
    await writeFile(
      join(web, "index.html"),
      "<h1>Paired supply fixture</h1>\n",
    );
    await save(join(web, "release.json"), {
      source: identity.source,
      version: candidateVersion(identity.source),
    });
    await writeFile(
      join(context, "Dockerfile"),
      "FROM scratch AS web\nCOPY src /src\nFROM scratch AS final\nCOPY --from=web /src/server/wwwroot /app/wwwroot\n",
    );
    return buildTinyWithWebEvidence(directory, identity, context);
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(
    await createFixture(process.argv[2], process.argv[3] === "vulnerable"),
  );
}
