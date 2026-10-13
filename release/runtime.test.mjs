import assert from "node:assert/strict";
import { test } from "node:test";
import {
  requireLiveImage,
  requireRecovery,
  requireIsolation,
  deployedImage,
} from "./runtime.mjs";

const image = `ghcr.io/shiosos/damadama@sha256:${"a".repeat(64)}`;
const expected = { id: "d1", image };
const observation = () => ({
  id: "d1",
  status: "SUCCESS",
  image,
  activeId: "d1",
});
test("the active successful immutable deployment is accepted", () => {
  assert.doesNotThrow(() => requireLiveImage(expected, observation()));
});
for (const [field, value] of [
  ["id", "old"],
  ["status", "FAILED"],
  ["image", "mutable:latest"],
  ["activeId", "other"],
]) {
  test(`a changed deployment ${field} invalidates runtime evidence`, () => {
    assert.throws(
      () => requireLiveImage(expected, { ...observation(), [field]: value }),
      /deployment/,
    );
  });
}

for (const retentionDays of [undefined, "7", "bad", NaN]) {
  test(`recovery refuses nonnumeric retention ${String(retentionDays)}`, () => {
    assert.throws(
      () => requireRecovery({ ...recovery(), retentionDays }, null, now),
      /recovery/,
    );
  });
}
test("provider deployment metadata, rather than mutable source settings, identifies the running image", () => {
  assert.equal(deployedImage({ source: { image } }, "source.image"), image);
  assert.throws(
    () =>
      deployedImage({ source: { image: "mutable:latest" } }, "source.image"),
    /immutable/,
  );
  assert.throws(() => deployedImage({}, "source.image"), /unavailable/);
  assert.throws(() => deployedImage({}, undefined), /setup/);
});
const now = Date.parse("2026-10-12T12:00:00Z");
const recovery = () => ({
  backupId: "backup-1",
  completedAt: "2026-10-12T03:00:00Z",
  retentionDays: 7,
  restoreSeconds: 120,
  restoreEvidence: "https://github.com/ShiosOS/Damadama/issues/1",
  previousImage: null,
  compatibilityEvidence: "initial-release",
});
test("initial release requires a recent backup and measured isolated restore", () => {
  assert.doesNotThrow(() => requireRecovery(recovery(), null, now));
});
for (const [field, value] of [
  ["backupId", ""],
  ["completedAt", "2026-10-10T03:00:00Z"],
  ["retentionDays", 6],
  ["restoreSeconds", 3601],
  ["restoreEvidence", ""],
  ["previousImage", image],
]) {
  test(`recovery refuses invalid ${field}`, () => {
    assert.throws(
      () => requireRecovery({ ...recovery(), [field]: value }, null, now),
      /recovery/,
    );
  });
}
test("a prior image needs forward-schema compatibility evidence", () => {
  const r = { ...recovery(), previousImage: image };
  assert.throws(() => requireRecovery(r, image, now), /compatibility/);
  r.compatibilityEvidence = "https://github.com/ShiosOS/Damadama/issues/1";
  assert.doesNotThrow(() => requireRecovery(r, image, now));
});

const isolation = () =>
  Object.fromEntries(
    ["staging", "production"].map((name) => [
      name,
      {
        railwayProjectId: "project",
        railwayEnvironmentId: name,
        appServiceId: "app",
        databaseServiceId: "postgres",
        volumeId: `${name}-volume`,
        backupBucket: `${name}-backups`,
        databaseName: `damadama_${name}`,
        databaseUser: `${name}_app`,
        clerkApplicationId: `${name}-clerk`,
        clerkIssuer: `https://clerk.${name}.example.com`,
        clerkPublishableKey: `pk_live_${name}`,
        origin: `https://${name}.example.com`,
      },
    ]),
  );
test("separate resources within two Railway environments are accepted", () => {
  assert.doesNotThrow(() => requireIsolation(isolation()));
});
for (const field of [
  "railwayEnvironmentId",
  "volumeId",
  "backupBucket",
  "databaseName",
  "databaseUser",
  "clerkApplicationId",
  "clerkIssuer",
  "clerkPublishableKey",
  "origin",
]) {
  test(`isolation rejects shared ${field}`, () => {
    const config = isolation();
    config.production[field] = config.staging[field];
    assert.throws(() => requireIsolation(config), new RegExp(field));
  });
}
