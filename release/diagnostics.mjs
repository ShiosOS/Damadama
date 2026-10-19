import { performance } from "node:perf_hooks";

const phases = new Set([
  "stage.release.locate",
  "stage.release.recheck",
  "deployment.provider.observe.before-checks",
  "deployment.provider.observe.after-checks",
  "stage.browser.contexts.close",
  "stage.browser.close",
  "stage.deployment.summary",
  "stage.verified.write",
  "supply.publication.download",
  "supply.publication.extract",
  "supply.capsule.download",
  "supply.capsule.extract",
  "supply.build.download",
  "supply.build.extract",
  "supply.scan.download",
  "supply.scan.extract",
  "supply.signature.manifest",
  "supply.manifest.compare.initial",
  "supply.manifest.compare.final",
  "supply.originals.materialize",
  "supply.originals.compare.before",
  "supply.originals.compare.after",
  "supply.evidence.validate",
  "supply.registry.compare",
  "supply.signature.provenance",
  "supply.signature.sbom",
  "supply.database.current",
  "supply.scan.recheck",
]);
let nextInvocation = 0;

function emit(phase, invocation, event, elapsedMs) {
  try {
    console.error(
      "release-phase " +
        JSON.stringify({ phase, invocation, event, elapsedMs }),
    );
  } catch {}
}

export async function observePhase(phase, action) {
  if (!phases.has(phase)) throw new Error("unknown release diagnostic phase");
  const invocation = ++nextInvocation;
  const started = performance.now();
  emit(phase, invocation, "start", 0);
  try {
    const result = await action();
    emit(phase, invocation, "complete", performance.now() - started);
    return result;
  } catch (error) {
    emit(phase, invocation, "failed", performance.now() - started);
    throw error;
  }
}
