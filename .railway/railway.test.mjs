import assert from "node:assert/strict";
import { test } from "node:test";
import { definitionFor, verifyDefinition } from "./verify.mjs";

for (const environment of ["staging", "production", "preview-base"]) {
  test(`${environment} accepts the real SDK definition`, async () => {
    verifyDefinition(await definitionFor(environment), environment);
  });
}

for (const environment of [
  undefined,
  "",
  "preview",
  "pr-42",
  "Staging",
  "production-typo",
]) {
  test(`refuses unknown environment ${String(environment)}`, async () => {
    await assert.rejects(
      definitionFor(environment),
      /Select staging, production or the isolated preview-base explicitly/,
    );
  });
}

const mutations = [
  [
    "staging",
    "a release image rollback",
    (d) => {
      d.resources[0].source = {
        type: "image",
        image: "ghcr.io/shiosos/damadama@sha256:old",
      };
    },
  ],
  [
    "production",
    "a missing backup bucket",
    (d) => {
      d.resources.pop();
    },
  ],
  [
    "staging",
    "overwritten database secrets",
    (d) => {
      d.resources[1].variables.POSTGRES_PASSWORD = {
        type: "literal",
        value: "unsafe",
      };
    },
  ],
  [
    "production",
    "public database exposure",
    (d) => {
      d.resources[1].networking = { tcpProxies: { 5432: {} } };
    },
  ],
  [
    "staging",
    "removed cron backup",
    (d) => {
      delete d.resources[2].deploy.cronSchedule;
    },
  ],
  [
    "preview-base",
    "cloned volume data",
    (d) => {
      d.resources[2].config.forkFromBaseEnvironment = true;
    },
  ],
  [
    "preview-base",
    "trusted Clerk settings",
    (d) => {
      d.resources[0].variables.Clerk__Issuer.name = "CLERK_ISSUER";
    },
  ],
  [
    "preview-base",
    "an inherited backup credential",
    (d) => {
      d.resources[0].variables.AWS_SECRET_ACCESS_KEY = { type: "preserve" };
    },
  ],
  [
    "preview-base",
    "uncapped PostgreSQL",
    (d) => {
      delete d.resources[1].deploy.limitOverride;
    },
  ],
  [
    "preview-base",
    "an unrelated service",
    (d) => {
      d.resources.push({ type: "service", name: "backup-production" });
    },
  ],
];

for (const [environment, description, mutate] of mutations) {
  test(`rejects ${description}`, async () => {
    const definition = structuredClone(await definitionFor(environment));
    mutate(definition);
    assert.throws(() => verifyDefinition(definition, environment));
  });
}
