import assert from "node:assert/strict";

const digestPattern = /^sha256:[a-f0-9]{64}$/;

function copy(step, inputs, src, dest, secondaryInput) {
  assert.deepEqual(step.inputs, inputs, `unexpected inputs for ${step.id}`);
  const actions = step.op?.Op?.file?.actions;
  assert.equal(actions?.length, 1, `unexpected file actions for ${step.id}`);
  const action = actions[0];
  assert.equal(action.input, 0);
  assert.equal(action.secondaryInput, secondaryInput);
  assert.equal(action.output, 0);
  assert.equal(action.Action?.copy?.src, src);
  assert.equal(action.Action?.copy?.dest, dest);
}

export function realApplicationOrigin(provenance, descriptorDigest) {
  assert.match(descriptorDigest, digestPattern);
  const materials = provenance?.materials;
  assert(Array.isArray(materials), "missing final build materials");
  const webMaterials = materials.filter((entry) =>
    entry?.uri?.startsWith("pkg:oci/web"),
  );
  assert.equal(webMaterials.length, 1, "ambiguous named web material");
  assert.deepEqual(webMaterials[0], {
    uri: `pkg:oci/web?digest=${descriptorDigest}&platform=linux%2Famd64`,
    digest: { sha256: descriptorDigest.slice(7) },
  });
  const invocation = provenance.invocation?.parameters;
  assert.equal(invocation?.frontend, "dockerfile.v0");
  assert.equal(invocation.args?.["context:web"]?.slice(-71), descriptorDigest);
  assert.match(
    invocation.args["context:web"],
    /^oci-layout:\/\/[a-z0-9]+@sha256:[a-f0-9]{64}$/,
  );

  const steps = provenance.buildConfig?.llbDefinition;
  assert(Array.isArray(steps) && steps.length > 0, "missing final LLB");
  const byId = new Map(steps.map((step) => [step.id, step]));
  assert.equal(byId.size, steps.length, "duplicate final LLB step");
  for (const step of steps) {
    assert.equal(typeof step.id, "string", "invalid final LLB step id");
    for (const input of step.inputs ?? []) {
      assert.match(input, /^.+:0$/, "invalid final LLB input");
      assert(byId.has(input.slice(0, -2)), "unknown final LLB input");
    }
  }
  const sole = (predicate, label) => {
    const matches = steps.filter(predicate);
    assert.equal(matches.length, 1, `expected one ${label}`);
    return matches[0];
  };
  const web = sole(
    (step) =>
      step.op?.Op?.source?.identifier?.startsWith(
        "oci-layout://docker.io/library/web@",
      ),
    "named web source",
  );
  assert.equal(
    web.op.Op.source.identifier,
    `oci-layout://docker.io/library/web@${descriptorDigest}`,
  );
  assert.deepEqual(web.op.platform, { Architecture: "amd64", OS: "linux" });
  const webCopy = sole(
    (step) =>
      step.op?.Op?.file?.actions?.some(
        (action) => action.Action?.copy?.src === "/src/server/wwwroot",
      ),
    "web-to-publish copy",
  );
  assert.equal(webCopy.inputs?.length, 2);
  assert.notEqual(webCopy.inputs[0], `${web.id}:0`);
  copy(
    webCopy,
    [webCopy.inputs[0], `${web.id}:0`],
    "/src/server/wwwroot",
    "/src/server/wwwroot",
    1,
  );
  const publish = sole(
    (step) => step.inputs?.includes(`${webCopy.id}:0`) && step.op?.Op?.exec,
    "publish command",
  );
  assert.deepEqual(publish.inputs, [`${webCopy.id}:0`]);
  assert.match(
    publish.op.Op.exec.meta?.args?.[2],
    /(?:^|\s)dotnet publish server\/Damadama\.csproj --no-restore -c Release -o \/out(?:\s|$)/,
  );
  const finalCopy = sole(
    (step) =>
      step.op?.Op?.file?.actions?.some(
        (action) => action.Action?.copy?.src === "/out",
      ),
    "publish-to-final copy",
  );
  assert.equal(finalCopy.inputs?.length, 2);
  assert.notEqual(finalCopy.inputs[0], `${publish.id}:0`);
  copy(finalCopy, [finalCopy.inputs[0], `${publish.id}:0`], "/out", "/app/", 1);
  const releaseCopy = sole(
    (step) =>
      step.op?.Op?.file?.actions?.some(
        (action) => action.Action?.copy?.src === "/.damadama-release.json",
      ),
    "release metadata copy",
  );
  assert.equal(releaseCopy.inputs?.length, 2);
  copy(
    releaseCopy,
    [`${finalCopy.id}:0`, releaseCopy.inputs[1]],
    "/.damadama-release.json",
    "/app/wwwroot/release.json",
    1,
  );
  const sink = sole(
    (step) => Object.keys(step.op?.Op ?? {}).length === 0,
    "final sink",
  );
  assert.deepEqual(sink.inputs, [`${releaseCopy.id}:0`]);
  assert.equal(steps.at(-1), sink, "final sink is not the final step");
  return {
    webMaterial: webMaterials[0],
    vertices: [
      web.id,
      webCopy.id,
      publish.id,
      finalCopy.id,
      releaseCopy.id,
      sink.id,
    ],
  };
}

