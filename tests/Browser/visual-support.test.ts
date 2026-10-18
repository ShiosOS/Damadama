import { expect, test } from "bun:test";
import {
  assertEnvironment,
  baselineManifestSchema,
  checkpoints,
  type Environment,
} from "./visual-support";

const environment: Environment = {
  browserVersion: "130.0.0",
  playwrightVersion: "1.64.0",
  platform: "linux",
  architecture: "x64",
  osDistribution: "ubuntu",
  osVersion: "24.04",
  kernelRelease: "6.8.0",
  imageOS: "ubuntu24",
  imageVersion: "20261012.1",
  viewport: { width: 1280, height: 900 },
  layoutViewport: { innerWidth: 1280, clientWidth: 1280 },
  screen: { width: 1280, height: 900 },
  dpr: 1,
  locale: "en-US",
  timezone: "America/New_York",
  fontFamily: "Nunito Variable",
  clockInstant: "2026-01-05T00:30:00.000Z",
};

test("reviewed image metadata accepts a complete fixed checkpoint set", () => {
  const manifest = baselineManifestSchema.parse({
    schemaVersion: 1,
    generationSHA: "a".repeat(40),
    images: checkpoints.map(({ id, viewport, screen, dpr }) => ({
      id,
      sha256: "b".repeat(64),
      environment: {
        ...environment,
        viewport,
        layoutViewport: {
          innerWidth: viewport.width,
          clientWidth: viewport.width,
        },
        screen,
        dpr,
      },
    })),
  });
  expect(manifest.images).toHaveLength(3);
  expect(
    manifest.images.find(({ id }) => id === "mobile-layout")?.environment
      .viewport,
  ).toEqual({ width: 390, height: 844 });
  assertEnvironment("desktop-saved", environment, structuredClone(environment));
});

test("measured browser version and viewport changes are actionable", () => {
  expect(() =>
    assertEnvironment("desktop-saved", environment, {
      ...environment,
      browserVersion: "131.0.0",
    }),
  ).toThrow(/desktop-saved browserVersion differs.*130\.0\.0.*131\.0\.0/);
  expect(() =>
    assertEnvironment("desktop-saved", environment, {
      ...environment,
      viewport: { width: 1279, height: 900 },
    }),
  ).toThrow(/desktop-saved viewport differs.*1280.*1279/);
  expect(() =>
    assertEnvironment("desktop-saved", environment, {
      ...environment,
      layoutViewport: { innerWidth: 980, clientWidth: 980 },
    }),
  ).toThrow(/desktop-saved layoutViewport differs.*1280.*980/);
});

test("missing or malformed provenance is rejected before comparison", () => {
  const invalid = baselineManifestSchema.safeParse({
    schemaVersion: 1,
    generationSHA: "candidate",
    images: [],
  });
  expect(invalid.success).toBe(false);
});
