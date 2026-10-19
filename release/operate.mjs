import {
  requireController,
  requireFreshCandidate,
  requireApproval,
} from "./controller.mjs";
import { locateRelease, authenticateRelease } from "./supply-release.mjs";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  github,
  captureSource,
  attemptJobs,
  runArtifacts,
  selectArtifact,
  readArtifact,
} from "./github.mjs";
import {
  repository,
  requireVerifiedRecord,
  requirePromotion,
  requireStageRun,
  requireCIEvidence,
  requireSupplyIdentity,
  recordHash,
} from "./policy.mjs";
import {
  deployImage,
  inspectRailway,
  observeDeployment,
  logSummary,
  requireEnvironment,
} from "./railway.mjs";
import { requireRecovery } from "./runtime.mjs";
import { applicationState } from "./application.mjs";

const operation = process.argv[2];
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
const write = async (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2));
const output = async (value) =>
  appendFile(process.env.GITHUB_OUTPUT, value + "\n");
const summary = async (value) =>
  appendFile(process.env.GITHUB_STEP_SUMMARY, value + "\n");

async function nativeStageEvidence(runId) {
  const run = await github(`repos/${repository}/actions/runs/${runId}`);
  const authority = { sha: run.head_sha, runId, attempt: run.run_attempt };
  requireStageRun(run, authority);
  const source = await captureSource(authority.sha);
  const jobs = await attemptJobs(authority);
  requireCIEvidence(source, jobs, authority, [
    "release-controls",
    "check",
    "build",
    "stage",
  ]);
  const artifacts = await runArtifacts(runId);
  const receipt = selectArtifact(
    artifacts,
    "verified-record",
    authority,
    jobs.find((j) => j.name === "stage"),
  );
  const metadata = selectArtifact(
    artifacts,
    "candidate-metadata",
    authority,
    jobs.find((j) => j.name === "build"),
  );
  const record = requireVerifiedRecord(
    JSON.parse(await readArtifact(receipt, "verified.json")),
  );
  if (
    recordHash(record.authority) !== recordHash(authority) ||
    recordHash(record.source) !== recordHash(source) ||
    recordHash(record.evidence.ci) !==
      recordHash(requireCIEvidence(source, jobs, authority))
  )
    throw new Error("record differs from authenticated main attempt evidence");
  const build = JSON.parse(await readArtifact(metadata, "build.json"));
  if (
    build.archiveSha256 !== record.image.archiveSha256 ||
    build.version !== record.image.version ||
    recordHash(build.source) !== recordHash(record.source) ||
    recordHash(build.authority) !== recordHash(authority)
  )
    throw new Error("promotion metadata differs from verified image");
  return { record, run, jobs, artifacts: { receipt, metadata } };
}

async function stageEvidence(runId) {
  const before = await nativeStageEvidence(runId);
  await authenticateRelease(
    before.record,
    before.record.image,
    before.record.evidence.supply,
  );
  const after = await nativeStageEvidence(runId);
  if (recordHash(before) !== recordHash(after))
    throw new Error("staging authority changed during signed verification");
  await requireController();
  return after;
}

async function verifyDeployment(record, recheck, verify) {
  await observeDeployment(record.deployment);
  const automated = await verify(record);
  await observeDeployment(record.deployment);
  await recheck();
  return automated;
}

async function reportAppliedFailure(error, deployment, image) {
  const applied = deployment ?? error.deployment;
  if (!applied) return;
  const outcome = {
    status: "applied-but-unverified",
    deployment: applied,
    image,
    reason: error.message,
  };
  const message = `Applied but unverified. Deployment ${applied.id ?? "ID unavailable"}. Image ${image}. ${error.message}. No rollback was performed.`;
  console.error(message);
  try {
    await mkdir("runtime-evidence", { recursive: true });
    await write("runtime-evidence/provider-outcome.json", outcome);
  } catch (reportError) {
    console.error(`Could not write provider outcome: ${reportError.message}`);
  }
  try {
    await summary(message);
  } catch (reportError) {
    console.error(`Could not write deployment summary: ${reportError.message}`);
  }
}

