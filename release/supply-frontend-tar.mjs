import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

export const frontendFormat = Object.freeze({
  archiveBytes: 2 * 1024 * 1024 * 1024,
  layerBytes: 1024 * 1024 * 1024,
  expandedBytes: 2 * 1024 * 1024 * 1024,
  layers: 64,
  flattenedBytes: 1024 * 1024 * 1024,
  finalBytes: 512 * 1024 * 1024,
  headers: 100_000,
  archiveHeaders: 100,
  paxBytes: 64 * 1024,
  paxKeys: Object.freeze(["path", "linkpath"]),
  stderrBytes: 64 * 1024,
  exportTimeoutMs: 600_000,
  ociLayoutVersion: "1.0.0",
  configMediaType: "application/vnd.oci.image.config.v1+json",
  layerMediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
});

const block = 512;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const digest = /^[a-f0-9]{64}$/;

function field(bytes) {
  const end = bytes.indexOf(0);
  return utf8.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

function octal(bytes) {
  const value = field(bytes).trim();
  assert.match(value, /^[0-7]+$/, "invalid tar number");
  const parsed = Number.parseInt(value, 8);
  assert(Number.isSafeInteger(parsed), "tar number exceeds safe range");
  return parsed;
}

function pathName(value) {
  assert(typeof value === "string" && value.length > 0, "empty tar path");
  const path = value.endsWith("/") ? value.slice(0, -1) : value;
  assert(
    path.length > 0 &&
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !/[\u0000-\u001f\u007f]/.test(path) &&
      !/^[a-zA-Z]:/.test(path) &&
      path.split("/").every((part) => part && part !== "." && part !== ".."),
    "unsafe tar path",
  );
  return path;
}

function pax(bytes) {
  const values = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    assert(space > offset, "invalid PAX length");
    const declared = utf8.decode(bytes.subarray(offset, space));
    assert.match(declared, /^[1-9][0-9]*$/, "invalid PAX length");
    const size = Number(declared);
    assert(Number.isSafeInteger(size) && size > space - offset + 2);
    const end = offset + size;
    assert(end <= bytes.length && bytes[end - 1] === 10, "invalid PAX record");
    const record = utf8.decode(bytes.subarray(space + 1, end - 1));
    const equals = record.indexOf("=");
    assert(equals > 0, "invalid PAX key");
    const key = record.slice(0, equals);
    assert(frontendFormat.paxKeys.includes(key), `unsupported PAX key ${key}`);
    assert(!Object.hasOwn(values, key), "duplicate PAX key");
    values[key] = record.slice(equals + 1);
    offset = end;
  }
  return values;
}

async function readAt(handle, offset, length) {
  const bytes = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const result = await handle.read(bytes, done, length - done, offset + done);
    assert(result.bytesRead > 0, "truncated tar entry");
    done += result.bytesRead;
  }
  return bytes;
}

