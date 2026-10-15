import { createHash } from "node:crypto";

export const repository = "ShiosOS/Damadama";
export const actionsAppId = 15368;
const sourceFields = ["repository", "commit", "tree"];
const runtimeChecks = [
  "readiness",
  "unauthorized",
  "runtimeConfig",
  "clerk",
  "habitsBeforeReload",
  "habitsAfterReload",
  "inviteOnly",
  "ownership",
  "signOut",
];

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

export function requireSource(source) {
  requireThat(source?.repository === repository, "wrong repository");
  requireThat(
    Object.keys(source).sort().join(",") === [...sourceFields].sort().join(","),
    "invalid main source fields",
  );
  for (const field of ["commit", "tree"]) {
    requireThat(/^[a-f0-9]{40}$/.test(source[field]), `invalid ${field} SHA`);
  }
  return source;
}

export function requireCurrentSource(source, current) {
  requireSource(source);
  for (const field of sourceFields) {
    requireThat(
      source[field] === current?.[field],
      `stale ${field}; stage current main again`,
    );
  }
}

export function candidateVersion(source) {
  return `main-${source.commit.slice(0, 12)}`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

export function recordHash(record) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(record)))
    .digest("hex");
}

export function requireCIEvidence(
  source,
  jobs,
  authority,
  names = ["release-controls", "check"],
) {
  requireSource(source);
  return names.map((name) => {
    const matches = jobs?.filter((job) => job.name === name) ?? [];
    const job = matches[0];
    requireThat(
      matches.length === 1 &&
        job.head_sha === source.commit &&
        job.run_id === authority?.runId &&
        job.run_attempt === authority?.attempt &&
        job.status === "completed" &&
        job.conclusion === "success" &&
        Number.isSafeInteger(job.id) &&
        job.id > 0 &&
        job.html_url ===
          `https://github.com/${repository}/actions/runs/${authority.runId}/job/${job.id}`,
      `CI ${name} must succeed in the exact main workflow attempt`,
    );
    return job;
  });
}

export function requireStageRun(run, authority, completed = true) {
  requireThat(
    run?.id === authority.runId &&
      run.run_attempt === authority.attempt &&
      run.event === "push" &&
      run.path === ".github/workflows/stage.yml" &&
      run.head_branch === "main" &&
      run.head_sha === authority.sha &&
      run.repository?.full_name === repository &&
      (!completed ||
        (run.status === "completed" && run.conclusion === "success")),
    "record is not from a successful trusted main staging workflow",
  );
}

export function requireVerifiedRecord(record) {
  requireThat(record?.schema === 2, "missing or unsupported release record");
  requireSource(record.source);
  requireCIEvidence(record.source, record.evidence?.ci, record.authority);
  requireThat(
    record.source.commit === record.authority?.sha,
    "source differs from main controller",
  );
  requireThat(
    /^[a-f0-9]{40}$/.test(record.authority?.sha),
    "invalid controller SHA",
  );
  requireThat(
    Number.isSafeInteger(record.authority.runId) && record.authority.runId > 0,
    "invalid controller run",
  );
  requireThat(
    Number.isSafeInteger(record.authority.attempt) &&
      record.authority.attempt > 0,
    "invalid run attempt",
  );
  const image = record.image;
  requireThat(
    /^sha256:[a-f0-9]{64}$/.test(image?.digest),
    "invalid image digest",
  );
  requireThat(
    image.reference === `ghcr.io/shiosos/damadama@${image.digest}`,
    "invalid image reference",
  );
  requireThat(
    /^[a-f0-9]{64}$/.test(image.archiveSha256),
    "invalid archive hash",
  );
  requireThat(
    image.version === candidateVersion(record.source),
    "invalid candidate version",
  );
  requireThat(
    record.deployment?.image === image.reference,
    "deployed image differs from candidate image",
  );
  requireThat(
    typeof record.deployment.id === "string" && record.deployment.id.length > 0,
    "missing deployment ID",
  );
  requireThat(
    typeof record.deployment.environmentId === "string" &&
      record.deployment.environmentId.length > 0,
    "missing environment ID",
  );
  const origin = new URL(record.deployment.url);
  requireThat(
    origin.protocol === "https:" && origin.origin === record.deployment.url,
    "invalid staging origin",
  );
  for (const check of runtimeChecks) {
    requireThat(
      record.evidence?.automated?.[check] === true,
      `missing ${check} runtime evidence`,
    );
  }
  return record;
}

export function requirePromotion(record, current) {
  requireVerifiedRecord(record);
  requireStageRun(current.run, record.authority);
  requireCIEvidence(record.source, current.jobs, record.authority, [
    "release-controls",
    "check",
    "build",
    "stage",
  ]);
  requireThat(
    current.mainSha === record.source.commit &&
      current.mainTree === record.source.tree,
    "current main differs from staged source",
  );
  const approval = current.approval;
  requireThat(
    approval?.runId === current.promotionAuthority?.runId &&
      approval?.attempt === 1 &&
      current.promotionAuthority?.attempt === 1 &&
      approval?.recordHash === recordHash(record) &&
      approval?.reviewers?.length > 0,
    "explicit production approval must bind this run and frozen record",
  );
  return record.image.reference;
}

export function mainRules() {
  const checks = [
    { context: "release-controls", integration_id: actionsAppId },
    { context: "check", integration_id: actionsAppId },
  ];
  return {
    name: "Damadama main",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: false,
          require_extra_approval_for_unattributed_changes: false,
          required_review_thread_resolution: true,
          allowed_merge_methods: ["merge", "squash"],
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: checks,
        },
      },
    ],
  };
}
