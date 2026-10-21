import { readOwnedFile } from "./quiet-save-files.mjs";
import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  controls,
  mediaDirectory,
  validateRetainedMedia,
} from "./quiet-save-media.mjs";
import { parseReceipt } from "./quiet-save-receipt.mjs";
import {
  digest,
  loadSources,
  normalizeSite,
  fontBuildProof,
  readFontAssets,
} from "./quiet-save-source.mjs";

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const token = z.string().regex(/^[A-Za-z0-9._+-]{1,80}$/);
const sourceSchema = z
  .object({
    schema: z.literal(2),
    fontBuild: fontBuildProof,
    head: sha,
    tree: sha,
    node: z.literal("v24.21.0"),
    kernel: token,
    arch: z.enum(["x64", "arm64"]),
    cpus: z.number().int().positive().max(1024),
    memoryBytes: z.number().int().positive(),
    imageOS: token.nullable(),
    imageVersion: token.nullable(),
    canonicalSha256: hex,
    generatedSha256: hex,
    visualSupportSha256: hex,
    mappingSha256: hex,
    kind: z.literal("diagnostic-not-acceptance"),
    invocations: z.number().int().min(1).max(20),
    phases: z.literal(6),
    deadlineMinutesAfterJobStart: z.literal(39),
  })
  .strict();
const run = {
  exitCode: z.number().int().min(0).max(255).nullable(),
  termination: z.enum([
    "none",
    "budget-refused",
    "owned-group-interrupt",
    "interrupt-unverified",
    "owned-group-kill",
    "kill-unverified",
    "spawn-refused",
  ]),
  teardown: z.enum([
    "not-started",
    "owner-returned-resource-absence-unverified",
    "unverified-stop-no-retry",
  ]),
  receiptValid: z.boolean(),
};
const outcomesSchema = z
  .array(
    z.discriminatedUnion("kind", [
      z
        .object({
          ...run,
          kind: z.literal("calibration"),
          control: z.enum(controls.slice(1)),
          matched: z.boolean(),
        })
        .strict(),
      z
        .object({
          ...run,
          kind: z.literal("normal-invocation"),
          iteration: z.number().int().min(1).max(20),
          passed: z.boolean(),
        })
        .strict(),
    ]),
  )
  .max(25);

export async function validateEvidence(
  directory = resolve(".audit/quiet-save/evidence"),
) {
  const sources = loadSources();
  const json = async (name, bound = 1024 * 1024) =>
    JSON.parse(
      (await readOwnedFile(resolve(directory, name), 0, bound)).toString(
        "utf8",
      ),
    );
  const source = sourceSchema.parse(await json("source.json", 16384));
  if (
    JSON.stringify(source.fontBuild) !==
    JSON.stringify((await readFontAssets()).proof)
  )
    throw new Error("Retained font inventory differs.");
  for (const [key, reference] of [
    ["head", "HEAD"],
    ["tree", "HEAD^{tree}"],
  ]) {
    const result = spawnSync("git", ["rev-parse", reference], {
      encoding: "utf8",
    });
    if (result.status !== 0 || source[key] !== result.stdout.trim())
      throw new Error("Diagnostic revision differs.");
  }
  const mapBytes = await readOwnedFile(
    resolve(directory, "source-map.json"),
    0,
    128 * 1024,
  );
  const generatedMap = await readOwnedFile(
    resolve(".audit/quiet-save/source-map.json"),
    0,
    128 * 1024,
  );
  if (!mapBytes.equals(generatedMap))
    throw new Error("Retained source mapping differs.");
  const mapping = JSON.parse(mapBytes.toString("utf8"));
  for (const key of [
    "canonicalSha256",
    "generatedSha256",
    "visualSupportSha256",
    "mappingSha256",
  ])
    if (source[key] !== mapping[key])
      throw new Error("Retained source differs.");
  outcomesSchema.parse(await json("outcomes.json", 16384));
  const expected = new Set(["source.json", "source-map.json", "outcomes.json"]);
  const listing = await readdir(directory);
  let mediaBytes = 0;
  let mediaFiles = 0;
  for (const name of listing) {
    const match =
      /^(normal|invalid|held-response|deadline|presave-assertion|pixel-mismatch)-(\d{1,2})\.jsonl$/.exec(
        name,
      );
    if (!match) continue;
    expected.add(name);
    const receipt = await readOwnedFile(resolve(directory, name));
    const rows = parseReceipt(
      receipt.toString("utf8"),
      match[1],
      Number(match[2]),
    );
    for (const row of rows) {
      if (row.kind !== "test-result") continue;
      if (row.failure && row.failure.site.source !== "unavailable") {
        const known = sources.find(
          (item) => item.source === row.failure.site.source,
        );
        if (
          !known ||
          normalizeSite(
            {
              file: known.path,
              line: row.failure.site.line,
              column: row.failure.site.column,
            },
            sources,
          ).source === "unavailable"
        )
          throw new Error("Retained site differs.");
      }
      if (!row.media) continue;
      const mediaName = basename(mediaDirectory(row.media.owner));
      const mediaPath = resolve(directory, mediaName);
      if (expected.has(mediaName)) throw new Error("Duplicate media owner.");
      expected.add(mediaName);
      await validateRetainedMedia(row.media, mediaPath, source.head);
      for (const entry of row.media.entries) {
        if (entry.state !== "present") continue;
        mediaBytes += entry.bytes;
        mediaFiles++;
      }
    }
  }
  if (mediaBytes > 20 * 1024 * 1024 || mediaFiles > 90)
    throw new Error("Retained media bound exceeded.");
  if (JSON.stringify([...expected].sort()) !== JSON.stringify(listing.sort()))
    throw new Error("Unexpected evidence file.");
  if (digest(sources[0].bytes) !== source.generatedSha256)
    throw new Error("Generated source differs.");
  return { files: expected.size, mediaFiles, mediaBytes };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.info(JSON.stringify(await validateEvidence()));
  } catch {
    console.error("Quiet evidence refused.");
    process.exitCode = 1;
  }
}
