import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { candidateVersion } from "./policy.mjs";
import {
  realApplicationOrigin,
  tinyFixtureOrigin,
} from "./supply-frontend-origin.mjs";
import {
  dockerArchive,
  frontendFormat,
  ociArchive,
  tarIndex,
} from "./supply-frontend-tar.mjs";
import {
  fileHash,
  hash,
  insist,
  json,
  requireIdentity,
  same,
  tool,
  toolEnvironment,
} from "./supply-internal.mjs";

function parentsAreDirectories(image, name) {
  const parts = name.split("/");
  for (let index = 1; index < parts.length; index++) {
    const parent = image.entries.get(parts.slice(0, index).join("/"));
    assert(parent?.type === "5", "selected image path crosses an alias");
  }
}

async function selectedBytes(image, name, maximum = 20 * 1024 * 1024) {
  parentsAreDirectories(image, name);
  const regular = image.regular(name);
  parentsAreDirectories(image, regular);
  return image.read(regular, maximum);
}

export async function flatten(
  archive,
  output,
  env,
  {
    maximumBytes = frontendFormat.flattenedBytes,
    timeoutMs = frontendFormat.exportTimeoutMs,
  } = {},
) {
  assert(
    Number.isSafeInteger(maximumBytes) &&
      maximumBytes > 0 &&
      maximumBytes <= frontendFormat.flattenedBytes,
  );
  assert(
    Number.isSafeInteger(timeoutMs) &&
      timeoutMs > 0 &&
      timeoutMs <= frontendFormat.exportTimeoutMs,
  );
  const crane = await tool("crane");
  const file = await open(output, "wx", 0o600);
  try {
    const child = spawn(crane.binary, ["export", "-", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    const abort = new AbortController();
    let failure;
    let stderr = Buffer.alloc(0);
    let written = 0;
    const stop = (error) => {
      failure ??= error;
      child.kill("SIGKILL");
      abort.abort(error);
    };
    const closed = new Promise((resolveExit) =>
      child.once("close", resolveExit),
    );
    child.once("error", stop);
    const timer = setTimeout(
      () => stop(new Error("offline Crane export timed out")),
      timeoutMs,
    );
    const bounded = new Transform({
      transform(bytes, encoding, callback) {
        if (written + bytes.length > maximumBytes) {
          callback(new Error("flattened image exceeds bound"));
          return;
        }
        written += bytes.length;
        callback(null, bytes);
      },
    });
    const operations = [];
    const track = (operation) => operations.push(operation.catch(stop));
    try {
      track(
        pipeline(createReadStream(archive), child.stdin, {
          signal: abort.signal,
        }),
      );
      track(
        pipeline(child.stdout, bounded, file.createWriteStream(), {
          signal: abort.signal,
        }),
      );
      track(
        pipeline(
          child.stderr,
          async (stream) => {
            for await (const bytes of stream) {
              assert(
                stderr.length + bytes.length <= frontendFormat.stderrBytes,
                "offline Crane stderr exceeds bound",
              );
              stderr = Buffer.concat([stderr, bytes]);
            }
          },
          { signal: abort.signal },
        ),
      );
      track(
        closed.then((code) => {
          assert.equal(
            code,
            0,
            `offline Crane export failed: ${stderr.subarray(-1000).toString()}`,
          );
        }),
      );
      await Promise.all(operations);
      if (failure) throw failure;
      assert(written > 0, "empty flattened image");
    } catch (error) {
      stop(error);
      throw failure;
    } finally {
      clearTimeout(timer);
      if (failure) child.kill("SIGKILL");
      await Promise.allSettled(operations);
      await closed;
    }
    return crane;
  } finally {
    await file.close();
  }
}

function under(image, root) {
  const prefix = `${root}/`;
  const files = [];
  for (const [name, entry] of image.entries) {
    if (!name.startsWith(prefix)) continue;
    if (entry.type === "5") continue;
    assert(entry.type === "0", "asset root contains alias or directory entry");
    files.push(name);
  }
  return files.sort();
}

async function assets(web, final, source, expectedReleaseHash) {
  const webNames = under(web, "src/server/wwwroot");
  const finalNames = under(final, "app/wwwroot");
  assert(
    webNames.length > 0 && webNames.includes("src/server/wwwroot/index.html"),
  );
  const expected = new Set(["app/wwwroot/release.json"]);
  const values = [];
  for (const name of webNames) {
    const relative = name.slice("src/server/wwwroot/".length);
    assert.notEqual(
      relative,
      "release.json",
      "web stage authored release metadata",
    );
    const destination = `app/wwwroot/${relative}`;
    const bytes = await selectedBytes(web, name);
    assert(
      bytes.equals(await selectedBytes(final, destination)),
      "emitted asset differs",
    );
    expected.add(destination);
    values.push({ path: relative, size: bytes.length, sha256: hash(bytes) });
    if (
      relative === "index.html" ||
      /^assets\/[^/]+\.(?:css|js)$/.test(relative)
    ) {
      for (const extension of ["br", "gz"]) {
        const derived = `${destination}.${extension}`;
        const compressed = await selectedBytes(final, derived);
        const expanded =
          extension === "br"
            ? brotliDecompressSync(compressed, {
                maxOutputLength: 20 * 1024 * 1024,
              })
            : gunzipSync(compressed, { maxOutputLength: 20 * 1024 * 1024 });
        assert(
          expanded.equals(bytes),
          "published compression differs from web asset",
        );
        expected.add(derived);
      }
    }
  }
  assert.deepEqual(
    finalNames,
    [...expected].sort(),
    "unexpected final wwwroot files",
  );
  const release = await selectedBytes(
    final,
    "app/wwwroot/release.json",
    64 * 1024,
  );
  assert.equal(hash(release), expectedReleaseHash, "release metadata differs");
  assert.deepEqual(JSON.parse(release).source, source);
  assert.equal(JSON.parse(release).version, candidateVersion(source));
  return values;
}

async function tinyAssets(web, final, source, expectedReleaseHash) {
  const names = under(web, "src/server/wwwroot");
  assert.deepEqual(
    names.map((name) => name.slice("src/server/wwwroot/".length)),
    [
      "index.html",
      "node_modules/is-number/LICENSE",
      "node_modules/is-number/README.md",
      "node_modules/is-number/index.js",
      "node_modules/is-number/package.json",
      "release.json",
    ],
  );
  assert.deepEqual(
    under(final, "app/wwwroot"),
    names.map((name) => name.replace("src/server/wwwroot/", "app/wwwroot/")),
  );
  const emitted = [];
  for (const name of names) {
    const bytes = await selectedBytes(web, name);
    assert(
      bytes.equals(
        await selectedBytes(
          final,
          name.replace("src/server/wwwroot/", "app/wwwroot/"),
        ),
      ),
      "tiny emitted asset differs",
    );
    emitted.push({
      path: name.slice("src/server/wwwroot/".length),
      size: bytes.length,
      sha256: hash(bytes),
    });
  }
  const release = await selectedBytes(final, "app/wwwroot/release.json");
  assert.equal(
    hash(release),
    expectedReleaseHash,
    "tiny release metadata differs",
  );
  assert.deepEqual(JSON.parse(release), {
    source,
    version: candidateVersion(source),
  });
  const runtime = JSON.parse(
    await selectedBytes(
      final,
      "app/wwwroot/node_modules/is-number/package.json",
    ),
  );
  assert.equal(runtime.name, "is-number");
  assert.equal(runtime.version, "7.0.0");
  return emitted;
}

function npmPurl(name, version) {
  return `pkg:npm/${encodeURIComponent(name).replace(/%2F/gi, "/")}@${encodeURIComponent(version)}`;
}

function installedRoot(path) {
  const parts = path.split("/");
  const modules = parts.lastIndexOf("node_modules");
  if (modules < 0) return false;
  const suffix = parts.slice(modules + 1);
  return (
    (suffix.length === 2 && suffix[1] === "package.json") ||
    (suffix.length === 3 &&
      suffix[0].startsWith("@") &&
      suffix[2] === "package.json")
  );
}

function installedTree(path) {
  return (
    path.startsWith("src/node_modules/") ||
    path.startsWith("src/web/node_modules/")
  );
}

export async function inventoryFromImage(image, projectDirectory) {
  const selected = [...image.entries.keys()]
    .filter(
      (name) =>
        name === "src/package.json" ||
        name === "src/web/package.json" ||
        (installedTree(name) && name.endsWith("/package.json")),
    )
    .sort();
  const installed = [];
  const unversioned = [];
  for (const path of selected) {
    const bytes = await selectedBytes(image, path, 2 * 1024 * 1024);
    const parsed = JSON.parse(bytes);
    assert(parsed && typeof parsed === "object" && !Array.isArray(parsed));
    if (parsed.version === undefined) {
      assert(!installedRoot(path), "installed npm root has no version");
      unversioned.push({ path, sha256: hash(bytes) });
      continue;
    }
    assert(installedTree(path), "versioned workspace manifest");
    assert(
      typeof parsed.name === "string" && parsed.name.trim().length > 0,
      "invalid installed npm name",
    );
    assert(
      typeof parsed.version === "string" && parsed.version.trim().length > 0,
      "invalid installed npm version",
    );
    const location = `/${path.slice("src/".length)}`;
    installed.push({
      path,
      location,
      name: parsed.name,
      version: parsed.version,
      purl: npmPurl(parsed.name, parsed.version),
      sha256: hash(bytes),
    });
    if (projectDirectory) {
      const output = join(
        projectDirectory,
        ...path.slice("src/".length).split("/"),
      );
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, bytes);
    }
  }
  assert(installed.length > 0, "empty installed npm inventory");
  return { installed, unversioned };
}

export function reconcileInstalledNpm(inventory, syft) {
  assert(Array.isArray(syft?.artifacts), "missing raw frontend Syft artifacts");
  const expected = inventory.installed.map(
    ({ location, name, version, purl }) =>
      JSON.stringify([location, name, version, purl]),
  );
  const actual = syft.artifacts.flatMap((item) => {
    assert.equal(item.type, "npm", "unexpected frontend package type");
    assert(Array.isArray(item.locations) && item.locations.length > 0);
    return item.locations.map(({ path }) =>
      JSON.stringify([path, item.name, item.version, item.purl]),
    );
  });
  assert.deepEqual(
    actual.sort(),
    expected.sort(),
    "Syft installed npm inventory differs",
  );
  return inventory.installed.length;
}

export function reconcileInstalledSpdx(inventory, sbom, sourceCommit) {
  const sourceName = "damadama-frontend-installed";
  const rootId = `SPDXRef-DocumentRoot-Directory-${sourceName}`;
  const locationPrefix =
    "acquired package info from installed node module manifest file: ";
  assert.equal(sbom.spdxVersion, "SPDX-2.3");
  assert.equal(sbom.SPDXID, "SPDXRef-DOCUMENT");
  assert.equal(sbom.name, sourceName);
  assert(
    Array.isArray(sbom.packages) &&
      Array.isArray(sbom.files) &&
      Array.isArray(sbom.relationships),
  );
  const ids = new Set([sbom.SPDXID]);
  const register = (item) => {
    assert.match(item.SPDXID, /^SPDXRef-[a-zA-Z0-9.-]+$/);
    assert(!ids.has(item.SPDXID), "duplicate SPDX identifier");
    ids.add(item.SPDXID);
  };
  const files = new Map();
  const fileTuples = [];
  for (const file of sbom.files) {
    register(file);
    assert(!files.has(file.fileName), "duplicate SPDX file location");
    files.set(file.fileName, file.SPDXID);
    const hashes = file.checksums?.filter(
      (entry) => entry.algorithm === "SHA256",
    );
    assert(hashes?.length === 1, "missing SPDX file SHA256");
    fileTuples.push(
      JSON.stringify([`/${file.fileName}`, hashes[0].checksumValue]),
    );
  }
  assert.deepEqual(
    fileTuples.sort(),
    inventory.installed
      .map((item) => JSON.stringify([item.location, item.sha256]))
      .sort(),
    "SPDX manifest files differ",
  );
  const expectedRelationships = [[sbom.SPDXID, "DESCRIBES", rootId]];
  const packages = [];
  let roots = 0;
  for (const item of sbom.packages) {
    register(item);
    const purls = (item.externalRefs ?? []).filter(
      (ref) => ref.referenceType === "purl",
    );
    if (purls.length === 0) {
      roots++;
      assert.equal(item.SPDXID, rootId, "unexpected SPDX root package");
      assert.equal(item.name, sourceName);
      assert.equal(item.versionInfo, sourceCommit);
      assert.equal(item.primaryPackagePurpose, "FILE");
      assert.equal(item.filesAnalyzed, false);
      assert(
        item.sourceInfo === undefined && (item.externalRefs ?? []).length === 0,
      );
      continue;
    }
    assert.equal(purls.length, 1, "ambiguous SPDX package PURL");
    assert.equal(purls[0].referenceCategory, "PACKAGE-MANAGER");
    assert(
      typeof item.sourceInfo === "string" &&
        item.sourceInfo.startsWith(locationPrefix),
      "unsupported SPDX package sourceInfo",
    );
    const location = item.sourceInfo.slice(locationPrefix.length);
    const fileId = files.get(location.slice(1));
    assert(location.startsWith("/") && fileId, "SPDX package location differs");
    packages.push(
      JSON.stringify([
        location,
        item.name,
        item.versionInfo,
        purls[0].referenceLocator,
      ]),
    );
    expectedRelationships.push(
      [rootId, "CONTAINS", item.SPDXID],
      [item.SPDXID, "OTHER", fileId],
    );
  }
  assert.equal(roots, 1, "missing SPDX directory root");
  assert.deepEqual(
    packages.sort(),
    inventory.installed
      .map(({ location, name, version, purl }) =>
        JSON.stringify([location, name, version, purl]),
      )
      .sort(),
    "SPDX installed npm inventory differs",
  );
  const relationships = sbom.relationships.map((relation) => {
    if (relation.relationshipType === "OTHER")
      assert.equal(
        relation.comment,
        "evident-by: indicates the package's existence is evident by the given file",
      );
    return JSON.stringify([
      relation.spdxElementId,
      relation.relationshipType,
      relation.relatedSpdxElement,
    ]);
  });
  assert.deepEqual(
    relationships.sort(),
    expectedRelationships.map((relation) => JSON.stringify(relation)).sort(),
    "SPDX source relationships differ",
  );
  return packages.length;
}

export function reconcileFrontendReport(inventory, sbom, report, sourceCommit) {
  reconcileInstalledSpdx(inventory, sbom, sourceCommit);
  assert(
    report?.source?.type === "directory" &&
      report.source.target === "damadama-frontend-installed",
    "frontend Grype source differs",
  );
  assert(Array.isArray(report.matches), "missing frontend matches");
  assert(
    report.ignoredMatches == null ||
      (Array.isArray(report.ignoredMatches) &&
        report.ignoredMatches.length === 0),
    "filtered or ignored vulnerability matches are forbidden",
  );
  const packages = new Map(sbom.packages.map((item) => [item.SPDXID, item]));
  for (const match of report.matches) {
    const artifact = match.artifact;
    assert(typeof artifact?.id === "string", "missing Grype artifact ID");
    const item = packages.get(`SPDXRef-${artifact.id}`);
    assert(item, "Grype artifact ID lacks SPDX package");
    const purls = (item.externalRefs ?? []).filter(
      (ref) => ref.referenceType === "purl",
    );
    assert.equal(purls.length, 1, "Grype finding references document root");
    assert.equal(artifact.name, item.name, "Grype artifact name differs");
    assert.equal(
      artifact.version,
      item.versionInfo,
      "Grype artifact version differs",
    );
    assert.equal(
      artifact.purl,
      purls[0].referenceLocator,
      "Grype artifact PURL differs",
    );
    assert.equal(artifact.type, "npm", "Grype artifact type differs");
    assert.equal(
      artifact.locations,
      null,
      "unsupported SPDX-derived Grype locations",
    );
  }
  return report.matches.length;
}

export async function reconstructFrontend({
  directory,
  source,
  authority,
  workDirectory,
}) {
  requireIdentity(source, authority);
  const data = resolve(directory);
  await mkdir(workDirectory, { recursive: true });
  const build = await json(join(data, "web-build.json"));
  insist(
    build?.schema === 1 &&
      [
        "real-application-origin-observation",
        "tiny-fixture-origin-observation",
      ].includes(build.purpose),
  );
  insist(same(build.source, source) && same(build.authority, authority));
  insist(build.platform === "linux/amd64");
  const versions = await json(join(data, "builder-versions.json"));
  insist(same(versions, build.builder), "independent builder versions differ");
  insist(
    typeof versions.docker === "string" &&
      versions.docker.length > 0 &&
      typeof versions.buildx === "string" &&
      versions.buildx.length > 0 &&
      typeof versions.dockerBinaryPath === "string" &&
      versions.dockerBinaryPath.startsWith("/") &&
      /^[a-f0-9]{64}$/.test(versions.dockerBinarySha256) &&
      versions.buildxBinarySha256 === null &&
      versions.buildkitImage ===
        "moby/buildkit@sha256:de10faf919fc71ba4eb1dd7bd6449566d012b0c9436b1c61bfee21d621b009aa",
    "unsupported builder observation",
  );
  insist(
    (await fileHash(join(data, "release-metadata.json"))) ===
      build.releaseMetadataSha256,
    "independent release metadata differs",
  );
  const webArchive = join(data, "web-stage.tar");
  const oci = join(data, "web.oci.tar");
  const finalArchive = join(data, "image.tar");
  const webMetadata = join(data, "web.metadata.json");
  const finalMetadata = join(data, "final.metadata.json");
  assert.equal(await fileHash(webMetadata), build.web.metadataSha256);
  assert.equal(await fileHash(finalMetadata), build.final.metadataSha256);
  const ociImage = await ociArchive(oci, build.web.ociArchiveSha256);
  const webImage = await dockerArchive(
    webArchive,
    build.web.dockerArchiveSha256,
  );
  const finalImage = await dockerArchive(
    finalArchive,
    build.final.dockerArchiveSha256,
  );
  assert.deepEqual(ociImage, build.web.descriptor);
  assert.equal(webImage.configDigest, ociImage.configDigest);
  assert.deepEqual(webImage.diffIds, ociImage.diffIds);
  const finalRecord = await json(finalMetadata);
  assert.equal(
    finalRecord["containerimage.config.digest"],
    finalImage.configDigest,
    "final metadata config differs",
  );
  const webRecord = await json(webMetadata);
  assert.equal(
    webRecord["containerimage.config.digest"],
    webImage.configDigest,
    "web metadata config differs",
  );
  const tiny = build.purpose === "tiny-fixture-origin-observation";
  const reconstructOrigin = tiny ? tinyFixtureOrigin : realApplicationOrigin;
  const origin = reconstructOrigin(
    finalRecord["buildx.build.provenance"],
    ociImage.digest,
  );
  if (build.final.origin) assert.deepEqual(build.final.origin, origin);
  const webFlat = join(workDirectory, "web-flat.tar");
  const finalFlat = join(workDirectory, "final-flat.tar");
  const env = {
    ...toolEnvironment(),
    HOME: workDirectory,
    USERPROFILE: workDirectory,
    XDG_CONFIG_HOME: workDirectory,
    XDG_CACHE_HOME: workDirectory,
    TMPDIR: workDirectory,
    TMP: workDirectory,
    TEMP: workDirectory,
  };
  const crane = await flatten(webArchive, webFlat, env);
  await flatten(finalArchive, finalFlat, env, {
    maximumBytes: frontendFormat.finalBytes,
  });
  assert.equal(await fileHash(webArchive), build.web.dockerArchiveSha256);
  assert.equal(await fileHash(finalArchive), build.final.dockerArchiveSha256);
  const web = await tarIndex(webFlat, frontendFormat.flattenedBytes);
  const final = await tarIndex(finalFlat, frontendFormat.finalBytes);
  const reconstructAssets = tiny ? tinyAssets : assets;
  const emitted = await reconstructAssets(
    web,
    final,
    source,
    build.releaseMetadataSha256,
  );
  const projectDirectory = join(workDirectory, "npm-project");
  const inventory = await inventoryFromImage(web, projectDirectory);
  return {
    source,
    authority,
    web: ociImage,
    final: {
      archiveSha256: build.final.dockerArchiveSha256,
      configDigest: finalImage.configDigest,
      diffIds: finalImage.diffIds,
    },
    origin,
    emitted,
    inventory,
    crane: { version: crane.version, sha256: crane.sha256 },
    projectDirectory,
  };
}
