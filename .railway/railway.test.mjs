import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { definitionFor, verifyDefinition } from "./verify.mjs";

const [releaseDocker, releaseIgnore, previewDocker, previewIgnore] =
  await Promise.all([
    readFile(new URL("../release/Dockerfile", import.meta.url), "utf8"),
    readFile(
      new URL("../release/Dockerfile.dockerignore", import.meta.url),
      "utf8",
    ),
    readFile(new URL("Preview.Dockerfile", import.meta.url), "utf8"),
    readFile(
      new URL("Preview.Dockerfile.dockerignore", import.meta.url),
      "utf8",
    ),
  ]);
const buildFiles = {
  releaseDocker,
  releaseIgnore,
  previewDocker,
  previewIgnore,
};

function withoutReceipt(source, receiptLine) {
  return source
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter((line) => line !== receiptLine)
    .join("\n");
}

function verifyBuildParity(files) {
  assert.equal(
    files.previewDocker.replaceAll("\r\n", "\n"),
    withoutReceipt(
      files.releaseDocker,
      "COPY .damadama-release.json wwwroot/release.json",
    ),
    "Keep preview image pins and build steps in sync with the release build. Only its release receipt is omitted.",
  );
  assert.equal(
    files.previewIgnore.replaceAll("\r\n", "\n"),
    withoutReceipt(files.releaseIgnore, "!.damadama-release.json"),
    "Keep preview and release build contexts in sync, without the release receipt.",
  );
}

test("actual preview build differs only by release receipt omission", () => {
  verifyBuildParity(buildFiles);
});

test("rejects an independently changed preview image pin", () => {
  assert.throws(
    () =>
      verifyBuildParity({
        ...buildFiles,
        previewDocker: previewDocker.replace(
          /sha256:[0-9a-f]{64}/,
          `sha256:${"0".repeat(64)}`,
        ),
      }),
    /Keep preview image pins/,
  );
});

test("rejects a trusted release receipt in the preview image", () => {
  assert.throws(
    () =>
      verifyBuildParity({
        ...buildFiles,
        previewDocker:
          previewDocker +
          "\nCOPY .damadama-release.json wwwroot/release.json\n",
      }),
    /Only its release receipt is omitted/,
  );
});

test("rejects an independently widened preview build context", () => {
  assert.throws(
    () =>
      verifyBuildParity({
        ...buildFiles,
        previewIgnore: previewIgnore + "\n!**/.env*\n",
      }),
    /Keep preview and release build contexts/,
  );
});

for (const environment of ["staging", "production", "preview-base"]) {
  test(`${environment} accepts the real SDK definition`, async () => {
    verifyDefinition(await definitionFor(environment), environment);
  });
}

for (const environment of ["staging", "production"]) {
  test(`refuses ordinary ${environment} apply while native source preservation is unverified`, async () => {
    await assert.rejects(
      definitionFor(environment, "apply"),
      /Trusted infrastructure apply is blocked/,
    );
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
