import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";

export const manifestMediaType = "application/vnd.oci.image.manifest.v1+json";
const configMediaType = "application/vnd.oci.image.config.v1+json";
const layerMediaType = "application/vnd.oci.image.layer.v1.tar";
const digest = /^sha256:[a-f0-9]{64}$/;
const blobPath = /^blobs\/sha256\/[a-f0-9]{64}$/;
const jsonLimit = 2 * 1024 * 1024;
const check = (condition, message) => assert.ok(condition, message);
const blob = (value) => `blobs/sha256/${value.slice(7)}`;
const text = (bytes) => bytes.toString("utf8").replace(/\0.*$/s, "");

async function readAt(file, position, length, label) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await file.read(
      bytes,
      offset,
      length - offset,
      position + offset,
    );
    check(result.bytesRead > 0, `${label}: truncated tar member`);
    offset += result.bytesRead;
  }
  return bytes;
}

function octal(bytes, label) {
  const value = text(bytes).trim();
  check(/^[0-7]+$/.test(value), `${label}: unsupported tar number`);
  return Number.parseInt(value, 8);
}

async function archiveMembers(path, label) {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const members = new Map();
    let position = 0;
    while (position + 1024 <= size) {
      const header = await readAt(file, position, 512, label);
      if (header.every((byte) => byte === 0)) {
        for await (const bytes of createReadStream(path, { start: position })) {
          check(
            bytes.every((byte) => byte === 0),
            `${label}: ambiguous tar trailer`,
          );
        }
        return members;
      }
      check(members.size < 8192, `${label}: too many tar members`);
      let checksum = 0;
      for (let i = 0; i < 512; i++) {
        if (i >= 148 && i < 156) checksum += 32;
        else checksum += header[i];
      }
      check(
        checksum === octal(header.subarray(148, 156), label),
        `${label}: tar header checksum differs`,
      );
      const prefix = text(header.subarray(345, 500));
      let name = text(header.subarray(0, 100));
      if (prefix) name = `${prefix}/${name}`;
      const length = octal(header.subarray(124, 136), label);
      const type = header[156];
      const directory = type === 53;
      check(
        type === 0 || type === 48 || directory,
        `${label}: unsupported tar member type`,
      );
      if (directory) {
        check(
          ["blobs/", "blobs/sha256/"].includes(name) && length === 0,
          `${label}: unexpected tar directory`,
        );
      } else {
        check(
          ["index.json", "manifest.json", "oci-layout"].includes(name) ||
            blobPath.test(name),
          `${label}: unexpected tar member path`,
        );
      }
      check(!members.has(name), `${label}: duplicate tar member`);
      check(position + 512 + length <= size, `${label}: truncated tar member`);
      members.set(name, { offset: position + 512, size: length, directory });
      position += 512 + Math.ceil(length / 512) * 512;
    }
    throw new Error(`${label}: missing tar terminator`);
  } finally {
    await file.close();
  }
}

function member(members, name, label) {
  const value = members.get(name);
  check(value && !value.directory, `${label}: missing required tar member`);
  return value;
}

async function memberBytes(path, members, name, label) {
  const value = member(members, name, label);
  check(value.size <= jsonLimit, `${label}: JSON member exceeds size bound`);
  const file = await open(path, "r");
  try {
    return await readAt(file, value.offset, value.size, label);
  } finally {
    await file.close();
  }
}

function json(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    check(
      value !== null && typeof value === "object",
      `${label}: invalid JSON member`,
    );
    return value;
  } catch {
    throw new Error(`${label}: invalid JSON member`);
  }
}

