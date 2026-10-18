import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  flatten,
  inventoryFromImage,
  reconcileInstalledNpm,
  reconcileInstalledSpdx,
  reconstructFrontend,
} from "./supply-frontend.mjs";
import {
  dockerArchive,
  frontendFormat,
  tarIndex,
} from "./supply-frontend-tar.mjs";
import {
  imageArchives,
  paxRecord,
  sha256,
  tar,
} from "./supply-frontend-fixtures.mjs";
import { fileHash, toolEnvironment } from "./supply-internal.mjs";

const corpus = resolve(process.argv[2]);
const destination = resolve(process.argv[3]);
await mkdir(destination, { recursive: true });
const work = await mkdtemp(join(destination, "run-"));
const env = {
  ...toolEnvironment(),
  HOME: work,
  USERPROFILE: work,
  TMP: work,
  TEMP: work,
  TMPDIR: work,
  XDG_CONFIG_HOME: work,
  XDG_CACHE_HOME: work,
};
const receipts = [];
const record = (name, result) => {
  receipts.push({ name, ...result });
  console.log(JSON.stringify(receipts.at(-1)));
};
async function refuse(name, action, expected) {
  let refusal;
  await assert.rejects(action, (error) => {
    assert.match(error.message, expected);
    refusal = { message: error.message, code: error.code };
    return true;
  });
  record(name, refusal);
}
async function fixture(name, layers) {
  const image = imageArchives(layers.map((entries) => tar(entries)));
  const input = join(work, `${name}.tar`);
  await writeFile(input, image.docker);
  await dockerArchive(input, sha256(image.docker));
  return { input, output: join(work, `${name}-flat.tar`) };
}
const native = await fixture("layers", [
  [
    { name: "replace", content: "old" },
    { name: "deleted", content: "old" },
    { name: "opaque", type: "5" },
    { name: "opaque/old", content: "old" },
    { name: "cache", type: "5" },
    {
      name: "cache/package.json",
      content: '{"name":"fixture","version":"1.2.3"}',
    },
    { name: "src", type: "5" },
    { name: "src/node_modules", type: "5" },
    { name: "src/node_modules/fixture", type: "5" },
    {
      name: "src/node_modules/fixture/package.json",
      type: "1",
      link: "cache/package.json",
    },
    { name: "cache/relative", type: "2", link: "../replace" },
  ],
  [
    { name: "replace", content: "new" },
    { name: ".wh.deleted" },
    { name: "opaque/new", content: "new" },
    { name: "opaque/.wh..wh..opq" },
  ],
]);
const crane = await flatten(native.input, native.output, env);
const index = await tarIndex(native.output, frontendFormat.flattenedBytes);
assert.equal((await index.read("replace")).toString(), "new");
assert.equal((await index.read("opaque/new")).toString(), "new");
for (const name of [
  "deleted",
  ".wh.deleted",
  "opaque/old",
  "opaque/.wh..wh..opq",
])
  assert(!index.entries.has(name));
