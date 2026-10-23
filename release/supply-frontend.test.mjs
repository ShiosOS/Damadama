import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { candidateVersion } from "./policy.mjs";
import {
  inventoryFromImage,
  reconcileEmittedAssets,
  reconcileInstalledNpm,
  reconcileInstalledSpdx,
  reconcileFrontendReport,
  reconstructFrontend,
} from "./supply-frontend.mjs";
import { dockerArchive, ociArchive, tarIndex } from "./supply-frontend-tar.mjs";
import {
  imageArchives,
  paxRecord,
  sha256,
  tar,
} from "./supply-frontend-fixtures.mjs";

function image(manifests) {
  const entries = new Map();
  const bytes = new Map();
  for (const [path, manifest] of Object.entries(manifests)) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++)
      entries.set(parts.slice(0, index).join("/"), { type: "5" });
    entries.set(path, { type: "0" });
    bytes.set(
      path,
      Buffer.isBuffer(manifest)
        ? manifest
        : Buffer.from(JSON.stringify(manifest)),
    );
  }
  return {
    entries,
    regular: (path) => path,
    read: async (path) => bytes.get(path),
  };
}

test("reconciles published license encodings and refuses missing, altered, or extra assets", async () => {
  const source = {
    repository: "ShiosOS/Damadama",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
  };
  const release = Buffer.from(
    JSON.stringify({ source, version: candidateVersion(source) }),
  );
  const emitted = {
    "index.html": Buffer.from("<main>Damadama</main>"),
    "assets/ui-icons.LICENSE.txt": Buffer.from("ISC and MIT license notices"),
  };
  const web = image(
    Object.fromEntries(
      Object.entries(emitted).map(([path, bytes]) => [
        `src/server/wwwroot/${path}`,
        bytes,
      ]),
    ),
  );
  const published = { "app/wwwroot/release.json": release };
  for (const [path, bytes] of Object.entries(emitted)) {
    const destination = `app/wwwroot/${path}`;
    published[destination] = bytes;
    published[`${destination}.br`] = brotliCompressSync(bytes);
    published[`${destination}.gz`] = gzipSync(bytes);
  }
  const reconcile = (files) =>
    reconcileEmittedAssets(web, image(files), source, sha256(release));
  assert.deepEqual(
    (await reconcile(published)).map(({ path }) => path),
    ["assets/ui-icons.LICENSE.txt", "index.html"],
  );
  for (const extension of ["br", "gz"]) {
    const path = `app/wwwroot/assets/ui-icons.LICENSE.txt.${extension}`;
    const altered = { ...published };
    altered[path] =
      extension === "br"
        ? brotliCompressSync(Buffer.from("changed notice"))
        : gzipSync(Buffer.from("changed notice"));
    await assert.rejects(reconcile(altered), /published compression differs/);
    const missing = { ...published };
    delete missing[path];
    await assert.rejects(reconcile(missing));
  }
  await assert.rejects(
    reconcile({
      ...published,
      "app/wwwroot/assets/unexpected.txt": Buffer.from("unexpected"),
    }),
    /unexpected final wwwroot files/,
  );
});

test("retains helper and workspace manifests while cataloging each versioned installed location", async () => {
  const inventory = await inventoryFromImage(
    image({
      "src/package.json": { name: "application" },
      "src/web/package.json": { name: "web" },
      "src/node_modules/foo/package.json": {
        name: "foo",
        version: "1.2.3",
      },
      "src/node_modules/foo/cjs/package.json": {
        name: "foo",
        version: "1.2.3",
      },
      "src/node_modules/foo/offline/package.json": { name: "foo/offline" },
      "src/node_modules/@bar/baz/package.json": {
        name: "@bar/baz",
        version: "4.5.6",
      },
    }),
  );
  assert.equal(inventory.installed.length, 3);
  assert.equal(inventory.unversioned.length, 3);
  assert.deepEqual(
    inventory.installed.map((item) => item.location),
    [
      "/node_modules/@bar/baz/package.json",
      "/node_modules/foo/cjs/package.json",
      "/node_modules/foo/package.json",
    ],
  );
  assert.equal(
    reconcileInstalledNpm(inventory, {
      artifacts: inventory.installed.map((item) => ({
        type: "npm",
        name: item.name,
        version: item.version,
        purl: item.purl,
        locations: [{ path: item.location }],
      })),
    }),
    3,
  );
  assert.throws(
    () =>
      reconcileInstalledNpm(inventory, {
        artifacts: inventory.installed.slice(1).map((item) => ({
          type: "npm",
          name: item.name,
          version: item.version,
          purl: item.purl,
          locations: [{ path: item.location }],
        })),
      }),
    /inventory differs/,
  );
});

