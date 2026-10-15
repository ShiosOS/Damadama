import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  repository,
  requireSource,
  requireCIEvidence,
  requireStageRun,
} from "./policy.mjs";

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

export async function captureSource(commit = process.env.GITHUB_SHA) {
  const main = await github(`repos/${repository}/git/ref/heads/main`);
  if (main.object.sha !== commit)
    throw new Error("main superseded the selected source");
  const object = await github(`repos/${repository}/git/commits/${commit}`);
  if (object.sha !== commit) throw new Error("source commit response differs");
  return requireSource({ repository, commit, tree: object.tree.sha });
}

export async function attemptJobs(authority) {
  const result = await github(
    `repos/${repository}/actions/runs/${authority.runId}/attempts/${authority.attempt}/jobs?per_page=100`,
  );
  if (result.total_count > 100 || !Array.isArray(result.jobs))
    throw new Error("ambiguous workflow jobs");
  return result.jobs;
}

export async function requireCI(source, authority) {
  const run = await github(
    `repos/${repository}/actions/runs/${authority.runId}`,
  );
  requireStageRun(run, authority, false);
  if (source.commit !== authority.sha)
    throw new Error("main source differs from controller");
  return requireCIEvidence(source, await attemptJobs(authority), authority);
}

export async function runArtifacts(runId) {
  const result = await github(
    `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
  );
  if (result.total_count > 100 || !Array.isArray(result.artifacts))
    throw new Error("ambiguous run artifacts");
  return result.artifacts;
}

export function selectArtifact(artifacts, prefix, authority, producer) {
  const matches = artifacts.filter(
    (artifact) => artifact.name === `${prefix}-${authority.attempt}`,
  );
  const artifact = matches[0];
  if (
    matches.length !== 1 ||
    !Number.isSafeInteger(artifact.id) ||
    artifact.id < 1 ||
    artifact.expired !== false ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) ||
    artifact.workflow_run?.id !== authority.runId ||
    artifact.workflow_run?.head_sha !== authority.sha ||
    producer?.run_id !== authority.runId ||
    producer?.run_attempt !== authority.attempt ||
    producer?.conclusion !== "success" ||
    producer?.status !== "completed" ||
    !(Date.parse(artifact.created_at) >= Date.parse(producer.started_at)) ||
    !(Date.parse(artifact.created_at) <= Date.parse(producer.completed_at))
  )
    throw new Error(`untrusted or ambiguous ${prefix} artifact`);
  return { id: artifact.id, name: artifact.name, digest: artifact.digest };
}

export async function readArtifact(artifact, file) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok)
    throw new Error(`artifact download returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== artifact.digest)
    throw new Error("artifact ZIP transport digest differs");
  const directory = await mkdtemp(join(tmpdir(), "damadama-artifact-"));
  try {
    const archive = join(directory, "artifact.zip");
    await writeFile(archive, bytes);
    const names = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/);
    if (names.filter((name) => name === file).length !== 1)
      throw new Error("artifact file is missing or ambiguous");
    return execFileSync("unzip", ["-p", archive, file], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