assert.equal(index.entries.get("cache/relative").link, "../replace");
assert.equal((await inventoryFromImage(index)).installed.length, 1);
record("native layers and links", {
  crane,
  replacement: true,
  whiteout: true,
  opaqueWhiteout: true,
  hardlinkInventory: true,
  inImageSymlink: true,
});
await refuse(
  "exclusive output",
  () => flatten(native.input, native.output, env),
  /EEXIST/,
);
await refuse(
  "stdin I/O",
  () => flatten(join(work, "absent.tar"), join(work, "missing-flat.tar"), env),
  /ENOENT/,
);
await writeFile(join(work, "invalid.tar"), "invalid archive");
await refuse(
  "native process error",
  () => flatten(join(work, "invalid.tar"), join(work, "invalid-flat.tar"), env),
  /offline Crane export failed/,
);
await refuse(
  "timeout",
  () =>
    flatten(
      join(corpus, "web-stage.tar"),
      join(work, "timeout-flat.tar"),
      env,
      { timeoutMs: 1 },
    ),
  /timed out/,
);
const overflow = join(work, "overflow-flat.tar");
await refuse(
  "streaming overflow",
  () => flatten(native.input, overflow, env, { maximumBytes: 1024 }),
  /flattened image exceeds bound/,
);
const actualBytes = (await stat(overflow)).size;
assert(actualBytes <= 1024);
assert((await stat(native.output)).size > 1024);
record("output cap", {
  maximumBytes: 1024,
  actualBytes,
  completeBytes: (await stat(native.output)).size,
});
for (const [name, path] of [
  ["traversal", "../escape"],
  ["drive path", "C:/escape"],
]) {
  const hazard = await fixture(name, [[{ name: path, content: "bad" }]]);
  await refuse(
    name,
    () => flatten(hazard.input, hazard.output, env),
    /offline Crane export failed/,
  );
}
const noisy = await fixture("noisy", [
  [
    {
      name: "pax",
      type: "x",
      content: paxRecord("path", `../${"ő".repeat(40000)}`),
    },
    { name: "unsafe", content: "bad" },
  ],
]);
await refuse(
  "stderr byte cap",
  () => flatten(noisy.input, noisy.output, env),
  /stderr exceeds bound/,
);
const extended = await fixture("extended", [
  [
    {
      name: "pax",
      type: "x",
      content: paxRecord("SCHILY.xattr.user.test", "unsupported"),
    },
    { name: "extended", content: "data" },
  ],
]);
await flatten(extended.input, extended.output, env);
await refuse(
  "unsupported native PAX extension",
  () => tarIndex(extended.output, frontendFormat.flattenedBytes),
  /unsupported PAX key SCHILY.xattr.user.test/,
);
const alias = await fixture("alias", [
  [
    { name: "src", type: "5" },
    { name: "src/node_modules", type: "5" },
    { name: "src/node_modules/foo", type: "5" },
    {
      name: "src/node_modules/foo/package.json",
      type: "2",
      link: "/outside/package.json",
    },
  ],
]);
await flatten(alias.input, alias.output, env);
const aliasIndex = await tarIndex(alias.output, frontendFormat.flattenedBytes);
await refuse(
  "selected symlink",
  () => inventoryFromImage(aliasIndex),
  /unsupported image alias/,
);

const build = JSON.parse(
  await readFile(join(corpus, "web-build.json"), "utf8"),
);
const reconstructed = await reconstructFrontend({
  directory: corpus,
  source: build.source,
  authority: build.authority,
  workDirectory: join(work, "application"),
});
const rawDirectory = join(corpus, "scan-application");
const before = {};
for (const name of ["syft.json", "sbom.spdx.json", "scan.json"])
  before[name] = await fileHash(join(rawDirectory, name));
const syft = JSON.parse(
  await readFile(join(rawDirectory, "syft.json"), "utf8"),
);
const spdx = JSON.parse(
  await readFile(join(rawDirectory, "sbom.spdx.json"), "utf8"),
);
assert.equal(reconcileInstalledNpm(reconstructed.inventory, syft), 420);
assert.equal(
  reconcileInstalledSpdx(reconstructed.inventory, spdx, build.source.commit),
  420,
);
assert.equal(reconstructed.inventory.unversioned.length, 151);
assert.equal(reconstructed.emitted.length, 8);
const report = JSON.parse(
  await readFile(join(rawDirectory, "scan.json"), "utf8"),
);
assert.equal(report.source.type, "directory");
assert.equal(report.source.target, "damadama-frontend-installed");
for (const name of Object.keys(before))
  assert.equal(await fileHash(join(rawDirectory, name)), before[name]);
record("original application reconstruction and retained reconciliation", {
  installed: 420,
  unversioned: 151,
  observations: 571,
  assets: 8,
  web: reconstructed.web,
  final: reconstructed.final,
  rawHashes: before,
  findings: report.matches.map((match) => ({
    id: match.vulnerability.id,
    severity: match.vulnerability.severity,
    package: match.artifact.name,
    version: match.artifact.version,
  })),
});
const sha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const sourceStatus = execFileSync("git", ["status", "--porcelain"], {
  encoding: "utf8",
}).trim();
await writeFile(
  join(work, "receipt.json"),
  JSON.stringify({ sha, sourceStatus, receipts }, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    sha,
    sourceStatus,
    receipt: join(work, "receipt.json"),
    status: "incomplete",
    coverage: "unsigned observations only",
  }),
);
