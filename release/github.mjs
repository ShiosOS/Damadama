import { execFileSync } from "node:child_process";
import { repository, requireSource, requireCIEvidence } from "./policy.mjs";

export async function github(
  path,
  { method = "GET", body, token, missing = false } = {},
) {
  const credential =
    token ??
    process.env.GH_TOKEN ??
    execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  const attempts = method === "GET" && body === undefined ? 3 : 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(`https://api.github.com/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${credential}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (missing && response.status === 404) return null;
      if (!response.ok)
        throw new Error(`GitHub ${method} ${path} returned ${response.status}`);
      if (response.status === 204) return null;
      return await response.json();
    } catch (error) {
      if (
        attempts === 1 ||
        !(error instanceof TypeError) ||
        error.cause?.code !== "UND_ERR_SOCKET"
      )
        throw error;
      if (attempt === attempts) {
        error.message = `GitHub ${method} ${path} failed after ${attempt} attempts: ${error.message}`;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
}

export async function captureSource(prNumber) {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1)
    throw new Error("invalid PR number");
  const pr = await github(`repos/${repository}/pulls/${prNumber}`);
  if (
    pr.state !== "open" ||
    pr.base.ref !== "main" ||
    pr.head.repo?.full_name !== repository
  ) {
    throw new Error(
      "candidate must be an open same-repository PR targeting main",
    );
  }
  const main = await github(`repos/${repository}/git/ref/heads/main`);
  if (main.object.sha !== pr.base.sha)
    throw new Error("base moved while capturing candidate; retry");
  if (!pr.merge_commit_sha)
    throw new Error("proposed merge unavailable; resolve conflicts or retry");
  const merge = await github(
    `repos/${repository}/git/commits/${pr.merge_commit_sha}`,
  );
  const comparison = await github(
    `repos/${repository}/compare/${pr.base.sha}...${pr.head.sha}`,
  );
  const head = await github(`repos/${repository}/git/commits/${pr.head.sha}`);
  if (
    !["ahead", "identical"].includes(comparison.status) ||
    head.tree.sha !== merge.tree.sha
  )
    throw new Error(
      "update the PR branch against current main before staging; CI head tree must equal proposed tree",
    );
  if (
    merge.parents.length !== 2 ||
    merge.parents[0].sha !== pr.base.sha ||
    merge.parents[1].sha !== pr.head.sha
  ) {
    throw new Error(
      "proposed merge parents do not match current base and head",
    );
  }
  return requireSource({
    repository,
    pr: prNumber,
    head: pr.head.sha,
    base: pr.base.sha,
    merge: merge.sha,
    tree: merge.tree.sha,
  });
}

export async function requireCI(source) {
  const checks = await github(
    `repos/${repository}/commits/${source.head}/check-runs?per_page=100&filter=latest`,
  );
  return requireCIEvidence(source, checks.check_runs);
}
