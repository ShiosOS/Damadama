import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileSha256, sha256, verifyImageArchives } from "./current-image.mjs";
import {
  manifestMediaType,
  readOciImage,
  verifyDockerArchive,
} from "./image-archives.mjs";

const encode = (value) => Buffer.from(JSON.stringify(value));
const digest = (bytes) => `sha256:${sha256(bytes)}`;
const blob = (value) => `blobs/sha256/${value.slice(7)}`;
const descriptor = (bytes, mediaType) => ({
  digest: digest(bytes),
  size: bytes.length,
  mediaType,
});

function tar(entries) {
  const blocks = [];
  for (const { name, bytes, type = "0" } of entries) {
    const header = Buffer.alloc(512);
    header.write(name);
    header.write("0000444\0", 100);
    header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("        ", 148);
    header.write(type, 156);
    header.write("ustar\0", 257);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

function fixture({
  configChange,
  manifestChange,
  indexChange,
  entriesChange,
  dockerChange,
} = {}) {
  const layers = ["first", "second"].map((name) =>
    tar([{ name, bytes: Buffer.from(name) }]),
  );
  const config = {
    architecture: "amd64",
    os: "linux",
    rootfs: { type: "layers", diff_ids: layers.map(digest) },
  };
  configChange?.(config);
  const configBytes = encode(config);
  const manifest = {
    schemaVersion: 2,
    mediaType: manifestMediaType,
    config: descriptor(configBytes, "application/vnd.oci.image.config.v1+json"),
    layers: layers.map((bytes) =>
      descriptor(bytes, "application/vnd.oci.image.layer.v1.tar"),
    ),
  };
  manifestChange?.(manifest);
  const manifestBytes = encode(manifest);
  const index = {
    schemaVersion: 2,
    manifests: [descriptor(manifestBytes, manifestMediaType)],
  };
  indexChange?.(index);
  const selected = {
    Config: blob(digest(configBytes)),
    RepoTags: ["fixture:test"],
    Layers: layers.map((bytes) => blob(digest(bytes))),
  };
  dockerChange?.(selected);
  const entries = [
    { name: "oci-layout", bytes: encode({ imageLayoutVersion: "1.0.0" }) },
    { name: "index.json", bytes: encode(index) },
    { name: blob(digest(manifestBytes)), bytes: manifestBytes },
    { name: blob(digest(configBytes)), bytes: configBytes },
    ...layers.map((bytes) => ({ name: blob(digest(bytes)), bytes })),
  ];
  entriesChange?.(entries);
  return {
    oci: tar(entries),
    docker: tar([
      ...entries,
      { name: "manifest.json", bytes: encode([selected]) },
    ]),
    configId: digest(configBytes),
    manifestDigest: digest(manifestBytes),
  };
}

async function usingFixture(options, run) {
  const directory = await mkdtemp(
    resolve(tmpdir(), "damadama-image-boundary-"),
  );
  try {
    const metadata = resolve(directory, "identity.json");
    const value = fixture(options);
    await writeFile(`${metadata}.oci.tar`, value.oci);
    await writeFile(`${metadata}.image.tar`, value.docker);
    await run({ directory, metadata, ...value });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("actual OCI manifest, config and raw layers bind both export archives", async () => {
  await usingFixture({}, async ({ metadata, configId, manifestDigest }) => {
    const image = {
      manifestDigest,
      manifestMediaType,
      configId,
      archiveSha256: await fileSha256(`${metadata}.image.tar`),
      ociArchiveSha256: await fileSha256(`${metadata}.oci.tar`),
    };
    const witness = await verifyImageArchives(image, metadata);
    assert.equal(witness.configId, configId);
    assert.equal(witness.diffIds.length, 2);
    for (const [change, error] of [
      [
        { manifestDigest: `sha256:${"0".repeat(64)}` },
        /OCI manifest digest differs from identity/,
      ],
      [
        { manifestMediaType: "application/vnd.oci.image.index.v1+json" },
        /OCI manifest media type differs/,
      ],
      [{ configId: `sha256:${"0".repeat(64)}` }, /OCI config identity differs/],
      [{ archiveSha256: "0".repeat(64) }, /Docker archive hash differs/],
      [{ ociArchiveSha256: "0".repeat(64) }, /OCI archive hash differs/],
    ])
      await assert.rejects(
        verifyImageArchives({ ...image, ...change }, metadata),
        error,
      );
  });
});

test("OCI content accepts the export directories and explicit supported platform", async () => {
  await usingFixture(
    {
      indexChange: (index) => {
        index.manifests[0].platform = { os: "linux", architecture: "amd64" };
      },
      entriesChange: (entries) => {
        entries.push({ name: "blobs/", bytes: Buffer.alloc(0), type: "5" });
        entries.push({
          name: "blobs/sha256/",
          bytes: Buffer.alloc(0),
          type: "5",
        });
      },
    },
    async ({ metadata }) => {
      const witness = await readOciImage(`${metadata}.oci.tar`);
      await verifyDockerArchive(`${metadata}.image.tar`, witness);
    },
  );
});

for (const [label, options, error] of [
  [
    "altered manifest bytes",
    {
      entriesChange: (entries) => {
        entries[2].bytes[1] ^= 1;
      },
    },
    /OCI archive manifest: blob digest differs/,
  ],
  [
    "altered config bytes",
    {
      entriesChange: (entries) => {
        entries[3].bytes[1] ^= 1;
      },
    },
    /OCI archive config: blob digest differs/,
  ],
  [
    "altered layer bytes",
    {
      entriesChange: (entries) => {
        entries[4].bytes[512] ^= 1;
      },
    },
    /OCI archive layer: blob digest differs/,
  ],
  [
    "wrong descriptor size",
    {
      indexChange: (index) => {
        index.manifests[0].size++;
      },
    },
    /manifest: blob size differs/,
  ],
  [
    "wrong descriptor digest",
    {
      indexChange: (index) => {
        index.manifests[0].digest = "invalid";
      },
    },
    /manifest: invalid descriptor/,
  ],
  [
    "nested image index",
    {
      indexChange: (index) => {
        index.manifests[0].mediaType =
          "application/vnd.oci.image.index.v1+json";
      },
    },
    /manifest: invalid descriptor/,
  ],
  [
    "ambiguous manifests",
    {
      indexChange: (index) => {
        index.manifests.push(index.manifests[0]);
      },
    },
    /require one image manifest/,
  ],
  [
    "foreign descriptor platform",
    {
      indexChange: (index) => {
        index.manifests[0].platform = { os: "linux", architecture: "arm64" };
      },
    },
    /platform must be linux\/amd64/,
  ],
  [
    "foreign config platform",
    {
      configChange: (config) => {
        config.os = "windows";
      },
    },
    /platform must be linux\/amd64/,
  ],
  [
    "config with variant",
    {
      configChange: (config) => {
        config.variant = "v8";
      },
    },
    /platform must be linux\/amd64/,
  ],
  [
    "invalid rootfs",
    {
      configChange: (config) => {
        config.rootfs.type = "foreign";
      },
    },
    /invalid rootfs DiffIDs/,
  ],
  [
    "wrong ordered DiffIDs",
    {
      configChange: (config) => {
        config.rootfs.diff_ids.reverse();
      },
    },
    /layer order differs from config DiffIDs/,
  ],
  [
    "missing layer",
    {
      manifestChange: (manifest) => {
        manifest.layers.pop();
      },
    },
    /layer count differs from config/,
  ],
  [
    "compressed layer",
    {
      manifestChange: (manifest) => {
        manifest.layers[0].mediaType += "+gzip";
      },
    },
    /layer: invalid descriptor/,
  ],
  [
    "artifact instead of image",
    {
      manifestChange: (manifest) => {
        manifest.artifactType = "example/artifact";
      },
    },
    /unsupported image manifest/,
  ],
  [
    "duplicate member",
    {
      entriesChange: (entries) => {
        entries.push(entries[0]);
      },
    },
    /duplicate tar member/,
  ],
  [
    "unexpected member path",
    {
      entriesChange: (entries) => {
        entries[0].name = "../outside";
      },
    },
    /unexpected tar member path/,
  ],
  [
    "symbolic link",
    {
      entriesChange: (entries) => {
        entries[0].type = "2";
      },
    },
    /unsupported tar member type/,
  ],
  [
    "unexpected directory",
    {
      entriesChange: (entries) => {
        entries.push({ name: "outside/", bytes: Buffer.alloc(0), type: "5" });
      },
    },
    /unexpected tar directory/,
  ],
  [
    "missing member",
    {
      entriesChange: (entries) => {
        entries.splice(4, 1);
      },
    },
    /missing required tar member/,
  ],
  [
    "invalid JSON",
    {
      entriesChange: (entries) => {
        entries[1].bytes = Buffer.from("{");
      },
    },
    /invalid JSON member/,
  ],
  [
    "null JSON",
    {
      entriesChange: (entries) => {
        entries[1].bytes = encode(null);
      },
    },
    /invalid JSON member/,
  ],
  [
    "oversized JSON",
    {
      entriesChange: (entries) => {
        entries[1].bytes = Buffer.alloc(2 * 1024 * 1024 + 1, 32);
      },
    },
    /JSON member exceeds size bound/,
  ],
  [
    "unsupported layout",
    {
      entriesChange: (entries) => {
        entries[0].bytes = encode({ imageLayoutVersion: "2.0.0" });
      },
    },
    /unsupported layout/,
  ],
]) {
  test(`OCI content refuses ${label} after outer checksums are recomputed`, async () => {
    await usingFixture(
      options,
      async ({ metadata, configId, manifestDigest }) => {
        const image = {
          configId,
          manifestDigest,
          manifestMediaType,
          archiveSha256: await fileSha256(`${metadata}.image.tar`),
          ociArchiveSha256: await fileSha256(`${metadata}.oci.tar`),
        };
        await assert.rejects(verifyImageArchives(image, metadata), error);
      },
    );
  });
}

test("Docker export refuses foreign config, altered bytes and layer order despite correct outer hashes", async () => {
  await usingFixture({}, async ({ metadata, directory }) => {
    const witness = await readOciImage(`${metadata}.oci.tar`);
    for (const [options, error] of [
      [
        {
          configChange: (config) => {
            config.created = "2026-10-18T00:00:00Z";
          },
        },
        /Docker archive: config bytes differ from OCI image/,
      ],
      [
        {
          dockerChange: (selected) => {
            selected.Config = `blobs/sha256/${"0".repeat(64)}`;
          },
        },
        /Docker archive: config differs from OCI image/,
      ],
      [
        {
          entriesChange: (entries) => {
            entries[3].bytes[1] ^= 1;
          },
        },
        /Docker archive config: blob digest differs/,
      ],
      [
        {
          entriesChange: (entries) => {
            entries[4].bytes[512] ^= 1;
          },
        },
        /Docker archive layer: blob digest differs/,
      ],
      [
        {
          dockerChange: (selected) => {
            selected.Layers.reverse();
          },
        },
        /Docker archive: layer bytes or order differ/,
      ],
      [
        {
          dockerChange: (selected) => {
            selected.Layers.pop();
          },
        },
        /Docker archive: layer count differs/,
      ],
      [
        {
          dockerChange: (selected) => {
            selected.Layers[0] = "../outside";
          },
        },
        /Docker archive: unexpected layer member path/,
      ],
    ]) {
      const path = resolve(directory, "changed.tar");
      await writeFile(path, fixture(options).docker);
      await assert.rejects(verifyDockerArchive(path, witness), error);
    }
  });
});

test("tar framing rejects changed headers, missing terminators and trailing nonzero data", async () => {
  await usingFixture({}, async ({ directory, oci }) => {
    const headerChanged = Buffer.from(oci);
    headerChanged[0] ^= 1;
    const invalidNumber = Buffer.from(oci);
    const truncated = Buffer.from(oci);
    for (const [bytes, number] of [
      [invalidNumber, "invalid-size"],
      [truncated, "77777777777\0"],
    ]) {
      bytes.write(number, 124);
      bytes.write("        ", 148);
      const checksum = bytes
        .subarray(0, 512)
        .reduce((sum, byte) => sum + byte, 0);
      bytes.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    }
    for (const [bytes, error] of [
      [headerChanged, /tar header checksum differs/],
      [invalidNumber, /unsupported tar number/],
      [truncated, /truncated tar member/],
      [oci.subarray(0, oci.length - 1024), /missing tar terminator/],
      [Buffer.concat([oci, Buffer.from("foreign")]), /ambiguous tar trailer/],
    ]) {
      const path = resolve(directory, "framing.tar");
      await writeFile(path, bytes);
      await assert.rejects(readOciImage(path), error);
    }
  });
});

test("tar member count is bounded before reading an oversized index", async () => {
  await usingFixture({}, async ({ directory }) => {
    const path = resolve(directory, "many-members.tar");
    await writeFile(
      path,
      tar(
        Array.from({ length: 8193 }, (_, index) => ({
          name: `blobs/sha256/${index.toString(16).padStart(64, "0")}`,
          bytes: Buffer.alloc(0),
        })),
      ),
    );
    await assert.rejects(readOciImage(path), /too many tar members/);
  });
});
