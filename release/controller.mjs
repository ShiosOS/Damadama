import { github, captureSource, requireCI } from "./github.mjs";
import { repository, requireCurrentSource, recordHash } from "./policy.mjs";

export async function requireController() {
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

export async function requireFreshCandidate(record) {
  const authority = await requireController();
  if (recordHash(record.authority) !== recordHash(authority))
    throw new Error("candidate belongs to another controller run");
  requireCurrentSource(
    record.source,
    await captureSource(record.source.commit),
  );
  return requireCI(record.source, authority);
}

export async function requireApproval(environment) {
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