test("missing version at an installed package root refuses coverage", async () => {
  for (const path of [
    "src/node_modules/foo/package.json",
    "src/node_modules/@bar/baz/package.json",
    "src/node_modules/parent/node_modules/child/package.json",
    "src/web/node_modules/foo/package.json",
    "src/web/node_modules/@bar/baz/package.json",
    "src/web/node_modules/parent/node_modules/child/package.json",
  ])
    await assert.rejects(
      inventoryFromImage(image({ [path]: { name: "child" } })),
      /installed npm root has no version/,
    );
});

test("workspace-local conflicts retain exact scanner locations and cannot reconcile a reduced inventory", async () => {
  const manifests = {
    "src/package.json": { private: true, workspaces: ["web"] },
    "src/web/package.json": {
      private: true,
      dependencies: { lodash: "4.17.15" },
    },
    "src/node_modules/lodash/package.json": {
      name: "lodash",
      version: "4.18.1",
    },
    "src/web/node_modules/lodash/package.json": {
      name: "lodash",
      version: "4.17.15",
    },
    "src/web/node_modules/lodash/helper/package.json": {
      name: "lodash",
      version: "4.17.15",
    },
    "src/web/node_modules/lodash/unversioned/package.json": { private: true },
    "src/web/node_modules/@bar/baz/package.json": {
      name: "@bar/baz",
      version: "4.5.6",
    },
    "src/web/node_modules/@bar/baz/node_modules/lodash/package.json": {
      name: "lodash",
      version: "4.17.15",
    },
  };
  const paths = [
    "/node_modules/lodash/package.json",
    "/web/node_modules/@bar/baz/node_modules/lodash/package.json",
    "/web/node_modules/@bar/baz/package.json",
    "/web/node_modules/lodash/helper/package.json",
    "/web/node_modules/lodash/package.json",
  ];
  const entries = new Map();
  for (const [name, manifest] of Object.entries(manifests)) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++)
      entries.set(parts.slice(0, i).join("/"), { type: "5" });
    entries.set(name, { content: JSON.stringify(manifest) });
  }
  entries.set("cache", { type: "5" });
  entries.set("cache/lodash-manifest", {
    content: JSON.stringify(
      manifests["src/web/node_modules/lodash/package.json"],
    ),
  });
  entries.set("src/web/node_modules/lodash/package.json", {
    type: "1",
    link: "cache/lodash-manifest",
  });
  await withTar(
    [...entries].map(([name, entry]) => ({ name, ...entry })),
    async (archive) => {
      const project = archive + "-scanner";
      try {
        const indexed = await tarIndex(archive, 64 * 1024);
        const inventory = await inventoryFromImage(indexed, project);
        assert.deepEqual(
          inventory.installed.map((item) => item.location),
          paths,
        );
        assert.deepEqual(
          inventory.unversioned.map((item) => item.path),
          [
            "src/package.json",
            "src/web/node_modules/lodash/unversioned/package.json",
            "src/web/package.json",
          ],
        );
        for (const path of paths)
          assert.deepEqual(
            JSON.parse(await readFile(join(project, path.slice(1)))),
            manifests[`src${path}`],
          );
        const workspaceRequire = createRequire(
          pathToFileURL(join(project, "web/entry.cjs")),
        );
        const resolved = workspaceRequire.resolve("lodash/package.json");
        assert.equal(
          resolved,
          join(project, "web/node_modules/lodash/package.json"),
        );
        assert.equal(JSON.parse(await readFile(resolved)).version, "4.17.15");
        await assert.rejects(
          access(
            join(project, "web/node_modules/lodash/unversioned/package.json"),
          ),
          /ENOENT/,
        );
        const syft = {
          artifacts: inventory.installed.map((item) => ({
            type: "npm",
            name: item.name,
            version: item.version,
            purl: item.purl,
            locations: [{ path: item.location }],
          })),
        };
        assert.equal(reconcileInstalledNpm(inventory, syft), 5);
        const commit = "a".repeat(40);
        assert.equal(
          reconcileInstalledSpdx(
            inventory,
            spdxFixture(inventory, commit),
            commit,
          ),
          5,
        );
        const reduced = {
          installed: inventory.installed.filter((item) =>
            item.location.startsWith("/node_modules/"),
          ),
        };
        assert.throws(
          () =>
            reconcileInstalledNpm(inventory, {
              artifacts: syft.artifacts.slice(0, 1),
            }),
          /inventory differs/,
        );
        assert.throws(
          () =>
            reconcileInstalledSpdx(
              inventory,
              spdxFixture(reduced, commit),
              commit,
            ),
          /manifest files differ/,
        );
      } finally {
        await rm(project, { recursive: true, force: true });
      }
    },
  );
});

