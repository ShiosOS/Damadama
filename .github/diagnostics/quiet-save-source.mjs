import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const coordinate = z.number().int().min(1).max(10000);
export const sourceSite = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("unavailable"),
      line: z.null(),
      column: z.null(),
    })
    .strict(),
  ...["generated-test", "visual-support", "calibration-test"].map((source) =>
    z
      .object({
        source: z.literal(source),
        line: coordinate,
        column: z.number().int().min(1).max(1000),
      })
      .strict(),
  ),
]);
export const unavailableSite = {
  source: "unavailable",
  line: null,
  column: null,
};
export const operations = [
  "toBe",
  "toEqual",
  "toBeFocused",
  "toBeVisible",
  "toHaveScreenshot",
  "toMatchSnapshot",
  "page.waitForResponse",
  "page.evaluate",
  "locator.screenshot",
  "unknown",
];
export const failureSchema = z
  .object({
    stage: z.enum([
      "unknown",
      "before-dialog",
      "dialog-open",
      "creation-comparison",
      "before-waiter",
      "save-boundary",
      "after-save",
    ]),
    site: sourceSite,
    category: z.enum(["expect", "pw:api", "hook", "test.step", "unknown"]),
    operation: z.enum(operations),
    locationOrigin: z.enum(["step", "result-error", "unavailable"]),
    candidateOverflow: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.site.source === "unavailable") !==
      (value.locationOrigin === "unavailable")
    )
      context.addIssue({
        code: "custom",
        message: "Failure location origin differs.",
      });
  });

export function lineMapping(canonical, generated) {
  const original = canonical.split("\n");
  const lines = generated
    .split("\n")
    .map((line) =>
      line.replace(
        '"../../tests/Browser/visual-support"',
        '"./visual-support"',
      ),
    );
  const lengths = Array.from(
    { length: original.length + 1 },
    () => new Uint16Array(lines.length + 1),
  );
  for (let a = original.length - 1; a >= 0; a--)
    for (let b = lines.length - 1; b >= 0; b--)
      lengths[a][b] =
        original[a] === lines[b]
          ? lengths[a + 1][b + 1] + 1
          : Math.max(lengths[a + 1][b], lengths[a][b + 1]);
  const mapping = Array(lines.length).fill(null);
  let a = 0;
  let b = 0;
  while (a < original.length && b < lines.length) {
    if (original[a] === lines[b]) {
      mapping[b++] = ++a;
    } else if (lengths[a + 1][b] > lengths[a][b + 1]) a++;
    else b++;
  }
  return mapping;
}

export function sourceProof(canonical, generated, visualSupport) {
  const mapping = lineMapping(canonical, generated);
  return {
    schema: 1,
    mode: "canonical",
    canonicalBlob: committedBlob(
      "tests/Browser/compatibility.pw.ts",
      canonical,
    ),
    visualSupportBlob: committedBlob(
      "tests/Browser/visual-support.ts",
      visualSupport,
    ),
    canonicalSha256: digest(canonical),
    generatedSha256: digest(generated),
    visualSupportSha256: digest(visualSupport),
    mappingSha256: digest(JSON.stringify(mapping)),
    mapping,
  };
}

function committedBlob(path, source) {
  const result = spawnSync("git", ["rev-parse", `HEAD:${path}`], {
    encoding: "utf8",
  });
  const blob = createHash("sha1")
    .update(`blob ${Buffer.byteLength(source)}\0`)
    .update(source)
    .digest("hex");
  if (result.status !== 0 || result.stdout.trim() !== blob)
    throw new Error("Canonical source differs from committed blob.");
  return blob;
}

export function loadSources(selfTest = false) {
  if (selfTest) {
    const path = resolve(".audit/quiet-save-evidence-tests/probe.spec.mjs");
    try {
      const bytes = readFileSync(path, "utf8");
      const proof = z
        .object({
          schema: z.literal(1),
          mode: z.literal("calibration"),
          source: z.literal("calibration-test"),
          sha256: hex,
        })
        .strict()
        .parse(
          JSON.parse(
            readFileSync(
              ".audit/quiet-save-evidence-tests/source.json",
              "utf8",
            ),
          ),
        );
      if (proof.sha256 !== digest(bytes)) return [];
      return [{ source: "calibration-test", path, bytes }];
    } catch {
      return [];
    }
  }
  const proof = z
    .object({
      schema: z.literal(1),
      mode: z.literal("canonical"),
      canonicalBlob: z.string().regex(/^[a-f0-9]{40}$/),
      visualSupportBlob: z.string().regex(/^[a-f0-9]{40}$/),
      canonicalSha256: hex,
      generatedSha256: hex,
      visualSupportSha256: hex,
      mappingSha256: hex,
      mapping: z.array(coordinate.nullable()).max(10000),
    })
    .strict()
    .parse(
      JSON.parse(readFileSync(".audit/quiet-save/source-map.json", "utf8")),
    );
  const canonical = readFileSync("tests/Browser/compatibility.pw.ts", "utf8");
  const generated = readFileSync(".audit/quiet-save/observed.pw.ts", "utf8");
  const visualSupport = readFileSync("tests/Browser/visual-support.ts", "utf8");
  if (
    JSON.stringify(proof) !==
    JSON.stringify(sourceProof(canonical, generated, visualSupport))
  )
    throw new Error("Source proof differs.");
  return [
    {
      source: "generated-test",
      path: resolve(".audit/quiet-save/observed.pw.ts"),
      bytes: generated,
    },
    {
      source: "visual-support",
      path: resolve("tests/Browser/visual-support.ts"),
      bytes: visualSupport,
    },
  ];
}

export function normalizeSite(location, sources) {
  if (typeof location?.file !== "string") return unavailableSite;
  const source = sources.find((item) => item.path === resolve(location.file));
  if (!source) return unavailableSite;
  const parsed = sourceSite.safeParse({
    source: source.source,
    line: location.line,
    column: location.column,
  });
  if (!parsed.success) return unavailableSite;
  const line = source.bytes.split("\n")[location.line - 1];
  if (line === undefined || location.column > line.length + 1)
    return unavailableSite;
  return parsed.data;
}

export function failedStep(step, sources) {
  let operation = "unknown";
  if (step.category === "expect") {
    const match = /^Expect "(?:not )?(to[A-Za-z]+)(?:"|\()/.exec(
      step.title ?? "",
    );
    if (match && operations.includes(match[1])) operation = match[1];
  } else if (operations.includes(step.title)) operation = step.title;
  let category = "unknown";
  if (["expect", "pw:api", "hook", "test.step"].includes(step.category))
    category = step.category;
  return { site: normalizeSite(step.location, sources), category, operation };
}

export function failureStage(observation) {
  if (!observation || observation.refusal !== "none") return "unknown";
  const records = observation.node;
  if (records.some((row) => row.event === "response")) return "after-save";
  if (records.some((row) => row.event === "waiter-armed"))
    return "save-boundary";
  const boundary = records
    .filter((row) => row.event === "phase-boundary")
    .at(-1);
  if (!boundary) return "before-dialog";
  if (boundary.edge === "start") return boundary.stage;
  return "before-waiter";
}
