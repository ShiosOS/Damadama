import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { release, arch, platform } from "node:os";
import { join } from "node:path";
import {
  expect,
  type Browser,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { z } from "zod";

export const clockInstant = "2026-01-05T00:30:00.000Z";
export const candidateDir = ".audit/browser-quality/candidates";
export const baselineDir = "tests/Browser/baselines";

export const checkpoints = [
  {
    id: "desktop-creation",
    project: "chromium-desktop",
    account: "owner",
    target: "dialog",
    viewport: { width: 1280, height: 900 },
    screen: { width: 1280, height: 900 },
    dpr: 1,
  },
  {
    id: "desktop-saved",
    project: "chromium-desktop",
    account: "owner",
    target: "saved",
    viewport: { width: 1280, height: 900 },
    screen: { width: 1280, height: 900 },
    dpr: 1,
  },
  {
    id: "mobile-layout",
    project: "chromium-mobile",
    account: "cleanup",
    target: "page",
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    dpr: 1,
  },
] as const;

const sha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "expected a 40-character Git SHA");
const hex = z.string().regex(/^[0-9a-f]{64}$/, "expected a SHA-256 digest");
const size = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
const checkpointId = z.enum([
  "desktop-creation",
  "desktop-saved",
  "mobile-layout",
]);
export const screenshotOptions = {
  animations: "disabled",
  caret: "hide",
  scale: "css",
} satisfies Parameters<Locator["screenshot"]>[0];
const environmentSchema = z.object({
  browserVersion: z.string().min(1),
  playwrightVersion: z.string().min(1),
  platform: z.string().min(1),
  architecture: z.string().min(1),
  osDistribution: z.literal("ubuntu"),
  osVersion: z.literal("24.04"),
  kernelRelease: z.string().min(1),
  imageOS: z.string().min(1).nullable(),
  imageVersion: z.string().min(1).nullable(),
  viewport: size,
  layoutViewport: z.object({
    innerWidth: z.number().int().positive(),
    clientWidth: z.number().int().positive(),
  }),
  screen: size,
  dpr: z.number().positive(),
  locale: z.literal("en-US"),
  timezone: z.literal("America/New_York"),
  fontFamily: z.literal("Nunito Variable"),
  clockInstant: z.literal(clockInstant),
});
const imageSchema = z.object({
  id: checkpointId,
  sha256: hex,
  environment: environmentSchema,
});
export const baselineManifestSchema = z.object({
  schemaVersion: z.literal(1),
  generationSHA: sha,
  images: z.array(imageSchema).length(checkpoints.length),
});
export type BaselineManifest = z.infer<typeof baselineManifestSchema>;
export type Checkpoint = (typeof checkpoints)[number];
export type Environment = z.infer<typeof environmentSchema>;

const comparisonSchema = z.object({
  schemaVersion: z.literal(1),
  checkpoint: checkpointId,
  comparisonSHA: sha,
  baselineGenerationSHA: sha,
  expectedImageSHA256: hex,
  comparisonImageSHA256: hex,
  expectedPNG: z.string().min(1),
  comparisonPNG: z.string().min(1),
  environment: environmentSchema,
});

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function checkpointFor(project: string, id: string): Checkpoint {
  const checkpoint = checkpoints.find(
    (item) => item.id === id && item.project === project,
  );
  if (!checkpoint) throw new Error(`Unknown checkpoint ${id} for ${project}.`);
  return checkpoint;
}

export async function loadManifest(
  path = join(baselineDir, "manifest.json"),
): Promise<BaselineManifest> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `Reviewed browser baseline is missing: ${path}. Run capture and review candidates before verify.`,
    );
  }
  const parsed: unknown = JSON.parse(content);
  const manifest = baselineManifestSchema.parse(parsed);
  const ids = manifest.images.map((image) => image.id);
  for (const checkpoint of checkpoints) {
    if (ids.filter((id) => id === checkpoint.id).length !== 1)
      throw new Error(
        `Baseline manifest needs exactly one ${checkpoint.id} image.`,
      );
  }
  return manifest;
}

