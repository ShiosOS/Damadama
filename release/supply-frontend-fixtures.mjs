import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export function tar(entries) {
  const blocks = [];
  for (const { name, type = "0", content = "", link = "" } of entries) {
    const bytes = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write(link, 157, 100);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, bytes);
    if (bytes.length % 512)
      blocks.push(Buffer.alloc(512 - (bytes.length % 512)));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function imageArchives(
  layers,
  configPatch = {},
  {
    configMediaType = "application/vnd.oci.image.config.v1+json",
    layerMediaType = "application/vnd.oci.image.layer.v1.tar+gzip",
    layoutVersion = "1.0.0",
  } = {},
) {
  const blobs = layers.map((layer) => {
    const bytes = gzipSync(layer);
    return { name: `blobs/sha256/${sha256(bytes)}`, content: bytes };
  });
  const diffIds = layers.map((bytes) => `sha256:${sha256(bytes)}`);
  const config = Buffer.from(
    JSON.stringify({
      os: "linux",
      architecture: "amd64",
      rootfs: { type: "layers", diff_ids: diffIds },
      ...configPatch,
    }),
  );
  const configDigest = `sha256:${sha256(config)}`;
  const configBlob = {
    name: `blobs/sha256/${sha256(config)}`,
    content: config,
  };
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: configMediaType,
        digest: configDigest,
        size: config.length,
      },
      layers: blobs.map((blob) => ({
        mediaType: layerMediaType,
        digest: `sha256:${sha256(blob.content)}`,
        size: blob.content.length,
      })),
    }),
  );
  const descriptor = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: `sha256:${sha256(manifest)}`,
    size: manifest.length,
    platform: { architecture: "amd64", os: "linux" },
  };
  const docker = tar([
    ...blobs,
    configBlob,
    {
      name: "manifest.json",
      content: JSON.stringify([
        {
          Config: configBlob.name,
          RepoTags: ["fixture:latest"],
          Layers: blobs.map((blob) => blob.name),
        },
      ]),
    },
  ]);
  const oci = tar([
    ...blobs,
    configBlob,
    { name: `blobs/sha256/${sha256(manifest)}`, content: manifest },
    {
      name: "index.json",
      content: JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [descriptor],
      }),
    },
    {
      name: "oci-layout",
      content: JSON.stringify({ imageLayoutVersion: layoutVersion }),
    },
  ]);
  return {
    docker,
    oci,
    descriptor: { digest: descriptor.digest, configDigest, diffIds },
  };
}

export function paxRecord(key, value) {
  const record = ` ${key}=${value}\n`;
  let size = Buffer.byteLength(record) + 1;
  while (Buffer.byteLength(record) + String(size).length !== size)
    size = Buffer.byteLength(record) + String(size).length;
  return `${size}${record}`;
}