export async function tarIndex(
  archivePath,
  maximumBytes,
  maximumEntries = frontendFormat.headers,
) {
  const size = (await stat(archivePath)).size;
  assert(size > 0 && size <= maximumBytes, "tar size outside supported bounds");
  const entries = new Map();
  const handle = await open(archivePath, "r");
  try {
    let offset = 0;
    let headers = 0;
    let pending = null;
    let endFound = false;
    while (offset + block <= size) {
      const header = await readAt(handle, offset, block);
      if (header.every((byte) => byte === 0)) {
        assert(offset + block * 2 <= size, "missing tar end marker");
        const second = await readAt(handle, offset + block, block);
        assert(
          second.every((byte) => byte === 0),
          "invalid tar end marker",
        );
        let tail = offset + block * 2;
        while (tail < size) {
          const bytes = await readAt(
            handle,
            tail,
            Math.min(64 * 1024, size - tail),
          );
          assert(
            bytes.every((byte) => byte === 0),
            "nonzero tar trailing data",
          );
          tail += bytes.length;
        }
        endFound = true;
        break;
      }
      headers++;
      assert(headers <= maximumEntries, "too many tar headers");
      const checksum = octal(header.subarray(148, 156));
      assert.equal(
        field(header.subarray(257, 263)),
        "ustar",
        "unsupported tar format",
      );
      const actual = header.reduce(
        (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
        0,
      );
      assert.equal(actual, checksum, "tar header checksum differs");
      const length = octal(header.subarray(124, 136));
      const data = offset + block;
      const next = data + Math.ceil(length / block) * block;
      assert(next <= size, "tar entry exceeds archive");
      const type = String.fromCharCode(header[156] || 48);
      if (type === "x") {
        assert(
          !pending && length > 0 && length <= frontendFormat.paxBytes,
          "unsupported PAX header",
        );
        pending = pax(await readAt(handle, data, length));
      } else {
        assert("0152".includes(type), "unsupported tar entry type");
        const prefix = field(header.subarray(345, 500));
        const rawName =
          pending?.path ??
          (prefix
            ? `${prefix}/${field(header.subarray(0, 100))}`
            : field(header.subarray(0, 100)));
        const link = pending?.linkpath ?? field(header.subarray(157, 257));
        if (type !== "0") assert.equal(length, 0, "non-file tar data");
        if (type !== "1" && type !== "2") {
          assert(
            !link && !Object.hasOwn(pending ?? {}, "linkpath"),
            "link on non-link tar entry",
          );
        }
        if (rawName === "." && type === "5") {
          pending = null;
          offset = next;
          continue;
        }
        const name = pathName(rawName);
        assert(!entries.has(name), "duplicate tar path");
        if (type === "1") pathName(link);
        if (type === "2") {
          const target = posix.normalize(posix.join(posix.dirname(name), link));
          assert(
            link &&
              !link.includes("\\") &&
              !/[\u0000-\u001f\u007f]/.test(link) &&
              !/^[a-zA-Z]:/.test(link) &&
              !link.startsWith("//") &&
              (link.startsWith("/") ||
                (target !== ".." && !target.startsWith("../"))),
            "unsafe symlink",
          );
        }
        entries.set(name, { type, size: length, offset: data, link });
        assert(entries.size <= maximumEntries, "too many tar entries");
        pending = null;
      }
      offset = next;
    }
    assert(endFound && !pending, "incomplete tar archive");
  } finally {
    await handle.close();
  }
  return {
    path: archivePath,
    entries,
    async read(name, maximumSize = 2 * 1024 * 1024) {
      const entry = entries.get(name);
      assert(entry?.type === "0", `missing regular tar file ${name}`);
      assert(entry.size <= maximumSize, "tar file exceeds supported bound");
      const file = await open(archivePath, "r");
      try {
        return await readAt(file, entry.offset, entry.size);
      } finally {
        await file.close();
      }
    },
    regular(name, maximumDepth = 8) {
      let current = name;
      const seen = new Set();
      for (let depth = 0; depth < maximumDepth; depth++) {
        assert(!seen.has(current), "cyclic image hardlink");
        seen.add(current);
        const entry = entries.get(current);
        assert(entry, `missing image file ${current}`);
        if (entry.type === "0") return current;
        assert(entry.type === "1", "unsupported image alias");
        current = entry.link;
      }
      throw new Error("image hardlink chain exceeds bound");
    },
  };
}

async function hashSlice(path, entry, budget) {
  const source = createReadStream(path, {
    start: entry.offset,
    end: entry.offset + entry.size - 1,
  });
  const sha = createHash("sha256");
  let size = 0;
  const streams = [source];
  if (budget) streams.push(createGunzip());
  await pipeline(...streams, async (stream) => {
    for await (const bytes of stream) {
      size += bytes.length;
      if (budget) {
        budget.remaining -= bytes.length;
        assert(size <= budget.perLayer, "layer exceeds supported bound");
        assert(budget.remaining >= 0, "expanded layers exceed aggregate bound");
      } else
        assert(
          size <= frontendFormat.archiveBytes,
          "archive exceeds supported bound",
        );
      sha.update(bytes);
    }
  });
  return sha.digest("hex");
}

function layerBudget({
  layerBytes = frontendFormat.layerBytes,
  expandedBytes = frontendFormat.expandedBytes,
} = {}) {
  assert(
    Number.isSafeInteger(layerBytes) &&
      layerBytes > 0 &&
      layerBytes <= frontendFormat.layerBytes,
  );
  assert(
    Number.isSafeInteger(expandedBytes) &&
      expandedBytes > 0 &&
      expandedBytes <= frontendFormat.expandedBytes,
  );
  return { perLayer: layerBytes, remaining: expandedBytes };
}

export async function dockerArchive(archivePath, expectedArchiveHash, limits) {
  const budget = layerBudget(limits);
  assert.match(expectedArchiveHash, digest);
  const outer = await tarIndex(
    archivePath,
    frontendFormat.archiveBytes,
    frontendFormat.archiveHeaders,
  );
  const manifest = JSON.parse(await outer.read("manifest.json", 64 * 1024));
  assert(
    Array.isArray(manifest) && manifest.length === 1,
    "ambiguous Docker archive",
  );
  const [image] = manifest;
  assert.match(image.Config, /^blobs\/sha256\/[a-f0-9]{64}$/);
  assert(
    Array.isArray(image.Layers) &&
      image.Layers.length > 0 &&
      image.Layers.length <= frontendFormat.layers,
    "unsupported Docker layer count",
  );
  const config = await outer.read(image.Config, 1024 * 1024);
  const configDigest = createHash("sha256").update(config).digest("hex");
  assert.equal(
    image.Config.slice(-64),
    configDigest,
    "image config hash differs",
  );
  const parsed = JSON.parse(config);
  assert.equal(parsed.os, "linux");
  assert.equal(parsed.architecture, "amd64");
  assert.equal(parsed.rootfs?.type, "layers", "unsupported image rootfs type");
  const diffIds = parsed.rootfs?.diff_ids;
  assert(Array.isArray(diffIds) && diffIds.length === image.Layers.length);
  assert.equal(new Set(image.Layers).size, image.Layers.length);
  for (const [index, name] of image.Layers.entries()) {
    assert.match(name, /^blobs\/sha256\/[a-f0-9]{64}$/);
    const entry = outer.entries.get(name);
    assert(entry?.type === "0" && entry.size > 0, "missing image layer");
    assert.equal(await hashSlice(archivePath, entry), name.slice(-64));
    assert.equal(
      `sha256:${await hashSlice(archivePath, entry, budget)}`,
      diffIds[index],
    );
  }
  const actualArchiveHash = await hashSlice(archivePath, {
    offset: 0,
    size: (await stat(archivePath)).size,
  });
  assert.equal(
    actualArchiveHash,
    expectedArchiveHash,
    "Docker archive bytes differ",
  );
  return {
    configDigest: `sha256:${configDigest}`,
    diffIds,
    layers: image.Layers.length,
  };
}

export async function ociArchive(archivePath, expectedArchiveHash, limits) {
  const budget = layerBudget(limits);
  assert.match(expectedArchiveHash, digest);
  const archive = await tarIndex(
    archivePath,
    frontendFormat.archiveBytes,
    frontendFormat.archiveHeaders,
  );
  const layout = JSON.parse(await archive.read("oci-layout", 64 * 1024));
  assert.equal(
    layout.imageLayoutVersion,
    frontendFormat.ociLayoutVersion,
    "unsupported OCI layout version",
  );
  const index = JSON.parse(await archive.read("index.json", 64 * 1024));
  assert.equal(index.schemaVersion, 2);
  assert.equal(index.mediaType, "application/vnd.oci.image.index.v1+json");
  assert(Array.isArray(index.manifests) && index.manifests.length === 1);
  const [descriptor] = index.manifests;
  assert.equal(
    descriptor.mediaType,
    "application/vnd.oci.image.manifest.v1+json",
  );
  assert.deepEqual(descriptor.platform, { architecture: "amd64", os: "linux" });
  assert.match(descriptor.digest, /^sha256:[a-f0-9]{64}$/);
  const manifest = await archive.read(
    `blobs/sha256/${descriptor.digest.slice(7)}`,
    64 * 1024,
  );
  assert.equal(manifest.length, descriptor.size);
  assert.equal(
    createHash("sha256").update(manifest).digest("hex"),
    descriptor.digest.slice(7),
  );
  const image = JSON.parse(manifest);
  assert.equal(image.schemaVersion, 2);
  assert.equal(image.mediaType, "application/vnd.oci.image.manifest.v1+json");
  assert.equal(
    image.config?.mediaType,
    frontendFormat.configMediaType,
    "unsupported OCI config media type",
  );
  assert.match(image.config?.digest, /^sha256:[a-f0-9]{64}$/);
  const config = await archive.read(
    `blobs/sha256/${image.config.digest.slice(7)}`,
    1024 * 1024,
  );
  assert.equal(config.length, image.config.size);
  assert.equal(
    createHash("sha256").update(config).digest("hex"),
    image.config.digest.slice(7),
  );
  const parsed = JSON.parse(config);
  assert.equal(parsed.os, "linux");
  assert.equal(parsed.architecture, "amd64");
  assert.equal(parsed.rootfs?.type, "layers", "unsupported image rootfs type");
  assert(
    Array.isArray(parsed.rootfs?.diff_ids) && parsed.rootfs.diff_ids.length > 0,
  );
  assert(
    Array.isArray(image.layers) &&
      image.layers.length <= frontendFormat.layers &&
      image.layers.length === parsed.rootfs.diff_ids.length,
  );
  for (const [index, layer] of image.layers.entries()) {
    assert.equal(
      layer.mediaType,
      frontendFormat.layerMediaType,
      "unsupported OCI layer media type",
    );
    assert.match(layer.digest, /^sha256:[a-f0-9]{64}$/);
    const entry = archive.entries.get(`blobs/sha256/${layer.digest.slice(7)}`);
    assert(
      entry?.type === "0" && entry.size > 0 && entry.size === layer.size,
      "OCI layer differs",
    );
    assert.equal(await hashSlice(archivePath, entry), layer.digest.slice(7));
    assert.equal(
      `sha256:${await hashSlice(archivePath, entry, budget)}`,
      parsed.rootfs.diff_ids[index],
      "OCI expanded layer DiffID differs",
    );
  }
  const actualArchiveHash = await hashSlice(archivePath, {
    offset: 0,
    size: (await stat(archivePath)).size,
  });
  assert.equal(
    actualArchiveHash,
    expectedArchiveHash,
    "OCI archive bytes differ",
  );
  return {
    digest: descriptor.digest,
    configDigest: image.config.digest,
    diffIds: parsed.rootfs.diff_ids,
  };
}
