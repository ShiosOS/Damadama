export const source = {
  repository: "ShiosOS/Damadama",
  commit: "1".repeat(40),
  tree: "2".repeat(40),
};
export const authority = { sha: source.commit, runId: 42, attempt: 1 };
export const run = {
  id: 42,
  run_attempt: 1,
  event: "push",
  path: ".github/workflows/stage.yml",
  head_branch: "main",
  head_sha: source.commit,
  repository: { full_name: source.repository },
  status: "completed",
  conclusion: "success",
};
export const jobs = (names = ["release-controls", "check", "build", "stage"]) =>
  names.map((name, i) => ({
    name,
    id: 100 + i,
    run_id: 42,
    run_attempt: 1,
    head_sha: source.commit,
    status: "completed",
    conclusion: "success",
    html_url: `https://github.com/ShiosOS/Damadama/actions/runs/42/job/${100 + i}`,
    started_at: "2026-10-14T12:00:00Z",
    completed_at: "2026-10-14T12:05:00Z",
  }));
export const record = () => ({
  schema: 3,
  source: { ...source },
  authority: { ...authority },
  image: {
    reference: `ghcr.io/shiosos/damadama@sha256:${"a".repeat(64)}`,
    digest: `sha256:${"a".repeat(64)}`,
    archiveSha256: "b".repeat(64),
    version: "main-111111111111",
  },
  deployment: {
    id: "deploy-1",
    environmentId: "stage-1",
    url: "https://staging.damadama.app",
    image: `ghcr.io/shiosos/damadama@sha256:${"a".repeat(64)}`,
  },
  evidence: {
    supply: {
      schema: 1,
      artifact: {
        id: 90,
        name: "supply-release-1",
        digest: `sha256:${"c".repeat(64)}`,
        size: 100,
      },
      signer: { id: 80, name: "sign" },
      manifestSha256: "d".repeat(64),
    },
    ci: jobs().slice(0, 2),
    automated: {
      readiness: true,
      unauthorized: true,
      runtimeConfig: true,
      clerk: true,
      habitsBeforeReload: true,
      habitsAfterReload: true,
      ownership: true,
      signOut: true,
      inviteOnly: true,
    },
  },
});
