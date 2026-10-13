import { github } from "./github.mjs";
import { requireFreshCandidate, requireApproval } from "./controller.mjs";
import { repository } from "./policy.mjs";
import { prepareArchive, publishArchive } from "./images.mjs";

async function requireBuilds(authority) {
  const run = await github(
    `repos/${repository}/actions/runs/${authority.runId}`,
  );
  if (
    run.id !== authority.runId ||
    run.run_attempt !== authority.attempt ||
    run.event !== "workflow_dispatch" ||
    run.path !== ".github/workflows/publish-images.yml" ||
    run.head_branch !== "main" ||
    run.head_sha !== authority.sha ||
    run.repository?.full_name !== repository ||
    run.status !== "in_progress"
  )
    throw new Error(
      "images must come from the current trusted publication workflow",
    );
  const { jobs } = await github(
    `repos/${repository}/actions/runs/${authority.runId}/attempts/${authority.attempt}/jobs?per_page=100`,
  );
  for (const name of ["source", "build-app", "build-recovery"]) {
    const job = jobs.find((job) => job.name === name);
    if (
      job?.run_id !== authority.runId ||
      job.head_sha !== authority.sha ||
      job.status !== "completed" ||
      job.conclusion !== "success"
    )
      throw new Error(
        `publication ${name} must succeed for this controller attempt`,
      );
  }
}

export async function publishImages(record, archives, execute) {
  await requireFreshCandidate(record);
  await requireBuilds(record.authority);
  const reviewers = await requireApproval("image-publication");
  const commit = await github(
    `repos/${repository}/git/commits/${record.authority.sha}`,
  );
  const recoverySource = {
    repository,
    commit: commit.sha,
    tree: commit.tree.sha,
  };
  const application = await prepareArchive(
    "application",
    archives.application.archivePath,
    archives.application.build,
    record.source,
    record.authority,
  );
  const recovery = await prepareArchive(
    "recovery",
    archives.recovery.archivePath,
    archives.recovery.build,
    recoverySource,
    record.authority,
  );
  await requireFreshCandidate(record);
  const applicationImage = publishArchive(application, execute);
  await requireFreshCandidate(record);
  const recoveryImage = publishArchive(recovery, execute);
  const ci = await requireFreshCandidate(record);
  return {
    schema: 1,
    kind: "image-publication",
    authority: record.authority,
    reviewers,
    application: { source: record.source, image: applicationImage },
    recovery: { source: recoverySource, image: recoveryImage },
    evidence: { ci },
  };
}