if (operation === "snapshot") {
  const authority = await requireController();
  if (process.env.GITHUB_EVENT_NAME !== "push")
    throw new Error("staging requires a main push");
  const source = await captureSource(authority.sha);
  const state = applicationState(source.commit, "controls");
  await output(`state=${state}`);
  if (state === "setup") {
    await summary(
      "Nondeployable controls setup. Immutable history since the approved baseline contains no application roots. No staging receipt is emitted.",
    );
  } else {
    await write("source.json", source);
    await write("candidate.json", { schema: 2, source, authority });
  }
} else if (operation === "stage") {
  const record = await read("candidate.json");
  await requireFreshCandidate(record);
  const artifacts = await runArtifacts(record.authority.runId);
  if (
    artifacts.some(
      (a) => a.name === `verified-record-${record.authority.attempt}`,
    )
  )
    throw new Error("unexpected preexisting staging receipt");
  await requireEnvironment("staging");
  const { image, supply } = await locateRelease(record);
  record.image = image;
  const recheck = async () => {
    await requireFreshCandidate(record);
    await authenticateRelease(record, image, supply);
    return requireFreshCandidate(record);
  };
  const ci = await recheck();
  try {
    record.deployment = {
      ...(await deployImage(record.image.reference, recheck)),
      url: process.env.APP_ORIGIN,
    };
    const { publicChecks, stagingBrowserChecks } = await import("./smoke.mjs");
    const automated = await verifyDeployment(
      record,
      recheck,
      async (current) => ({
        ...(await publicChecks(current)),
        ...(await stagingBrowserChecks(current)),
      }),
    );
    record.schema = 3;
    record.evidence = {
      ci,
      supply,
      automated,
      observedAt: new Date().toISOString(),
    };
    requireVerifiedRecord(record);
    await write(
      "runtime-evidence/deployment-summary.json",
      await logSummary(record.deployment.id),
    );
    await recheck();
    await write("verified.json", record);
    await summary(
      `Automatically staged ${record.source.commit}. Image ${record.image.reference}. Record SHA-256 ${recordHash(record)}. Email delivery, migration review, and recovery remain production approval attestations.`,
    );
  } catch (error) {
    await reportAppliedFailure(
      error,
      record.deployment,
      record.image.reference,
    );
    throw error;
  }
} else if (operation === "preflight") {
  const authority = await requireController();
  if (authority.attempt !== 1)
    throw new Error(
      "dispatch a new promotion run; approval attempt ambiguity is refused",
    );
  const runId = Number(process.env.STAGING_RUN_ID);
  if (!Number.isSafeInteger(runId) || runId < 1)
    throw new Error("successful staging run ID required");
  const evidence = await stageEvidence(runId);
  const plan = {
    schema: 2,
    authority,
    supply: evidence.record.evidence.supply,
    stagingAuthority: evidence.record.authority,
    artifacts: evidence.artifacts,
    recordHash: recordHash(evidence.record),
    image: evidence.record.image.reference,
    version: process.env.RELEASE_VERSION,
    notes: process.env.RELEASE_NOTES?.trim(),
    recovery: JSON.parse(process.env.RECOVERY_EVIDENCE),
  };
  if (
    !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(plan.version) ||
    !plan.notes ||
    plan.notes.length > 2000
  )
    throw new Error("valid version and short release notes required");
  const migrations = await readArtifact(
    plan.artifacts.metadata,
    "migrations.sql",
  );
  plan.migrationsHash = recordHash(migrations);
  await write("promotion-plan.json", plan);
  await writeFile("migrations.sql", migrations);
  await output(`hash=${recordHash(plan)}`);
  await summary(
    `## Production approval plan\n\nVersion ${plan.version}\n\nSource ${evidence.record.source.commit}\n\nImage ${plan.image}\n\nStaging run ${runId}, attempt ${plan.stagingAuthority.attempt}\n\nRecord SHA-256 ${plan.recordHash}\n\nPlan SHA-256 ${recordHash(plan)}\n\n${plan.notes}\n\nRecovery evidence\n\n\`\`\`json\n${JSON.stringify(plan.recovery, null, 2)}\n\`\`\`\n\nReview the migration artifact. Approval attests to ordinary email delivery, migrations, and rollback compatibility for this exact plan.`,
  );
} else if (operation === "promote") {
  const authority = await requireController();
  if (authority.attempt !== 1)
    throw new Error(
      "dispatch a new promotion run; approval attempt ambiguity is refused",
    );
  const jobs = await attemptJobs(authority);
  const artifact = selectArtifact(
    await runArtifacts(authority.runId),
    "promotion-plan",
    authority,
    jobs.find((j) => j.name === "preflight"),
  );
  if (artifact.id !== Number(process.env.PLAN_ARTIFACT_ID))
    throw new Error("frozen plan artifact ID differs");
  const plan = JSON.parse(await readArtifact(artifact, "promotion-plan.json"));
  if (
    plan.schema !== 2 ||
    recordHash(plan) !== process.env.PLAN_HASH ||
    recordHash(plan.authority) !== recordHash(authority)
  )
    throw new Error("frozen plan changed after approval");
  requireSupplyIdentity(plan.supply, plan.stagingAuthority);
  const approval = {
    runId: authority.runId,
    attempt: authority.attempt,
    recordHash: plan.recordHash,
    reviewers: await requireApproval("production"),
  };
  const evidence = await stageEvidence(plan.stagingAuthority.runId);
  const record = evidence.record;
  const recheck = async () => {
    await requireController();
    const current = await stageEvidence(plan.stagingAuthority.runId);
    if (
      recordHash(current.artifacts) !== recordHash(plan.artifacts) ||
      recordHash(current.record) !== plan.recordHash ||
      current.record.image.reference !== plan.image ||
      recordHash(current.record.evidence.supply) !== recordHash(plan.supply)
    )
      throw new Error("frozen staging evidence changed after approval");
    return requirePromotion(current.record, {
      mainSha: authority.sha,
      mainTree: current.record.source.tree,
      run: current.run,
      jobs: current.jobs,
      approval,
      promotionAuthority: authority,
    });
  };
  const image = await recheck();
  await requireEnvironment("production");
  const migrations = await readArtifact(
    plan.artifacts.metadata,
    "migrations.sql",
  );
  if (recordHash(migrations) !== plan.migrationsHash)
    throw new Error("migration artifact changed");
  await writeFile("migrations.sql", migrations);
  await write("verified.json", record);
  const previous = await inspectRailway();
  if (previous.hasEverDeployed && !previous.activeId)
    throw new Error(
      "production was previously deployed but is not healthy; investigate and recover before promotion",
    );
  const recovery = plan.recovery;
  requireRecovery(recovery, previous.activeId ? previous.image : null);
  const version = plan.version;
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error("release version must be a semantic version tag");
  const notes = plan.notes;
  if (!notes || notes.length > 2000)
    throw new Error("short release notes are required");
  const body = `${notes}\n\nSource ${record.source.commit}\nTree ${record.source.tree}\nImage ${image}\nStaging https://github.com/${repository}/actions/runs/${record.authority.runId}\nRecord SHA-256 ${recordHash(record)}`;
  let release = await github(`repos/${repository}/releases/tags/${version}`, {
    missing: true,
  });
  if (release) {
    const tag = await github(`repos/${repository}/commits/${version}`);
    if (
      tag.sha !== record.source.commit ||
      !release.body.includes(recordHash(record))
    )
      throw new Error("version already belongs to another verified source");
  } else {
    release = await github(`repos/${repository}/releases`, {
      method: "POST",
      body: {
        tag_name: version,
        target_commitish: record.source.commit,
        name: version,
        body,
        draft: true,
      },
    });
  }
  await recheck();
  let deployment;
  try {
    deployment = {
      ...(await deployImage(image, recheck)),
      url: process.env.APP_ORIGIN,
    };
    const { publicChecks } = await import("./smoke.mjs");
    const automated = await verifyDeployment(
      { ...record, deployment },
      recheck,
      publicChecks,
    );

    await write("production.json", {
      version,
      source: record.source.commit,
      image,
      deployment,
      automated,
      recovery,
      verification:
        "readiness, unauthorized refusal, runtime Clerk key and release identity; production email login requires operator confirmation",
      stagedRecordHash: recordHash(record),
      approval,
      planHash: recordHash(plan),
    });
    execFileSync(
      "gh",
      [
        "release",
        "upload",
        version,
        "verified.json",
        "production.json",
        "migrations.sql",
        "--repo",
        repository,
        "--clobber",
      ],
      { stdio: "inherit" },
    );
    await github(`repos/${repository}/releases/${release.id}`, {
      method: "PATCH",
      body: { draft: false },
    });
    console.log(`Released ${version} at ${deployment.id} with ${image}`);
  } catch (error) {
    await reportAppliedFailure(error, deployment, image);
    throw error;
  }
} else {
  throw new Error("unknown trusted release operation");
}