export async function validateBaselines(
  manifest: BaselineManifest,
): Promise<void> {
  for (const image of manifest.images) {
    const path = join(baselineDir, `${image.id}.png`);
    let bytes: Uint8Array;
    try {
      bytes = await readFile(path);
    } catch {
      throw new Error(`Reviewed browser baseline PNG is missing: ${path}.`);
    }
    if (
      !Buffer.from(bytes)
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new Error(`Reviewed browser baseline is not a PNG: ${path}.`);
    if (sha256(bytes) !== image.sha256)
      throw new Error(
        `Reviewed browser baseline hash differs from manifest: ${path}.`,
      );
  }
}

async function actualEnvironment(
  page: Page,
  browser: Browser,
  checkpoint: Checkpoint,
): Promise<Environment> {
  await page.evaluate(() => document.fonts.ready);
  const fontLoaded = await page.evaluate(() =>
    [...document.fonts].some(
      (face) =>
        face.family.replaceAll('"', "") === "Nunito Variable" &&
        face.status === "loaded",
    ),
  );
  if (!fontLoaded)
    throw new Error("Bundled Nunito Variable FontFace did not load.");
  const viewport = page.viewportSize();
  const actual = await page.evaluate(() => ({
    layoutViewport: {
      innerWidth: window.innerWidth,
      clientWidth: document.documentElement.clientWidth,
    },
    screen: { width: window.screen.width, height: window.screen.height },
    dpr: window.devicePixelRatio,
    locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    clockInstant: new Date().toISOString(),
  }));
  expect(viewport).toEqual(checkpoint.viewport);
  expect(actual.layoutViewport.innerWidth).toBe(checkpoint.viewport.width);
  expect(actual.layoutViewport.clientWidth).toBe(checkpoint.viewport.width);
  expect(actual.screen).toEqual(checkpoint.screen);
  expect(actual.dpr).toBe(checkpoint.dpr);
  expect(actual.locale).toBe("en-US");
  expect(actual.timezone).toBe("America/New_York");
  expect(actual.clockInstant).toBe(clockInstant);
  const packageJson: unknown = JSON.parse(
    await readFile("node_modules/@playwright/test/package.json", "utf8"),
  );
  const version = z
    .object({ version: z.string().min(1) })
    .parse(packageJson).version;
  return environmentSchema.parse({
    browserVersion: browser.version(),
    playwrightVersion: version,
    platform: platform(),
    architecture: arch(),
    osDistribution: z
      .literal("ubuntu")
      .parse(process.env["COMPAT_OS_DISTRIBUTION"]),
    osVersion: z.literal("24.04").parse(process.env["COMPAT_OS_VERSION"]),
    kernelRelease: release(),
    imageOS: process.env["ImageOS"] ?? null,
    imageVersion: process.env["ImageVersion"] ?? null,
    viewport,
    layoutViewport: actual.layoutViewport,
    screen: actual.screen,
    dpr: actual.dpr,
    locale: actual.locale,
    timezone: actual.timezone,
    fontFamily: "Nunito Variable",
    clockInstant: actual.clockInstant,
  });
}

export async function captureOrCompare(
  page: Page,
  browser: Browser,
  testInfo: TestInfo,
  checkpoint: Checkpoint,
  target: Page | Locator,
): Promise<void> {
  if (testInfo.config.updateSnapshots !== "none")
    throw new Error("Compatibility tests require updateSnapshots=none.");
  const environment = await actualEnvironment(page, browser, checkpoint);
  if (process.env["COMPAT_MODE"] === "capture") {
    await mkdir(candidateDir, { recursive: true });
    const image = await target.screenshot(screenshotOptions);
    await writeFile(join(candidateDir, `${checkpoint.id}.png`), image);
    await writeFile(
      join(candidateDir, `${checkpoint.id}.json`),
      JSON.stringify(
        imageSchema.parse({
          id: checkpoint.id,
          sha256: sha256(image),
          environment,
        }),
        null,
        2,
      ) + "\n",
    );
    return;
  }
  if (process.env["COMPAT_MODE"] !== "verify")
    throw new Error("Use compatibility-run.ts capture or verify.");
  const manifest = await loadManifest();
  const baseline = manifest.images.find((image) => image.id === checkpoint.id);
  if (!baseline) throw new Error(`Baseline metadata missing ${checkpoint.id}.`);
  assertEnvironment(checkpoint.id, baseline.environment, environment);
  await expect(target).toHaveScreenshot(
    `${checkpoint.id}.png`,
    screenshotOptions,
  );
  const comparisonPNG = `${checkpoint.id}-comparison.png`;
  const image = await target.screenshot(screenshotOptions);
  expect(image).toMatchSnapshot(`${checkpoint.id}.png`);
  await writeFile(testInfo.outputPath(comparisonPNG), image);
  const metadata = comparisonSchema.parse({
    schemaVersion: 1,
    checkpoint: checkpoint.id,
    comparisonSHA: process.env["COMPAT_CURRENT_SHA"],
    baselineGenerationSHA: manifest.generationSHA,
    expectedImageSHA256: baseline.sha256,
    comparisonImageSHA256: sha256(image),
    expectedPNG: join(baselineDir, `${checkpoint.id}.png`),
    comparisonPNG,
    environment,
  });
  await writeFile(
    testInfo.outputPath(`${checkpoint.id}-comparison.json`),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
}

export function assertEnvironment(
  id: string,
  expected: Environment,
  observed: Environment,
): void {
  for (const field of [
    "browserVersion",
    "playwrightVersion",
    "platform",
    "architecture",
    "osDistribution",
    "osVersion",
    "viewport",
    "layoutViewport",
    "screen",
    "dpr",
    "locale",
    "timezone",
    "fontFamily",
    "clockInstant",
  ] as const) {
    if (JSON.stringify(observed[field]) !== JSON.stringify(expected[field]))
      throw new Error(
        `Baseline ${id} ${field} differs: expected ${JSON.stringify(expected[field])}, observed ${JSON.stringify(observed[field])}.`,
      );
  }
}

export async function candidateManifest(
  generationSHA: string,
): Promise<BaselineManifest> {
  const images: unknown[] = [];
  for (const checkpoint of checkpoints) {
    const metadata: unknown = JSON.parse(
      await readFile(join(candidateDir, `${checkpoint.id}.json`), "utf8"),
    );
    const image = imageSchema.parse(metadata);
    const bytes = await readFile(join(candidateDir, `${checkpoint.id}.png`));
    if (image.id !== checkpoint.id || image.sha256 !== sha256(bytes))
      throw new Error(
        `Candidate ${checkpoint.id} metadata or image hash differs.`,
      );
    images.push(image);
  }
  return baselineManifestSchema.parse({
    schemaVersion: 1,
    generationSHA,
    images,
  });
}

export async function nonemptyDiffs(outputDir: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      if (entry.isFile() && entry.name.endsWith("-diff.png")) {
        const bytes = await readFile(child);
        if (bytes.length > 8) found.push(child);
      }
    }
  }
  await visit(outputDir);
  return found;
}
