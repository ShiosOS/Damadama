import assert from "node:assert/strict";
import { test } from "node:test";
import { tinyFixtureOrigin as resolvedContext } from "./supply-frontend-origin.mjs";

const retained = `sha256:${"a".repeat(64)}`;
const wrong = `sha256:${"b".repeat(64)}`;

function provenance(digest) {
  return {
    materials: [
      {
        uri: `pkg:oci/web?digest=${digest}&platform=linux%2Famd64`,
        digest: { sha256: digest.slice(7) },
      },
    ],
    invocation: {
      parameters: {
        frontend: "dockerfile.v0",
        args: {
          "context:web": `oci-layout://sessionstore@${digest}`,
          "force-network-mode": "none",
          target: "final",
        },
      },
    },
    buildConfig: {
      llbDefinition: [
        {
          id: "step0",
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
          id: "step1",
          op: {
            Op: {
              file: {
                actions: [
                  {
                    input: -1,
                    secondaryInput: 0,
                    output: 0,
                    Action: {
                      copy: {
                        src: "/src/server/wwwroot",
                        dest: "/app/wwwroot",
                        mode: -1,
                        followSymlink: true,
                        dirCopyContents: true,
                        createDestPath: true,
                        allowWildcard: true,
                        allowEmptyWildcard: true,
                        timestamp: -1,
                      },
                    },
                  },
                ],
              },
            },
          },
          inputs: ["step0:0"],
        },
        { id: "step2", op: { Op: {} }, inputs: ["step1:0"] },
      ],
    },
  };
}

test("origin requires the observed named OCI material and connected asset copy", () => {
  assert.deepEqual(resolvedContext(provenance(retained), retained).digest, {
    sha256: retained.slice(7),
  });
  assert.throws(
    () => resolvedContext(provenance(wrong), retained),
    /resolved context differs/,
  );
  assert.throws(() => resolvedContext({}, retained), /no materials/);

  const duplicate = provenance(retained);
  duplicate.materials.push(duplicate.materials[0]);
  assert.throws(() => resolvedContext(duplicate, retained), /one web material/);

  const wrongUri = provenance(retained);
  wrongUri.materials[0].uri = wrongUri.materials[0].uri.replace(
    "web?",
    "other?",
  );
  assert.throws(() => resolvedContext(wrongUri, retained));

  const wrongPlatform = provenance(retained);
  wrongPlatform.materials[0].uri = wrongPlatform.materials[0].uri.replace(
    "amd64",
    "arm64",
  );
  assert.throws(() => resolvedContext(wrongPlatform, retained));

  const wrongArgument = provenance(retained);
  wrongArgument.invocation.parameters.args["context:web"] =
    `oci-layout://sessionstore@${wrong}`;
  assert.throws(
    () => resolvedContext(wrongArgument, retained),
    /named web argument differs/,
  );

  const wrongSource = provenance(retained);
  wrongSource.buildConfig.llbDefinition[0].op.Op.source.identifier = `oci-layout://docker.io/library/other@${retained}`;
  assert.throws(() => resolvedContext(wrongSource, retained));

  const disconnectedCopy = provenance(retained);
  disconnectedCopy.buildConfig.llbDefinition[1].inputs = ["step2:0"];
  assert.throws(() => resolvedContext(disconnectedCopy, retained));

  const duplicateStep = provenance(retained);
  duplicateStep.buildConfig.llbDefinition[2].id = "step0";
  assert.throws(
    () => resolvedContext(duplicateStep, retained),
    /duplicate fixture build step/,
  );

  const missingCopy = provenance(retained);
  missingCopy.buildConfig.llbDefinition[1].op.Op = {};
  assert.throws(
    () => resolvedContext(missingCopy, retained),
    /one web asset copy step/,
  );
});

test("tiny origin refuses altered action inputs and a disconnected final sink", () => {
  for (const mutate of [
    (steps) => {
      steps[1].op.Op.file.actions[0].input = 0;
    },
    (steps) => {
      steps[1].op.Op.file.actions[0].secondaryInput = 1;
    },
    (steps) => {
      steps[1].op.Op.file.actions[0].Action.copy.followSymlink = false;
    },
    (steps) => {
      steps[2].inputs = ["step0:0"];
    },
    (steps) => {
      steps.reverse();
    },
  ]) {
    const changed = provenance(retained);
    mutate(changed.buildConfig.llbDefinition);
    assert.throws(() => resolvedContext(changed, retained));
  }
});
