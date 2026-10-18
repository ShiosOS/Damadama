import assert from "node:assert/strict";
import { test } from "node:test";
import { realApplicationOrigin } from "./supply-frontend-origin.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const edge = (id) => `${id}:0`;
const file = (src, dest) => ({
  actions: [
    {
      input: 0,
      secondaryInput: 1,
      output: 0,
      Action: { copy: { src, dest } },
    },
  ],
});

function observedChain() {
  return {
    materials: [
      { uri: "pkg:docker/node@24?digest=sha256:unused", digest: {} },
      {
        uri: `pkg:oci/web?digest=${digest}&platform=linux%2Famd64`,
        digest: { sha256: digest.slice(7) },
      },
    ],
    invocation: {
      parameters: {
        frontend: "dockerfile.v0",
        args: { "context:web": `oci-layout://store@${digest}` },
      },
    },
    buildConfig: {
      llbDefinition: [
        {
          id: "base",
          op: { Op: { source: { identifier: "docker-image://aspnet" } } },
        },
        {
          id: "publishState",
          op: { Op: { file: {} } },
          inputs: [edge("base")],
        },
        {
          id: "web",
          op: {
            Op: {
              source: {
                identifier: `oci-layout://docker.io/library/web@${digest}`,
              },
            },
            platform: { Architecture: "amd64", OS: "linux" },
          },
        },
        {
          id: "webCopy",
          op: {
            Op: { file: file("/src/server/wwwroot", "/src/server/wwwroot") },
          },
          inputs: [edge("publishState"), edge("web")],
        },
        {
          id: "publish",
          op: {
            Op: {
              exec: {
                meta: {
                  args: [
                    "/bin/sh",
                    "-c",
                    "dotnet restore && dotnet publish server/Damadama.csproj --no-restore -c Release -o /out && dotnet tool restore",
                  ],
                },
              },
            },
          },
          inputs: [edge("webCopy")],
        },
        {
          id: "finalCopy",
          op: { Op: { file: file("/out", "/app/") } },
          inputs: [edge("base"), edge("publish")],
        },
        {
          id: "releaseCopy",
          op: {
            Op: {
              file: file(
                "/.damadama-release.json",
                "/app/wwwroot/release.json",
              ),
            },
          },
          inputs: [edge("finalCopy"), edge("publishState")],
        },
        { id: "sink", op: { Op: {} }, inputs: [edge("releaseCopy")] },
      ],
    },
  };
}

test("real application lineage follows the named web input into the final sink", () => {
  const result = realApplicationOrigin(observedChain(), digest);
  assert.deepEqual(result.vertices, [
    "web",
    "webCopy",
    "publish",
    "finalCopy",
    "releaseCopy",
    "sink",
  ]);
});

test("material alone cannot supply a disconnected or wrong web input", () => {
  const wrong = observedChain();
  wrong.buildConfig.llbDefinition[3].inputs[1] = edge("base");
  assert.throws(() => realApplicationOrigin(wrong, digest));

  const duplicate = observedChain();
  duplicate.materials.push({ ...duplicate.materials[1] });
  assert.throws(() => realApplicationOrigin(duplicate, digest));

  const altered = observedChain();
  altered.invocation.parameters.args["context:web"] =
    `oci-layout://store@sha256:${"b".repeat(64)}`;
  assert.throws(() => realApplicationOrigin(altered, digest));
});

test("copy direction, publish use and final sink must stay linked", () => {
  const reversed = observedChain();
  reversed.buildConfig.llbDefinition[3].op.Op.file.actions[0].secondaryInput = 0;
  assert.throws(() => realApplicationOrigin(reversed, digest));

  const skipped = observedChain();
  skipped.buildConfig.llbDefinition[5].inputs[1] = edge("publishState");
  assert.throws(() => realApplicationOrigin(skipped, digest));

  const abandoned = observedChain();
  abandoned.buildConfig.llbDefinition[7].inputs[0] = edge("base");
  assert.throws(() => realApplicationOrigin(abandoned, digest));
});
