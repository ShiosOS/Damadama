import { createHash } from "node:crypto";

export const repository = "ShiosOS/Damadama";
export const stagingContext = "staging/verified";
export const actionsAppId = 15368;
const sourceFields = ["repository", "pr", "head", "base", "merge", "tree"];
const runtimeChecks = [
  "readiness",
  "unauthorized",
  "runtimeConfig",
  "clerk",
  "habits",
  "ownership",
  "signOut",
];

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

export function requireSource(source) {
  requireThat(source?.repository === repository, "wrong repository");
  requireThat(Number.isSafeInteger(source.pr) && source.pr > 0, "invalid pr");
  for (const field of ["head", "base", "merge", "tree"]) {
    requireThat(/^[a-f0-9]{40}$/.test(source[field]), `invalid ${field} SHA`);
  }
  return source;
}

export function requireCurrentSource(source, current) {
  requireSource(source);
  for (const field of sourceFields) {
    requireThat(
      source[field] === current?.[field],
      `stale ${field}; stage the current proposed result again`,
    );
  }
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

export function requireVerifiedRecord(record) {
  requireThat(record?.schema === 1, "missing or unsupported release record");
  requireSource(record.source);
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
    image.version ===
      `pr-${record.source.pr}-${record.source.head.slice(0, 12)}-${record.source.base.slice(0, 12)}`,
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
  for (const check of ["email", "migrations", "rollback"]) {
    requireThat(
      record.evidence?.operator?.[check] === "approved-attestation",
      `missing operator ${check} attestation`,
    );
  }
  requireThat(
    record.evidence.operator.approvalRunId === record.authority.runId,
    "operator approved another run",
  );
  return record;
}

export function requirePromotion(record, current) {
  requireVerifiedRecord(record);
  requireThat(
    current.approved === true,
    "explicit production approval is required",
  );
  requireThat(current.merged === true, "PR is not merged");
  requireThat(
    current.mergedHead === record.source.head,
    "merged head differs from staged head",
  );
  requireThat(
    current.mergeCommit === current.mainSha,
    "merged result is not current main",
  );
  requireThat(
    current.mainTree === record.source.tree,
    "current main tree differs from staged tree",
  );
  requireThat(
    Number.isSafeInteger(current.appId) &&
      current.appId > 0 &&
      current.appId !== actionsAppId,
    "dedicated verifier App is required",
  );
  const check = current.check;
  requireThat(
    check?.app?.id === current.appId,
    "staging check came from another App",
  );
  requireThat(
    check.name === stagingContext &&
      check.status === "completed" &&
      check.conclusion === "success",
    "staging check is not successful",
  );
  requireThat(
    check.head_sha === record.source.merge,
    "staging check is not on the proposed merge",
  );
  requireThat(
    check.external_id === recordHash(record),
    "staging record hash differs from verified check",
  );
  requireThat(
    check.details_url ===
      `https://github.com/${repository}/actions/runs/${record.authority.runId}`,
    "staging check points to another run",
  );
  const run = current.run;
  requireThat(
    run?.id === record.authority.runId &&
      run.run_attempt === record.authority.attempt &&
      run.event === "workflow_dispatch" &&
      run.path === ".github/workflows/stage.yml" &&
      run.head_branch === "main" &&
      run.head_sha === record.authority.sha &&
      run.conclusion === "success",
    "record is not from a successful trusted staging workflow",
  );
  return record.image.reference;
}

export function mainRules(appId, bootstrap = false) {
  requireThat(
    bootstrap ||
      (Number.isSafeInteger(appId) && appId > 0 && appId !== actionsAppId),
    "a dedicated verifier App ID is required",
  );
  const checks = [
    { context: "release-controls", integration_id: actionsAppId },
  ];
  if (!bootstrap)
    checks.push(
      { context: "check", integration_id: actionsAppId },
      { context: stagingContext, integration_id: appId },
    );
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
          required_approving_review_count: 1,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: true,
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
