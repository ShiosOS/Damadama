import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { release } from "node:os";
import { z } from "zod";
import {
  readOwnedFile,
  directoryIdentity,
  checkDirectories,
} from "./quiet-save-files.mjs";
import { digest } from "./quiet-save-source.mjs";

export const controls = [
  "normal",
  "invalid",
  "held-response",
  "deadline",
  "presave-assertion",
  "pixel-mismatch",
];
export const phaseNames = [
  "calibration",
  "Firefox and WebKit smoke",
  "fresh visual comparison 1",
  "fresh visual comparison 2",
  "fresh visual comparison 3",
  "changed-row pixel rejection and same-page restoration",
  "missing-baseline rejection",
];
export const checkpoints = [
  "desktop-creation",
  "desktop-saved",
  "mobile-layout",
];
export const caseNames = [
  "Firefox and WebKit create, save, and reload through the real API",
  "desktop creation and saved details remain stable",
  "mobile saved layout remains stable",
];
const kinds = [
  "comparison-json",
  "comparison-png",
  "actual",
  "expected",
  "diff",
];
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const ownerSchema = z
  .object({
    control: z.enum(controls),
    iteration: z.number().int().min(0).max(20),
    phase: z.enum(phaseNames),
    project: z.enum([
      "chromium-desktop",
      "chromium-mobile",
      "firefox-smoke",
      "webkit-smoke",
    ]),
    case: z.number().int().min(0).max(2),
  })
  .strict();
const fileIdentity = { checkpoint: z.enum(checkpoints), kind: z.enum(kinds) };
const entrySchema = z.discriminatedUnion("state", [
  z
    .object({
      ...fileIdentity,
      state: z.literal("present"),
      bytes: z
        .number()
        .int()
        .positive()
        .max(4 * 1024 * 1024),
      sha256: hex,
    })
    .strict(),
  z.object({ ...fileIdentity, state: z.enum(["absent", "refused"]) }).strict(),
]);
export const mediaManifest = z
  .object({
    schema: z.literal(1),
    owner: ownerSchema,
    refusal: z.enum([
      "none",
      "ownership",
      "file-policy",
      "metadata",
      "byte-bound",
    ]),
    entries: z.array(entrySchema).max(15),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expected = ownedCheckpoints(value.owner.project).flatMap(
      (checkpoint) => kinds.map((kind) => `${checkpoint}:${kind}`),
    );
    const actual = value.entries.map(
      (entry) => `${entry.checkpoint}:${entry.kind}`,
    );
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      ctx.addIssue({ code: "custom", message: "Media ownership differs." });
    if (
      value.entries.reduce((total, entry) => total + (entry.bytes ?? 0), 0) >
      20 * 1024 * 1024
    )
      ctx.addIssue({
        code: "custom",
        message: "Media aggregate bound exceeded.",
      });
  });
const dimension = z.number().int().min(1).max(4096);
const size = z.object({ width: dimension, height: dimension }).strict();
const version = z.string().regex(/^[A-Za-z0-9._+-]{1,80}$/);
const environment = z
  .object({
    browserVersion: version,
    playwrightVersion: version,
    platform: z.enum(["linux", "win32", "darwin"]),
    architecture: z.enum(["x64", "arm64"]),
    osDistribution: z.literal("ubuntu"),
    osVersion: z.literal("24.04"),
    kernelRelease: version,
    imageOS: version.nullable(),
    imageVersion: version.nullable(),
    viewport: size,
    layoutViewport: z
      .object({ innerWidth: dimension, clientWidth: dimension })
      .strict(),
    screen: size,
    dpr: z.number().positive().max(4),
    locale: z.literal("en-US"),
    timezone: z.literal("America/New_York"),
    fontFamily: z.literal("Nunito Variable"),
    clockInstant: z.literal("2026-01-05T00:30:00.000Z"),
  })
  .strict();
const comparisonSchema = z
  .object({
    schemaVersion: z.literal(1),
    checkpoint: z.enum(checkpoints),
    comparisonSHA: sha,
    baselineGenerationSHA: sha,
    expectedImageSHA256: hex,
    comparisonImageSHA256: hex,
    expectedPNG: z.string(),
    comparisonPNG: z.string(),
    environment,
  })
  .strict();
const baselineSchema = z
  .object({
    schemaVersion: z.literal(1),
    generationSHA: sha,
    images: z
      .array(
        z
          .object({ id: z.enum(checkpoints), sha256: hex, environment })
          .strict(),
      )
      .length(3),
  })
  .strict();