test("workspace manifests keep their semantics and selected workspace aliases refuse", async () => {
  for (const path of ["src/package.json", "src/web/package.json"])
    await assert.rejects(
      inventoryFromImage(
        image({ [path]: { name: "workspace", version: "1.0.0" } }),
      ),
      /versioned workspace manifest/,
    );
  for (const manifest of [
    { name: "", version: "1.0.0" },
    { name: "foo", version: " " },
  ])
    await assert.rejects(
      inventoryFromImage(
        image({ "src/web/node_modules/foo/package.json": manifest }),
      ),
      /invalid installed npm/,
    );
  const entries = [
    { name: "src", type: "5" },
    { name: "src/web", type: "5" },
    { name: "src/web/node_modules", type: "5" },
    { name: "src/web/node_modules/foo", type: "5" },
    {
      name: "src/web/node_modules/foo/package.json",
      type: "2",
      link: "/outside/package.json",
    },
  ];
  await withTar(entries, async (archive) => {
    await assert.rejects(
      inventoryFromImage(await tarIndex(archive, 16 * 1024)),
      /unsupported image alias/,
    );
  });
});

async function withTar(entries, action) {
  const directory = await mkdtemp(join(tmpdir(), "frontend-tar-test-"));
  try {
    const archive = join(directory, "image.tar");
    await writeFile(archive, tar(entries));
    await action(archive);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("bounded tar reader follows only in-image hardlinks", async () => {
  await withTar(
    [
      { name: "cache/manifest", content: '{"name":"foo"}' },
      {
        name: "node_modules/foo/package.json",
        type: "1",
        link: "cache/manifest",
      },
    ],
    async (archive) => {
      const image = await tarIndex(archive, 4096);
      const target = image.regular("node_modules/foo/package.json");
      assert.equal(target, "cache/manifest");
      assert.equal((await image.read(target)).toString(), '{"name":"foo"}');
      assert.throws(() => image.regular("missing"), /missing image file/);
    },
  );
});

test("tar reader rejects traversal, duplicates and missing hardlink targets", async () => {
  for (const entries of [
    [{ name: "../outside", content: "bad" }],
    [{ name: "same" }, { name: "same" }],
  ])
    await withTar(entries, async (archive) => {
      await assert.rejects(tarIndex(archive, 4096));
    });
  await withTar(
    [{ name: "node_modules/foo/package.json", type: "1", link: "absent" }],
    async (archive) => {
      const image = await tarIndex(archive, 4096);
      assert.throws(
        () => image.regular("node_modules/foo/package.json"),
        /missing image file/,
      );
    },
  );
  await withTar([{ name: "one" }, { name: "two" }], async (archive) => {
    await assert.rejects(tarIndex(archive, 4096, 1), /too many tar headers/);
  });
});

test("installed metadata rejects blank strings while preserving accepted version text", async () => {
  for (const field of ["name", "version"]) {
    for (const value of ["", " \t\n", null, 7, {}]) {
      await assert.rejects(
        inventoryFromImage(
          image({
            "src/node_modules/foo/package.json": {
              name: "foo",
              version: "v1.2.3-custom+build",
              [field]: value,
            },
          }),
        ),
        /invalid installed npm/,
      );
    }
  }
  const inventory = await inventoryFromImage(
    image({
      "src/node_modules/foo/package.json": {
        name: "foo",
        version: " v1.2.3-custom+build ",
      },
    }),
  );
  assert.equal(inventory.installed[0].version, " v1.2.3-custom+build ");
});

test("PAX supports exact UTF-8 path and linkpath overrides", async () => {
  const path = `cache/${"long".repeat(30)}-ő`;
  await withTar(
    [
      { name: "pax", type: "x", content: paxRecord("path", path) },
      { name: "placeholder", content: "manifest" },
      {
        name: "pax",
        type: "x",
        content:
          paxRecord("path", "node_modules/foo/package.json") +
          paxRecord("linkpath", path),
      },
      { name: "placeholder", type: "1", link: "placeholder" },
      { name: "usr/lib/local", type: "2", link: "../../lib/local" },
      { name: "usr/bin/local", type: "2", link: "/bin/local" },
    ],
    async (archive) => {
      const index = await tarIndex(archive, 16384);
      assert.equal(
        (
          await index.read(index.regular("node_modules/foo/package.json"))
        ).toString(),
        "manifest",
      );
      assert.equal(index.entries.get("usr/lib/local").link, "../../lib/local");
    },
  );
});

test("PAX refuses unknown and unimplemented semantics and malformed records", async () => {
  const records = [
    ...[
      "size",
      "GNU.sparse.size",
      "GNU.sparse.map",
      "GNU.sparse.name",
      "SCHILY.realsize",
      "SCHILY.xattr.security.capability",
      "uid",
      "mtime",
      "unknown",
    ].map((key) => paxRecord(key, "1")),
    "1e1 path=x\n",
    "+10 path=x\n",
    "010 path=x\n",
    "99 path=x\n",
    "9 path=x!",
    "9 nope=x\n",
    paxRecord("path", "safe") + paxRecord("path", "other"),
    paxRecord("path", "../escape"),
    paxRecord("path", "/absolute"),
    paxRecord("path", "a\0b"),
    paxRecord("path", ""),
    paxRecord("linkpath", "safe"),
  ];
  for (const content of records)
    await withTar(
      [
        { name: "pax", type: "x", content },
        { name: "safe", content: "bytes" },
      ],
      async (archive) => assert.rejects(tarIndex(archive, 4096)),
    );
  for (const type of ["1", "2"])
    for (const link of ["../../escape", "C:/escape", "bad\\path", "bad\0path"])
      await withTar(
        [
          { name: "pax", type: "x", content: paxRecord("linkpath", link) },
          { name: "safe", type },
        ],
        async (archive) => assert.rejects(tarIndex(archive, 4096)),
      );
});

test("Docker preflight bounds each expanded layer and the whole layer set", async () => {
  const directory = await mkdtemp(join(tmpdir(), "frontend-budget-"));
  try {
    const first = tar([{ name: "first", content: "a".repeat(2048) }]);
    const second = tar([{ name: "second", content: "b".repeat(2048) }]);
    const fixture = imageArchives([first, second]);
    const archive = join(directory, "image.tar");
    await writeFile(archive, fixture.docker);
    const identity = sha256(fixture.docker);
    assert.equal(
      (
        await dockerArchive(archive, identity, {
          layerBytes: first.length,
          expandedBytes: first.length + second.length,
        })
      ).layers,
      2,
    );
    await assert.rejects(
      dockerArchive(archive, identity, { layerBytes: first.length - 1 }),
      /layer exceeds supported bound/,
    );
    await assert.rejects(
      dockerArchive(archive, identity, {
        expandedBytes: first.length + second.length - 1,
      }),
      /aggregate bound/,
    );
    const many = imageArchives(
      Array.from({ length: 65 }, (_, index) =>
        tar([{ name: `file-${index}` }]),
      ),
    );
    await writeFile(archive, many.docker);
    await assert.rejects(
      dockerArchive(archive, sha256(many.docker)),
      /unsupported Docker layer count/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function spdxFixture(inventory, commit) {
  const rootId = "SPDXRef-DocumentRoot-Directory-damadama-frontend-installed";
  const root = {
    SPDXID: rootId,
    name: "damadama-frontend-installed",
    versionInfo: commit,
    primaryPackagePurpose: "FILE",
    filesAnalyzed: false,
  };
  return {
    spdxVersion: "SPDX-2.3",
    SPDXID: "SPDXRef-DOCUMENT",
    name: root.name,
    packages: [
      root,
      ...inventory.installed.map((item, index) => ({
        SPDXID: `SPDXRef-Package-${index}`,
        name: item.name,
        versionInfo: item.version,
        sourceInfo: `acquired package info from installed node module manifest file: ${item.location}`,
        externalRefs: [
          {
            referenceType: "purl",
            referenceCategory: "PACKAGE-MANAGER",
            referenceLocator: item.purl,
          },
        ],
      })),
    ],
    files: inventory.installed.map((item, index) => ({
      SPDXID: `SPDXRef-File-${index}`,
      fileName: item.location.slice(1),
      checksums: [{ algorithm: "SHA256", checksumValue: item.sha256 }],
    })),
    relationships: [
      {
        spdxElementId: "SPDXRef-DOCUMENT",
        relationshipType: "DESCRIBES",
        relatedSpdxElement: rootId,
      },
      ...inventory.installed.flatMap((item, index) => [
        {
          spdxElementId: rootId,
          relationshipType: "CONTAINS",
          relatedSpdxElement: `SPDXRef-Package-${index}`,
        },
        {
          spdxElementId: `SPDXRef-Package-${index}`,
          relationshipType: "OTHER",
          relatedSpdxElement: `SPDXRef-File-${index}`,
          comment:
            "evident-by: indicates the package's existence is evident by the given file",
        },
      ]),
    ],
  };
}

test("SPDX reconciles exact package locations, duplicates and source relationships", async () => {
  const inventory = await inventoryFromImage(
    image({
      "src/node_modules/foo/package.json": { name: "foo", version: "1.2.3" },
      "src/node_modules/foo/helper/package.json": {
        name: "foo",
        version: "1.2.3",
      },
    }),
  );
  const commit = "a".repeat(40);
  const spdx = spdxFixture(inventory, commit);
  assert.equal(reconcileInstalledSpdx(inventory, spdx, commit), 2);
  const mutations = [
    (d) => (d.packages[1].name = "wrong"),
    (d) => (d.packages[1].versionInfo = "9.9.9"),
    (d) => (d.packages[1].sourceInfo = d.packages[2].sourceInfo),
    (d) => (d.packages[1].sourceInfo += " trailing"),
    (d) => (d.packages[1].sourceInfo = "/node_modules/foo/package.json"),
    (d) => d.packages.push({ ...d.packages[1], SPDXID: "SPDXRef-Extra" }),
    (d) => d.packages.splice(1, 1),
    (d) => d.packages.push({ SPDXID: "SPDXRef-Unknown", name: "unknown" }),
    (d) => (d.packages[0].name = "wrong"),
    (d) => (d.packages[0].versionInfo = "wrong"),
    (d) => d.packages.shift(),
    (d) => (d.packages[2].SPDXID = d.packages[1].SPDXID),
    (d) => (d.files[0].checksums[0].checksumValue = "b".repeat(64)),
    (d) => (d.relationships[0].relatedSpdxElement = d.packages[1].SPDXID),
    (d) => (d.relationships[2].relatedSpdxElement = d.files[1].SPDXID),
    (d) => d.relationships.pop(),
    (d) => d.relationships.push(d.relationships[0]),
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(spdx);
    mutate(changed);
    assert.throws(() => reconcileInstalledSpdx(inventory, changed, commit));
  }
});

test("internally rehashed archives cannot change the retained metadata config association", async () => {
  const source = {
    repository: "ShiosOS/Damadama",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
  };
  const authority = { sha: source.commit, runId: 1, attempt: 1 };
  const original = imageArchives([
    tar([{ name: "asset", content: "same assets" }]),
  ]);
  const changed = imageArchives(
    [tar([{ name: "asset", content: "same assets" }])],
    { config: { Env: ["CHANGED=1"] } },
  );
  for (const role of ["web", "final"]) {
    const directory = await mkdtemp(join(tmpdir(), "frontend-config-"));
    try {
      const web = role === "web" ? changed : original;
      const final = role === "final" ? changed : original;
      const metadata = Buffer.from(
        JSON.stringify({
          "containerimage.config.digest": original.descriptor.configDigest,
        }),
      );
      const versions = {
        docker: "observed",
        buildx: "observed",
        dockerBinaryPath: "/usr/bin/docker",
        dockerBinarySha256: "a".repeat(64),
        buildxBinarySha256: null,
        buildkitImage:
          "moby/buildkit@sha256:de10faf919fc71ba4eb1dd7bd6449566d012b0c9436b1c61bfee21d621b009aa",
      };
      const build = {
        builder: versions,
        releaseMetadataSha256: sha256("{}"),
        schema: 1,
        purpose: "real-application-origin-observation",
        source,
        authority,
        platform: "linux/amd64",
        web: {
          descriptor: web.descriptor,
          metadataSha256: sha256(metadata),
          ociArchiveSha256: sha256(web.oci),
          dockerArchiveSha256: sha256(web.docker),
        },
        final: {
          metadataSha256: sha256(metadata),
          dockerArchiveSha256: sha256(final.docker),
        },
      };
      for (const [name, bytes] of Object.entries({
        "builder-versions.json": JSON.stringify(versions),
        "release-metadata.json": "{}",
        "web-stage.tar": web.docker,
        "web.oci.tar": web.oci,
        "image.tar": final.docker,
        "web.metadata.json": metadata,
        "final.metadata.json": metadata,
        "web-build.json": JSON.stringify(build),
      }))
        await writeFile(join(directory, name), bytes);
      await assert.rejects(
        reconstructFrontend({
          directory,
          source,
          authority,
          workDirectory: join(directory, "work"),
        }),
        new RegExp(`${role} metadata config differs`),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("OCI preflight recomputes expanded layer identity under the Docker layer budgets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "frontend-oci-"));
  try {
    const layers = [
      tar([{ name: "asset", content: "good" }]),
      tar([{ name: "other", content: "good" }]),
    ];
    const good = imageArchives(layers);
    const archive = join(directory, "image.tar");
    await writeFile(archive, good.oci);
    const inspected = await ociArchive(archive, sha256(good.oci), {
      layerBytes: layers[0].length,
      expandedBytes: layers[0].length + layers[1].length,
    });
    assert.deepEqual(inspected, good.descriptor);
    await assert.rejects(
      ociArchive(archive, sha256(good.oci), {
        layerBytes: layers[0].length - 1,
      }),
      /layer exceeds supported bound/,
    );
    await assert.rejects(
      ociArchive(archive, sha256(good.oci), {
        expandedBytes: layers[0].length + layers[1].length - 1,
      }),
      /aggregate bound/,
    );
    const substituted = imageArchives(
      [tar([{ name: "asset", content: "different" }]), layers[1]],
      { rootfs: { type: "layers", diff_ids: good.descriptor.diffIds } },
    );
    assert.equal(
      substituted.descriptor.configDigest,
      good.descriptor.configDigest,
    );
    await writeFile(archive, substituted.oci);
    await assert.rejects(
      ociArchive(archive, sha256(substituted.oci)),
      /OCI expanded layer DiffID differs/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OCI requires the supported layout, config and compressed layer formats", async () => {
  const directory = await mkdtemp(join(tmpdir(), "frontend-oci-format-"));
  try {
    const layer = tar([{ name: "asset", content: "good" }]);
    const archive = join(directory, "image.tar");
    for (const [options, refusal] of [
      [{ layoutVersion: "1.1.0" }, /unsupported OCI layout version/],
      [{ layoutVersion: null }, /unsupported OCI layout version/],
      [
        { configMediaType: "application/vnd.docker.container.image.v1+json" },
        /unsupported OCI config media type/,
      ],
      [{ configMediaType: null }, /unsupported OCI config media type/],
      [
        { layerMediaType: "application/vnd.oci.image.layer.v1.tar+zstd" },
        /unsupported OCI layer media type/,
      ],
      [
        { layerMediaType: "application/vnd.oci.image.layer.v1.tar" },
        /unsupported OCI layer media type/,
      ],
    ]) {
      const invalid = imageArchives([layer], {}, options);
      await writeFile(archive, invalid.oci);
      await assert.rejects(ociArchive(archive, sha256(invalid.oci)), refusal);
    }
    const invalidRoot = imageArchives([layer], {
      rootfs: { type: "other", diff_ids: [`sha256:${sha256(layer)}`] },
    });
    for (const [bytes, inspect] of [
      [invalidRoot.oci, ociArchive],
      [invalidRoot.docker, dockerArchive],
    ]) {
      await writeFile(archive, bytes);
      await assert.rejects(
        inspect(archive, sha256(bytes)),
        /unsupported image rootfs type/,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SPDX-derived Grype matches join exact IDs while duplicate package locations stay separate", async () => {
  const inventory = await inventoryFromImage(
    image({
      "src/node_modules/foo/package.json": { name: "foo", version: "1.2.3" },
      "src/node_modules/foo/helper/package.json": {
        name: "foo",
        version: "1.2.3",
      },
    }),
  );
  const commit = "a".repeat(40);
  const sbom = spdxFixture(inventory, commit);
  const report = {
    source: { type: "directory", target: "damadama-frontend-installed" },
    ignoredMatches: [],
    matches: sbom.packages.slice(1).map((item) => ({
      artifact: {
        id: item.SPDXID.slice("SPDXRef-".length),
        name: item.name,
        version: item.versionInfo,
        purl: item.externalRefs[0].referenceLocator,
        type: "npm",
        locations: null,
      },
    })),
  };
  assert.equal(reconcileFrontendReport(inventory, sbom, report, commit), 2);
  assert.equal(
    reconcileFrontendReport(
      inventory,
      sbom,
      { ...report, matches: [] },
      commit,
    ),
    0,
  );
  for (const change of [
    { id: "missing" },
    { name: "different" },
    { version: "9.0.0" },
    { purl: "pkg:npm/other@1.2.3" },
    { type: "deb" },
    { locations: [] },
  ]) {
    const altered = structuredClone(report);
    Object.assign(altered.matches[0].artifact, change);
    assert.throws(() =>
      reconcileFrontendReport(inventory, sbom, altered, commit),
    );
  }
  assert.throws(
    () =>
      reconcileFrontendReport(
        inventory,
        sbom,
        { ...report, ignoredMatches: [report.matches[0]] },
        commit,
      ),
    /ignored/,
  );
});
