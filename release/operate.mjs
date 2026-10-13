import { readFile, writeFile, appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { github, captureSource, requireCI } from "./github.mjs";
import {
  repository,
  requireCurrentSource,
  requireVerifiedRecord,
  requirePromotion,
  recordHash,
  stagingContext,
} from "./policy.mjs";
import {
  deployImage,
  inspectRailway,
  observeDeployment,
  logSummary,
  requireEnvironment,
} from "./railway.mjs";
import { requireRecovery } from "./runtime.mjs";

const operation = process.argv[2];
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
const write = async (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2));

async function controller() {
  if (
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_REPOSITORY !== repository
  )
    throw new Error("release controls must run on main in Damadama");
  const main = await github(`repos/${repository}/git/ref/heads/main`);
  if (main.object.sha !== process.env.GITHUB_SHA)
    throw new Error(
      "main advanced while this controller was queued; dispatch again",
    );
  return {
    sha: process.env.GITHUB_SHA,
    runId: Number(process.env.GITHUB_RUN_ID),
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  };
}

async function fresh(record) {
  const authority = await controller();
  if (recordHash(record.authority) !== recordHash(authority))
    throw new Error("candidate belongs to another controller run");
  requireCurrentSource(record.source, await captureSource(record.source.pr));
  await requireCI(record.source);
}

async function approval(environment) {
  const reviews = await github(
    `repos/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}/approvals`,
  );
  const accepted = reviews.filter(
    (review) =>
      review.state === "approved" &&
      review.environments.some((env) => env.name === environment),
  );
  if (!accepted.length)
    throw new Error(`explicit ${environment} environment approval is missing`);
  return accepted.map((review) => ({
    id: review.user.id,
    login: review.user.login,
  }));
}

async function promotionFacts(record) {
  await controller();
  const pr = await github(`repos/${repository}/pulls/${record.source.pr}`);
  const main = await github(`repos/${repository}/commits/main`);
  const checks = await github(
    `repos/${repository}/commits/${record.source.merge}/check-runs?per_page=100&filter=latest`,
  );
  const appId = Number(process.env.RELEASE_GATE_APP_ID);
  const check = checks.check_runs.find(
    (check) =>
      check.name === stagingContext &&
      check.app.id === appId &&
      check.external_id === recordHash(record),
  );
  const run = await github(
    `repos/${repository}/actions/runs/${record.authority.runId}`,
  );
  return {
    approved: (await approval("production")).length > 0,
    mainSha: main.sha,
    mainTree: main.commit.tree.sha,
    merged: pr.merged,
    mergedHead: pr.head.sha,
    mergeCommit: pr.merge_commit_sha,
    appId,
    check,
    run,
  };
}

