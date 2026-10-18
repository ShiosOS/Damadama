import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createRailwayContext, project } from "railway/iac";
import railway from "./railway.ts";

export function verifyDefinition(definition, environment) {
  assert.equal(definition.name, "Damadama");
  assert.deepEqual(
    definition.environments,
    [environment],
    "Select one environment explicitly.",
  );
  const resources = definition.resources.flat();
  const names = resources.map((resource) => resource.name).sort();
  let appName = "app";
  if (environment === "production") appName = "app-production";

  if (environment === "preview-base") {
    assert.deepEqual(names, [
      "preview-app",
      "preview-postgres",
      "preview-postgres-volume",
    ]);
    const app = resources.find((resource) => resource.name === "preview-app");
    const db = resources.find(
      (resource) => resource.name === "preview-postgres",
    );
    const data = resources.find((resource) => resource.type === "volume");
    assert.deepEqual(app.source, {
      type: "github",
      repo: "ShiosOS/Damadama",
      branch: "main",
    });
    assert.equal(app.build.builder, "DOCKERFILE");
    assert.equal(db.type, "service");
    assert.equal(db.kind, "docker-image");
    assert.match(db.source.image, /^postgres:17-alpine@sha256:[a-f0-9]{64}$/);
    assert.deepEqual(db.variables.POSTGRES_PASSWORD, {
      type: "raw",
      value: {
        generator:
          'secret(32, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")',
      },
    });
    assert.equal(
      data.config.forkFromBaseEnvironment,
      false,
      "Never clone base volume data.",
    );
    assert.equal(data.config.sizeMB, 1_000);
    assert.equal(db.volumeAttachments[data.name].volume, data.address);
    assert.equal(
      db.networking,
      undefined,
      "Preview PostgreSQL must remain private.",
    );
    assert.equal(
      app.networking,
      undefined,
      "Provision generated domains outside the graph.",
    );
    assert.deepEqual(Object.keys(app.variables).sort(), [
      "Clerk__AuthorizedParties__0",
      "Clerk__Issuer",
      "Clerk__PublishableKey",
      "ConnectionStrings__habits",
    ]);
    assert.deepEqual(app.variables.Clerk__Issuer, {
      type: "sharedReference",
      name: "PREVIEW_CLERK_ISSUER",
    });
    assert.deepEqual(app.variables.Clerk__PublishableKey, {
      type: "sharedReference",
      name: "PREVIEW_CLERK_PUBLISHABLE_KEY",
    });
    assert.match(
      app.variables.Clerk__AuthorizedParties__0.value,
      /preview-app.RAILWAY_PUBLIC_DOMAIN/,
    );
    assert.match(
      app.variables.ConnectionStrings__habits.value,
      /preview-postgres.RAILWAY_PRIVATE_DOMAIN/,
    );
    assert.doesNotMatch(
      JSON.stringify(definition),
      /backup-|AWS_|S3_BUCKET|ghcr\.io\/shiosos|preserve|staging\.|prod\./,
    );
  } else {
    assert.ok(["staging", "production"].includes(environment));
    assert.deepEqual(
      names,
      [
        appName,
        `backup-${environment}`,
        `damadama-${environment}-backups`,
        `postgres-${environment}`,
        `postgres-${environment}-volume`,
      ].sort(),
      "Preserve every existing resource.",
    );
    const db = resources.find(
      (resource) => resource.name === `postgres-${environment}`,
    );
    const data = resources.find((resource) => resource.type === "volume");
    const backup = resources.find(
      (resource) => resource.name === `backup-${environment}`,
    );
    assert.equal(data.config.sizeMB, 50_000);
    assert.equal(data.config.region, "us-west2");
    assert.equal(
      db.volumeAttachments[data.name].mountPath,
      "/var/lib/postgresql/data",
    );
    assert.equal(
      db.networking,
      undefined,
      "Preserve private PostgreSQL exposure.",
    );
    assert.equal(backup.deploy.cronSchedule, "0 3 * * *");
    assert.equal(backup.deploy.restartPolicyType, "NEVER");
    for (const resource of resources.filter(
      (resource) => resource.type === "service",
    )) {
      assert.equal(
        resource.source,
        undefined,
        "The release controller owns trusted sources.",
      );
      for (const value of Object.values(resource.variables)) {
        assert.deepEqual(
          value,
          { type: "preserve" },
          "Keep existing Railway values and secrets.",
        );
      }
    }
  }
  for (const resource of resources.filter((resource) =>
    ["service", "database"].includes(resource.type),
  )) {
    assert.deepEqual(
      resource.deploy.limitOverride,
      { containers: { cpu: 0.5, memoryBytes: 500_000_000 } },
      "Keep resource caps.",
    );
    assert.deepEqual(resource.deploy.multiRegionConfig, {
      "us-west2": { numReplicas: 1 },
    });
    assert.equal(
      resource.tracing,
      undefined,
      "Tracing activation is separate.",
    );
  }
  assert.doesNotMatch(
    JSON.stringify(definition),
    /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i,
    "Keep remote identities outside the authoring graph.",
  );
}

export async function definitionFor(environment, command = "plan") {
  return railway(createRailwayContext({ environment, command }), project);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const environment of ["staging", "production", "preview-base"]) {
    verifyDefinition(await definitionFor(environment), environment);
    console.log(
      `${environment} offline definition verified. No live plan or activation was performed.`,
    );
  }
}