async function memberDigest(path, value) {
  const hash = createHash("sha256");
  if (value.size > 0) {
    for await (const bytes of createReadStream(path, {
      start: value.offset,
      end: value.offset + value.size - 1,
    }))
      hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function verifyBlob(path, members, descriptor, mediaType, label) {
  check(
    descriptor &&
      digest.test(descriptor.digest) &&
      descriptor.mediaType === mediaType &&
      Number.isSafeInteger(descriptor.size) &&
      descriptor.size >= 0,
    `${label}: invalid descriptor`,
  );
  const value = member(members, blob(descriptor.digest), label);
  check(value.size === descriptor.size, `${label}: blob size differs`);
  check(
    (await memberDigest(path, value)) === descriptor.digest,
    `${label}: blob digest differs`,
  );
}

export async function readOciImage(path, label = "OCI archive") {
  const members = await archiveMembers(path, label);
  const layout = json(
    await memberBytes(path, members, "oci-layout", label),
    label,
  );
  check(layout.imageLayoutVersion === "1.0.0", `${label}: unsupported layout`);
  const index = json(
    await memberBytes(path, members, "index.json", label),
    label,
  );
  check(
    index.schemaVersion === 2 &&
      Array.isArray(index.manifests) &&
      index.manifests.length === 1,
    `${label}: require one image manifest`,
  );
  const descriptor = index.manifests[0];
  await verifyBlob(
    path,
    members,
    descriptor,
    manifestMediaType,
    `${label} manifest`,
  );
  if (descriptor.platform) {
    check(
      descriptor.platform.os === "linux" &&
        descriptor.platform.architecture === "amd64" &&
        !descriptor.platform.variant,
      `${label}: platform must be linux/amd64`,
    );
  }
  const manifest = json(
    await memberBytes(path, members, blob(descriptor.digest), label),
    label,
  );
  check(
    manifest.schemaVersion === 2 &&
      manifest.mediaType === manifestMediaType &&
      !manifest.artifactType &&
      !manifest.subject,
    `${label}: unsupported image manifest`,
  );
  await verifyBlob(
    path,
    members,
    manifest.config,
    configMediaType,
    `${label} config`,
  );
  const configBytes = await memberBytes(
    path,
    members,
    blob(manifest.config.digest),
    label,
  );
  const config = json(configBytes, label);
  check(
    config.os === "linux" && config.architecture === "amd64" && !config.variant,
    `${label}: platform must be linux/amd64`,
  );
  check(
    config.rootfs?.type === "layers" &&
      Array.isArray(config.rootfs.diff_ids) &&
      config.rootfs.diff_ids.length > 0 &&
      config.rootfs.diff_ids.every((id) => digest.test(id)),
    `${label}: invalid rootfs DiffIDs`,
  );
  check(
    Array.isArray(manifest.layers) &&
      manifest.layers.length === config.rootfs.diff_ids.length,
    `${label}: layer count differs from config`,
  );
  for (const layer of manifest.layers)
    await verifyBlob(path, members, layer, layerMediaType, `${label} layer`);
  assert.deepEqual(
    manifest.layers.map((layer) => layer.digest),
    config.rootfs.diff_ids,
    `${label}: layer order differs from config DiffIDs`,
  );
  return {
    manifestDigest: descriptor.digest,
    manifestMediaType: descriptor.mediaType,
    configId: manifest.config.digest,
    configBytes,
    diffIds: config.rootfs.diff_ids,
  };
}

export async function verifyDockerArchive(path, witness) {
  const label = "Docker archive";
  const docker = await readOciImage(path, label);
  assert.deepEqual(
    docker.configBytes,
    witness.configBytes,
    `${label}: config bytes differ from OCI image`,
  );
  const members = await archiveMembers(path, label);
  const manifest = json(
    await memberBytes(path, members, "manifest.json", label),
    label,
  );
  check(
    Array.isArray(manifest) && manifest.length === 1,
    `${label}: require one image manifest`,
  );
  const selected = manifest[0];
  check(
    selected && selected.Config === blob(witness.configId),
    `${label}: config differs from OCI image`,
  );
  check(
    Array.isArray(selected.Layers) &&
      selected.Layers.length === witness.diffIds.length,
    `${label}: layer count differs from OCI image`,
  );
  for (let i = 0; i < selected.Layers.length; i++) {
    check(
      blobPath.test(selected.Layers[i]),
      `${label}: unexpected layer member path`,
    );
    check(
      selected.Layers[i] === blob(witness.diffIds[i]),
      `${label}: layer bytes or order differ from OCI DiffIDs`,
    );
  }
}