function ownedCheckpoints(project) {
  if (project === "chromium-desktop") return checkpoints.slice(0, 2);
  if (project === "chromium-mobile") return checkpoints.slice(2);
  return [];
}
export function mediaName(entry) {
  if (entry.kind === "comparison-json")
    return `${entry.checkpoint}-comparison.json`;
  if (entry.kind === "comparison-png")
    return `${entry.checkpoint}-comparison.png`;
  return `${entry.checkpoint}-${entry.kind}.png`;
}
export function mediaDirectory(owner, selfTest = false) {
  ownerSchema.parse(owner);
  let root = ".audit/quiet-save/evidence";
  if (selfTest) root = ".audit/quiet-save-self-test-evidence";
  return resolve(
    root,
    `media-${owner.control}-${owner.iteration}-${phaseNames.indexOf(owner.phase)}-${owner.project}-${owner.case}`,
  );
}
function validatePNG(bytes) {
  if (
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("PNG refused.");
  let offset = 8;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (
      ![
        "IHDR",
        "IDAT",
        "IEND",
        "sRGB",
        "gAMA",
        "cHRM",
        "pHYs",
        "PLTE",
        "tRNS",
      ].includes(kind) ||
      offset + size + 12 > bytes.length
    )
      throw new Error("PNG chunk refused.");
    if (
      offset === 8 &&
      (kind !== "IHDR" ||
        size !== 13 ||
        bytes.readUInt32BE(16) > 4096 ||
        bytes.readUInt32BE(20) > 4096)
    )
      throw new Error("PNG dimensions refused.");
    offset += size + 12;
    if (kind === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended || offset !== bytes.length)
    throw new Error("PNG trailing bytes refused.");
}

export async function retainFailureMedia({
  outputDir,
  outputRoot,
  started,
  owner,
  head,
  selfTest = false,
}) {
  owner = ownerSchema.parse(owner);
  const entries = ownedCheckpoints(owner.project).flatMap((checkpoint) =>
    kinds.map((kind) => ({ checkpoint, kind, state: "absent" })),
  );
  let refusal = "none";
  const buffers = new Map();
  try {
    const child = relative(resolve(outputRoot), resolve(outputDir));
    if (
      !child ||
      child.startsWith(`..${sep}`) ||
      child === ".." ||
      isAbsolute(child)
    )
      throw new Error("Output owner refused.");
    await directoryIdentity(outputRoot);
    const listing = await readdir(outputDir).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const names = new Set(entries.map(mediaName));
    if (
      listing.some(
        (name) =>
          /(?:comparison\.(?:json|png)|-(?:actual|expected|diff)\.png)$/.test(
            name,
          ) && !names.has(name),
      )
    )
      throw new Error("Unexpected media name.");
    for (const entry of entries) {
      const name = mediaName(entry);
      if (!listing.includes(name)) continue;
      const bytes = await readOwnedFile(resolve(outputDir, name), started);
      if (entry.kind !== "comparison-json") validatePNG(bytes);
      buffers.set(name, bytes);
      Object.assign(entry, {
        state: "present",
        bytes: bytes.length,
        sha256: digest(bytes),
      });
    }
    refusal = "metadata";
    let baseline;
    if (
      entries.some(
        (entry) =>
          entry.state === "present" &&
          ["expected", "comparison-json"].includes(entry.kind),
      )
    ) {
      baseline = baselineSchema.parse(
        JSON.parse(
          (
            await readOwnedFile(
              resolve("tests/Browser/baselines/manifest.json"),
            )
          ).toString("utf8"),
        ),
      );
      if (new Set(baseline.images.map((image) => image.id)).size !== 3)
        throw new Error("Duplicate baseline.");
    }
    for (const entry of entries.filter((item) => item.state === "present")) {
      const image = baseline?.images.find(
        (item) => item.id === entry.checkpoint,
      );
      if (entry.kind === "expected" && entry.sha256 !== image?.sha256)
        throw new Error("Expected image differs.");
      if (entry.kind !== "comparison-json") continue;
      const metadata = comparisonSchema.parse(
        JSON.parse(buffers.get(mediaName(entry)).toString("utf8")),
      );
      for (const [field, expected] of Object.entries(image.environment)) {
        if (["kernelRelease", "imageOS", "imageVersion"].includes(field))
          continue;
        if (
          JSON.stringify(metadata.environment[field]) !==
          JSON.stringify(expected)
        )
          throw new Error("Comparison environment differs.");
      }
      if (
        !selfTest &&
        (metadata.environment.kernelRelease !== release() ||
          metadata.environment.imageOS !== (process.env.ImageOS ?? null) ||
          metadata.environment.imageVersion !==
            (process.env.ImageVersion ?? null))
      )
        throw new Error("Comparison runtime differs.");
      const png = entries.find(
        (item) =>
          item.checkpoint === entry.checkpoint &&
          item.kind === "comparison-png",
      );
      if (
        metadata.checkpoint !== entry.checkpoint ||
        metadata.comparisonSHA !== head ||
        metadata.baselineGenerationSHA !== baseline.generationSHA ||
        metadata.expectedImageSHA256 !== image?.sha256 ||
        metadata.comparisonImageSHA256 !== png?.sha256 ||
        metadata.comparisonPNG !== `${entry.checkpoint}-comparison.png` ||
        metadata.expectedPNG.replaceAll("\\", "/") !==
          `tests/Browser/baselines/${entry.checkpoint}.png`
      )
        throw new Error("Comparison owner differs.");
    }
    refusal = "byte-bound";
    mediaManifest.parse({ schema: 1, owner, refusal: "none", entries });
    refusal = "none";
  } catch {
    if (refusal === "none") refusal = "file-policy";
    buffers.clear();
    for (const entry of entries) {
      entry.state = "refused";
      delete entry.bytes;
      delete entry.sha256;
    }
  }
  let manifest = mediaManifest.parse({ schema: 1, owner, refusal, entries });
  const destination = mediaDirectory(owner, selfTest);
  await mkdir(dirname(destination), { recursive: true });
  await directoryIdentity(dirname(destination));
  let retainedBytes = 0;
  for (const name of await readdir(dirname(destination))) {
    if (!name.startsWith("media-")) continue;
    const previousDirectory = resolve(dirname(destination), name);
    const previous = JSON.parse(
      (
        await readOwnedFile(
          resolve(previousDirectory, "manifest.json"),
          0,
          16384,
        )
      ).toString("utf8"),
    );
    await validateRetainedMedia(previous, previousDirectory);
    retainedBytes += previous.entries.reduce(
      (total, entry) => total + (entry.bytes ?? 0),
      0,
    );
  }
  if (
    retainedBytes +
      [...buffers.values()].reduce((total, bytes) => total + bytes.length, 0) >
    20 * 1024 * 1024
  ) {
    buffers.clear();
    for (const entry of entries) {
      entry.state = "refused";
      delete entry.bytes;
      delete entry.sha256;
    }
    manifest = mediaManifest.parse({
      schema: 1,
      owner,
      refusal: "byte-bound",
      entries,
    });
  }
  await mkdir(destination);
  const identity = await directoryIdentity(destination);
  for (const [name, bytes] of buffers) {
    await checkDirectories(identity);
    await writeFile(resolve(destination, name), bytes, { flag: "wx" });
  }
  await writeFile(
    resolve(destination, "manifest.json"),
    JSON.stringify(manifest) + "\n",
    { flag: "wx" },
  );
  await validateRetainedMedia(manifest, destination);
  return manifest;
}

export async function validateRetainedMedia(value, directory, head = null) {
  const manifest = mediaManifest.parse(value);
  const stored = mediaManifest.parse(
    JSON.parse(
      (
        await readOwnedFile(resolve(directory, "manifest.json"), 0, 16384)
      ).toString("utf8"),
    ),
  );
  if (JSON.stringify(stored) !== JSON.stringify(manifest))
    throw new Error("Stored manifest differs.");
  const entries = manifest.entries.filter((entry) => entry.state === "present");
  const expected = ["manifest.json", ...entries.map(mediaName)].sort();
  if (
    JSON.stringify((await readdir(directory)).sort()) !==
    JSON.stringify(expected)
  )
    throw new Error("Unexpected retained file.");
  for (const entry of entries) {
    const bytes = await readOwnedFile(resolve(directory, mediaName(entry)));
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256)
      throw new Error("Retained bytes differ.");
    if (entry.kind !== "comparison-json") {
      validatePNG(bytes);
      continue;
    }
    const metadata = comparisonSchema.parse(JSON.parse(bytes.toString("utf8")));
    const image = entries.find(
      (item) =>
        item.checkpoint === entry.checkpoint && item.kind === "comparison-png",
    );
    if (
      metadata.checkpoint !== entry.checkpoint ||
      metadata.comparisonImageSHA256 !== image?.sha256 ||
      metadata.comparisonPNG !== `${entry.checkpoint}-comparison.png` ||
      metadata.expectedPNG.replaceAll("\\", "/") !==
        `tests/Browser/baselines/${entry.checkpoint}.png` ||
      (head !== null && metadata.comparisonSHA !== head)
    )
      throw new Error("Retained comparison differs.");
  }
  return manifest;
}