if (operation === "snapshot") {
  const authority = await controller();
  const source = await captureSource(Number(process.env.PR_NUMBER));
  await requireCI(source);
  await write("source.json", source);
  await write("candidate.json", { schema: 1, source, authority });
  await appendFile(process.env.GITHUB_OUTPUT, `merge=${source.merge}\n`);
} else if (operation === "stage") {
  const record = await read("candidate.json");
  await fresh(record);
  await approval("staging");
  await requireEnvironment("staging");
  const build = await read("build.json");
  const archive = createHash("sha256")
    .update(await readFile("image.tar"))
    .digest("hex");
  if (
    archive !== build.archiveSha256 ||
    build.version !==
      `pr-${record.source.pr}-${record.source.head.slice(0, 12)}-${record.source.base.slice(0, 12)}`
  )
    throw new Error("image archive or version differs from build record");
  execFileSync("docker", ["load", "--input", "image.tar"], {
    stdio: "inherit",
  });
  execFileSync(
    "docker",
    [
      "login",
      "ghcr.io",
      "--username",
      process.env.GITHUB_ACTOR,
      "--password-stdin",
    ],
    { input: process.env.GH_TOKEN, stdio: ["pipe", "inherit", "inherit"] },
  );
  const tag = `ghcr.io/shiosos/damadama:${build.version}-${record.authority.runId}-${record.authority.attempt}`;
  execFileSync("docker", ["tag", "damadama-candidate", tag], {
    stdio: "inherit",
  });
  const output = execFileSync("docker", ["push", tag], {
    encoding: "utf8",
    timeout: 180_000,
  });
  const digest = output.match(/digest: (sha256:[a-f0-9]{64})/)?.[1];
  if (!digest) throw new Error("registry did not return an immutable digest");
  record.image = {
    reference: `ghcr.io/shiosos/damadama@${digest}`,
    digest,
    archiveSha256: archive,
    version: build.version,
  };
  execFileSync("docker", ["manifest", "inspect", record.image.reference], {
    stdio: "ignore",
  });
  await fresh(record);
  record.deployment = {
    ...(await deployImage(record.image.reference)),
    url: process.env.APP_ORIGIN,
  };
  await observeDeployment(record.deployment);
  const { publicChecks, stagingBrowserChecks } = await import("./smoke.mjs");
  record.evidence = {
    automated: {
      ...(await publicChecks(record)),
      ...(await stagingBrowserChecks(record)),
    },
    observedAt: new Date().toISOString(),
  };
  await observeDeployment(record.deployment);
  await fresh(record);
  await write("staged.json", record);
  await write(
    "runtime-evidence/deployment-summary.json",
    await logSummary(record.deployment.id),
  );
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `Candidate ${record.image.version}\n\nImage ${record.image.reference}\n\nDeployment ${record.deployment.id}\n\nOrigin ${record.deployment.url}\n\nAutomated Clerk ticket sessions passed. Email delivery remains a required human attestation. Review migrations.sql and complete the runbook before approving staging-verification.\n`,
  );
} else if (operation === "approve") {
  const record = await read("staged.json");
  await fresh(record);
  await requireEnvironment("staging");
  await observeDeployment(record.deployment);
  const reviewers = await approval("staging-verification");
  record.evidence.operator = {
    approvalRunId: record.authority.runId,
    reviewers,
    email: "approved-attestation",
    migrations: "approved-attestation",
    rollback: "approved-attestation",
  };
  requireVerifiedRecord(record);
  await write("verified.json", record);
} else if (operation === "publish-check") {
  const record = requireVerifiedRecord(await read("verified.json"));
  await fresh(record);
  await requireEnvironment("staging");
  await observeDeployment(record.deployment);
  await approval("staging-verification");
  if (!process.env.STAGING_CHECK_TOKEN)
    throw new Error("dedicated verifier token is required");
  await github(`repos/${repository}/check-runs`, {
    method: "POST",
    token: process.env.STAGING_CHECK_TOKEN,
    body: {
      name: stagingContext,
      head_sha: record.source.merge,
      status: "completed",
      conclusion: "success",
      external_id: recordHash(record),
      details_url: `https://github.com/${repository}/actions/runs/${record.authority.runId}`,
      output: {
        title: "Current proposed result verified in staging",
        summary: `Image ${record.image.reference}. Source tree ${record.source.tree}. Automated runtime and actual Clerk ticket-session checks passed. A protected approval attests to actual email-code delivery, migration review, and rollback compatibility. Verified record SHA-256 ${recordHash(record)}.`,
      },
    },
  });
} else if (operation === "promotion-source") {
  await controller();
  const runId = Number(process.env.STAGING_RUN_ID);
  if (!Number.isSafeInteger(runId) || runId < 1)
    throw new Error("a successful staging run ID is required");
  const run = await github(`repos/${repository}/actions/runs/${runId}`);
  if (
    run.event !== "workflow_dispatch" ||
    run.path !== ".github/workflows/stage.yml" ||
    run.head_branch !== "main" ||
    run.conclusion !== "success"
  )
    throw new Error("promotion requires a successful trusted staging run");
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `artifact=verified-record-${run.run_attempt}\nimageArtifact=candidate-metadata-${run.run_attempt}\n`,
  );
} else if (operation === "promote") {
  const record = requireVerifiedRecord(await read("verified.json"));
  if (record.authority.runId !== Number(process.env.STAGING_RUN_ID))
    throw new Error("record belongs to another staging run");
  const current = await promotionFacts(record);
  const image = requirePromotion(record, current);
  await requireEnvironment("production");
  const build = await read("build.json");
  if (
    build.archiveSha256 !== record.image.archiveSha256 ||
    build.version !== record.image.version
  )
    throw new Error("promotion metadata differs from verified image");
  const previous = await inspectRailway();
  if (previous.hasEverDeployed && !previous.activeId)
    throw new Error(
      "production was previously deployed but is not healthy; investigate and recover before promotion",
    );
  const recovery = JSON.parse(process.env.RECOVERY_EVIDENCE);
  requireRecovery(recovery, previous.activeId ? previous.image : null);
  const version = process.env.RELEASE_VERSION;
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error("release version must be a semantic version tag");
  const notes = process.env.RELEASE_NOTES?.trim();
  if (!notes || notes.length > 2000)
    throw new Error("short release notes are required");
  const body = `${notes}\n\nSource ${current.mainSha}\nTree ${record.source.tree}\nImage ${image}\nStaging https://github.com/${repository}/actions/runs/${record.authority.runId}\nRecord SHA-256 ${recordHash(record)}`;
  let release = await github(`repos/${repository}/releases/tags/${version}`, {
    missing: true,
  });
  if (release) {
    const tag = await github(`repos/${repository}/commits/${version}`);
    if (
      tag.sha !== current.mainSha ||
      !release.body.includes(recordHash(record))
    )
      throw new Error("version already belongs to another verified source");
  } else {
    release = await github(`repos/${repository}/releases`, {
      method: "POST",
      body: {
        tag_name: version,
        target_commitish: current.mainSha,
        name: version,
        body,
        draft: true,
      },
    });
  }
  requirePromotion(record, await promotionFacts(record));
  const deployment = {
    ...(await deployImage(image)),
    url: process.env.APP_ORIGIN,
  };
  await observeDeployment(deployment);
  const { publicChecks } = await import("./smoke.mjs");
  await publicChecks({ ...record, deployment });
  requirePromotion(record, await promotionFacts(record));
  await write("production.json", {
    version,
    source: current.mainSha,
    image,
    deployment,
    recovery,
    verification:
      "readiness, unauthorized refusal, runtime Clerk key and release identity; production email login requires operator confirmation",
    stagedRecordHash: recordHash(record),
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
} else {
  throw new Error("unknown trusted release operation");
}