export function tinyFixtureOrigin(provenance, expectedDigest) {
  assert.match(expectedDigest, /^sha256:[a-f0-9]{64}$/);
  assert(Array.isArray(provenance?.materials), "Buildx returned no materials");
  assert.equal(provenance.materials.length, 1, "expected one web material");
  const material = provenance.materials[0];
  assert.match(material?.digest?.sha256, /^[a-f0-9]{64}$/);
  const resolvedDigest = `sha256:${material.digest.sha256}`;
  assert.equal(
    resolvedDigest,
    expectedDigest,
    "resolved context differs from retained web image",
  );
  assert.deepEqual(material, {
    uri: `pkg:oci/web?digest=${resolvedDigest}&platform=linux%2Famd64`,
    digest: { sha256: material.digest.sha256 },
  });
  const args = provenance.invocation?.parameters?.args;
  assert.equal(provenance.invocation?.parameters?.frontend, "dockerfile.v0");
  assert.equal(args?.target, "final");
  assert.equal(args?.["force-network-mode"], "none");
  assert.match(
    args?.["context:web"],
    /^oci-layout:\/\/[a-z0-9]+@sha256:[a-f0-9]{64}$/,
  );
  assert.equal(
    args["context:web"].slice(-71),
    resolvedDigest,
    "named web argument differs from resolved material",
  );
  const steps = provenance.buildConfig?.llbDefinition;
  assert(Array.isArray(steps), "Buildx returned no LLB definition");
  assert.equal(steps.length, 3, "unexpected fixture build definition");
  assert.equal(
    new Set(steps.map((step) => step.id)).size,
    3,
    "duplicate fixture build step",
  );
  const sources = steps.filter((step) => step.op?.Op?.source);
  const copies = steps.filter((step) => step.op?.Op?.file);
  assert.equal(sources.length, 1, "expected one OCI source step");
  assert.equal(copies.length, 1, "expected one web asset copy step");
  assert.equal(
    sources[0].op.Op.source.identifier,
    `oci-layout://docker.io/library/web@${resolvedDigest}`,
  );
  assert.deepEqual(sources[0].op.platform, {
    Architecture: "amd64",
    OS: "linux",
  });
  assert.deepEqual(copies[0].inputs, [`${sources[0].id}:0`]);
  const actions = copies[0].op.Op.file.actions;
  assert.equal(actions?.length, 1);
  assert.equal(actions[0].Action?.copy?.src, "/src/server/wwwroot");
  assert.equal(actions[0].Action?.copy?.dest, "/app/wwwroot");
  assert.equal(actions[0].input, -1);
  assert.equal(actions[0].secondaryInput, 0);
  assert.equal(actions[0].output, 0);
  assert.deepEqual(actions[0].Action.copy, {
    src: "/src/server/wwwroot",
    dest: "/app/wwwroot",
    mode: -1,
    followSymlink: true,
    dirCopyContents: true,
    createDestPath: true,
    allowWildcard: true,
    allowEmptyWildcard: true,
    timestamp: -1,
  });
  assert.deepEqual(sources[0].inputs ?? [], []);
  const sinks = steps.filter(
    (step) => Object.keys(step.op?.Op ?? {}).length === 0,
  );
  assert.equal(sinks.length, 1, "expected one fixture sink");
  assert.deepEqual(sinks[0].inputs, [`${copies[0].id}:0`]);
  assert.equal(steps.at(-1), sinks[0], "fixture sink is not final");
  return material;
}
