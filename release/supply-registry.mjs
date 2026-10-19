import assert from "node:assert/strict";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  frontendFormat,
  dockerArchiveContent,
  compressedLayer,
} from "./supply-frontend-tar.mjs";
import { fileHash, hash, isolated } from "./supply-internal.mjs";

const repository = "https://ghcr.io/v2/shiosos/damadama";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const media = Object.freeze({
  "application/vnd.oci.image.manifest.v1+json": {
    config: frontendFormat.configMediaType,
    layer: frontendFormat.layerMediaType,
  },
  "application/vnd.docker.distribution.manifest.v2+json": {
    config: "application/vnd.docker.container.image.v1+json",
    layer: "application/vnd.docker.image.rootfs.diff.tar.gzip",
  },
});
export const registryLimits = Object.freeze({
  manifestBytes: 64 * 1024,
  configBytes: 1024 * 1024,
  compressedBytes: frontendFormat.archiveBytes,
  layerBytes: frontendFormat.layerBytes,
  expandedBytes: frontendFormat.expandedBytes,
  timeoutMs: frontendFormat.exportTimeoutMs,
});

export function registryChallenge(value) {
  const match =
    /^Bearer realm="https:\/\/ghcr\.io\/token",service="ghcr\.io",scope="repository:shiosos\/damadama:pull"$/.exec(
      value ?? "",
    );
  assert(match, "unsupported registry authentication challenge");
  return "https://ghcr.io/token?service=ghcr.io&scope=repository%3Ashiosos%2Fdamadama%3Apull";
}

function descriptor(value, type, maximum) {
  assert(
    value && value.mediaType === type,
    "unsupported registry descriptor media type",
  );
  assert.match(value.digest, digestPattern);
  assert(
    !Object.hasOwn(value, "urls") && !Object.hasOwn(value, "data"),
    "external registry descriptor refused",
  );
  assert(
    Number.isSafeInteger(value.size) && value.size > 0 && value.size <= maximum,
    "registry descriptor size outside bounds",
  );
}

const transportReasons = new Map([
  ["ENOTFOUND", "network"],
  ["ECONNREFUSED", "network"],
  ["ECONNRESET", "socket"],
  ["UND_ERR_SOCKET", "socket"],
  ["CERT_HAS_EXPIRED", "tls"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"],
]);

function transportFailure(error, operation, boundary) {
  let reason =
    transportReasons.get(error?.code) ??
    transportReasons.get(error?.cause?.code) ??
    "unknown";
  if (error?.cause?.message === "unexpected redirect") reason = "redirect";
  return new Error(
    `registry transport refused (operation=${operation}, boundary=${boundary}, reason=${reason})`,
  );
}

function blobDestination(location, operation) {
  try {
    if (
      typeof location === "string" &&
      /^https:\/\/pkg-containers\.githubusercontent\.com(?:\/|\?|$)/.test(
        location,
      ) &&
      !/[\u0000-\u0020\u007f\\#]/.test(location)
    )
      return new URL(location);
  } catch {
    // URL parser errors can contain the signed Location.
  }
  throw new Error(
    `registry request refused (operation=${operation}, boundary=response, reason=redirect, status=307)`,
  );
}

function requireSuccess(response, operation) {
  if (!response.ok || response.status !== 200) {
    let status = "unknown";
    if (
      Number.isInteger(response.status) &&
      response.status >= 100 &&
      response.status <= 599
    )
      status = response.status;
    const reason = [301, 302, 303, 307, 308].includes(status)
      ? "redirect"
      : "http";
    throw new Error(
      `registry request refused (operation=${operation}, boundary=response, reason=${reason}, status=${status})`,
    );
  }
}

async function transfer(response, path, maximum, signal, operation) {
  requireSuccess(response, operation);
  assert(
    !response.headers.get("content-encoding") ||
      response.headers.get("content-encoding") === "identity",
    "encoded registry response refused",
  );
  const declared = response.headers.get("content-length");
  if (declared !== null)
    assert(
      /^\d+$/.test(declared) && Number(declared) <= maximum,
      "registry response exceeds bound",
    );
  assert(response.body, "empty registry response");
  const file = await open(path, "wx", 0o600);
  const reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read().catch((error) => {
        throw transportFailure(error, operation, "body");
      });
      if (done) break;
      size += value.byteLength;
      assert(size <= maximum, "registry streamed bytes exceed bound");
      await file.writeFile(value);
    }
    assert(size > 0, "empty registry body");
    if (declared !== null)
      assert.equal(size, Number(declared), "registry response length differs");
    return size;
  } finally {
    await reader.cancel().catch(() => {});
    await file.close();
  }
}

export async function compareRegistryArchive(
  image,
  archivePath,
  limits = registryLimits,
) {
  assert.match(image?.digest, digestPattern);
  assert.equal(image.reference, `ghcr.io/shiosos/damadama@${image.digest}`);
  for (const key of Object.keys(registryLimits))
    assert(
      Number.isSafeInteger(limits[key]) &&
        limits[key] > 0 &&
        limits[key] <= registryLimits[key],
      "invalid registry bound",
    );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
  const signal = controller.signal;
  try {
    return await isolated(async (directory) => {
      const original = await dockerArchiveContent(
        archivePath,
        image.archiveSha256,
        { ...limits, signal },
      );
      let bearer;
      const request = async (operation, url, headers = {}) => {
        signal.throwIfAborted();
        const blob = operation === "config" || operation === "layer";
        const response = await fetch(url, {
          headers: { "Accept-Encoding": "identity", ...headers },
          redirect: blob ? "manual" : "error",
          signal,
        }).catch((error) => {
          throw transportFailure(error, operation, "request");
        });
        if (!blob || response.status !== 307) return response;
        await response.body?.cancel().catch((error) => {
          throw transportFailure(error, operation, "body");
        });
        const destination = blobDestination(
          response.headers.get("location"),
          operation,
        );
        signal.throwIfAborted();
        const delivered = await fetch(destination, {
          headers: { Accept: headers.Accept, "Accept-Encoding": "identity" },
          credentials: "omit",
          redirect: "error",
          signal,
        }).catch((error) => {
          throw transportFailure(error, operation, "request");
        });
        requireSuccess(delivered, operation);
        return delivered;
      };
      const get = async (operation, suffix, path, maximum, accept) => {
        const url = `${repository}/${suffix}`;
        const headers = { Accept: accept };
        if (bearer) headers.Authorization = `Bearer ${bearer}`;
        let response = await request(operation, url, headers);
        if (response.status === 401 && !bearer) {
          const endpoint = registryChallenge(
            response.headers.get("www-authenticate"),
          );
          await response.body?.cancel().catch((error) => {
            throw transportFailure(error, operation, "body");
          });
          const token = process.env.GITHUB_TOKEN;
          assert(
            typeof token === "string" && token.length > 0,
            "missing ephemeral registry token",
          );
          const tokenPath = join(directory, "token.json");
          await transfer(
            await request("auth", endpoint, {
              Authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
            }),
            tokenPath,
            64 * 1024,
            signal,
            "auth",
          );
          try {
            bearer = JSON.parse(await readFile(tokenPath, "utf8")).token;
          } catch {
            throw new Error("invalid registry token response");
          }
          assert(
            typeof bearer === "string" &&
              /^[A-Za-z0-9._~+\/-]+=*$/.test(bearer) &&
              bearer.length <= 32 * 1024,
            "invalid registry bearer token",
          );
          response = await request(operation, url, {
            ...headers,
            Authorization: `Bearer ${bearer}`,
          });
        }
        return transfer(response, path, maximum, signal, operation);
      };
      const manifestPath = join(directory, "manifest.json");
      await get(
        "manifest",
        `manifests/${image.digest}`,
        manifestPath,
        limits.manifestBytes,
        Object.keys(media).join(", "),
      );
      assert.equal(
        `sha256:${await fileHash(manifestPath, signal)}`,
        image.digest,
        "registry manifest digest differs",
      );
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      assert(
        manifest &&
          typeof manifest.mediaType === "string" &&
          Object.hasOwn(media, manifest.mediaType),
        "unsupported registry manifest",
      );
      const types = media[manifest.mediaType];
      assert(
        manifest.schemaVersion === 2 &&
          types &&
          !manifest.manifests &&
          !manifest.subject,
        "unsupported registry manifest",
      );
      descriptor(manifest.config, types.config, limits.configBytes);
      assert(
        Array.isArray(manifest.layers) &&
          manifest.layers.length > 0 &&
          manifest.layers.length <= frontendFormat.layers,
        "unsupported registry layer count",
      );
      assert.equal(
        manifest.layers.length,
        original.layers,
        "registry layer count differs from archive",
      );
      const configPath = join(directory, "config.json");
      const configSize = await get(
        "config",
        `blobs/${manifest.config.digest}`,
        configPath,
        limits.configBytes,
        types.config,
      );
      const config = await readFile(configPath);
      assert.equal(
        configSize,
        manifest.config.size,
        "registry config size differs",
      );
      assert.equal(
        `sha256:${hash(config)}`,
        manifest.config.digest,
        "registry config digest differs",
      );
      assert(
        config.equals(original.config),
        "registry config differs from archive",
      );
      const budget = {
        perLayer: limits.layerBytes,
        remaining: limits.expandedBytes,
        signal,
      };
      let compressedBytes = 0;
      const retained = [
        [manifestPath, image.digest],
        [configPath, manifest.config.digest],
      ];
      for (const [index, layer] of manifest.layers.entries()) {
        descriptor(layer, types.layer, limits.compressedBytes);
        compressedBytes += layer.size;
        assert(
          compressedBytes <= limits.compressedBytes,
          "compressed layers exceed aggregate bound",
        );
        const path = join(directory, `layer-${index}`);
        const size = await get(
          "layer",
          `blobs/${layer.digest}`,
          path,
          layer.size,
          types.layer,
        );
        assert.equal(size, layer.size, "registry layer size differs");
        const actual = await compressedLayer(path, budget);
        assert.equal(
          actual.digest,
          layer.digest,
          "registry compressed layer digest differs",
        );
        assert.equal(
          actual.diffId,
          original.diffIds[index],
          "registry ordered DiffID differs",
        );
        assert.equal(
          actual.expandedSize,
          original.expandedSizes[index],
          "registry expanded size differs",
        );
        retained.push([path, layer.digest]);
      }
      for (const [path, digest] of retained) {
        signal.throwIfAborted();
        assert.equal(
          `sha256:${await fileHash(path, signal)}`,
          digest,
          "registry bytes changed during comparison",
        );
      }
      assert.equal(
        await fileHash(archivePath, signal),
        image.archiveSha256,
        "original archive changed during comparison",
      );
      signal.throwIfAborted();
    });
  } catch (error) {
    if (signal.aborted)
      throw new Error("registry verification deadline exceeded");
    throw error;
  } finally {
    controller.abort();
    clearTimeout(timeout);
  }
}
