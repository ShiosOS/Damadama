import { registerHooks } from "node:module";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { record, source, authority, run, jobs } from "../fixtures.mjs";
import { recordHash } from "../policy.mjs";

const scenario = process.argv[2];
const production = scenario.startsWith("production-");
process.argv[2] = production ? "promote" : "stage";
Object.assign(process.env, {
  GH_TOKEN: "fixture",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: source.repository,
  GITHUB_SHA: source.commit,
  GITHUB_RUN_ID: production ? "43" : "42",
  GITHUB_RUN_ATTEMPT: "1",
  APP_ORIGIN: production
    ? "https://prod.damadama.app"
    : "https://staging.damadama.app",
  GITHUB_STEP_SUMMARY: "summary.md",
});
mkdirSync("runtime-evidence");
if (["stage-summary", "production-both-sinks"].includes(scenario))
  mkdirSync("summary.md");
if (["production-outcome-write", "production-both-sinks"].includes(scenario))
  mkdirSync("runtime-evidence/provider-outcome.json");
if (scenario === "stage-write") mkdirSync("verified.json");
if (scenario === "stage-log-write")
  mkdirSync("runtime-evidence/deployment-summary.json");
writeFileSync(
  "candidate.json",
  JSON.stringify({ schema: 2, source, authority }),
);
writeFileSync("build.json", "{}");
if (scenario === "production-write") mkdirSync("production.json");
const staged = record();
const migrations = "CREATE TABLE example (id integer);";
const archives = new Map();
function artifact(id, name, runId, files) {
  const bytes = Buffer.from(JSON.stringify(files));
  archives.set(id, bytes);
  return {
    id,
    name: `${name}-1`,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    expired: false,
    workflow_run: { id: runId, head_sha: source.commit },
    created_at: "2026-10-14T12:03:00Z",
  };
}
const receipt = artifact(1, "verified-record", 42, {
  "verified.json": JSON.stringify(staged),
});
const metadata = artifact(2, "candidate-metadata", 42, {
  "build.json": JSON.stringify({ ...staged.image, source, authority }),
  "migrations.sql": migrations,
});
const selected = ({ id, name, digest }) => ({ id, name, digest });
const plan = {
  schema: 1,
  authority: { ...authority, runId: 43 },
  stagingAuthority: authority,
  artifacts: { receipt: selected(receipt), metadata: selected(metadata) },
  recordHash: recordHash(staged),
  image: staged.image.reference,
  version: "v1.2.3",
  notes: "Operation fixture",
  migrationsHash: recordHash(migrations),
  recovery: {
    backupId: "backup-1",
    completedAt: new Date(Date.now() - 60000).toISOString(),
    retentionDays: 7,
    restoreSeconds: 120,
    restoreEvidence: "https://example.invalid/restore",
    previousImage: null,
    compatibilityEvidence: "initial-release",
  },
};
const planArtifact = artifact(3, "promotion-plan", 43, {
  "promotion-plan.json": JSON.stringify(plan),
});
process.env.PLAN_HASH = recordHash(plan);
process.env.PLAN_ARTIFACT_ID = "3";
globalThis.operationFixture = {
  image: staged.image,
  deployment: {
    ...staged.deployment,
    id: production ? "prod-1" : "deploy-1",
    environmentId: production ? "prod-env" : "stage-1",
    url: process.env.APP_ORIGIN,
  },
  checks: staged.evidence.automated,
  stale: false,
  scenario,
  event(value) {
    appendFileSync("events.jsonl", JSON.stringify(value) + "\n");
  },
  exec(command, args) {
    if (command === "unzip") {
      const files = JSON.parse(readFileSync(args[1], "utf8"));
      return args[0] === "-Z1" ? Object.keys(files).join("\n") : files[args[2]];
    }
    assertUpload(command, args);
    this.event({ type: "upload", args });
    if (
      [
        "production-upload",
        "production-outcome-write",
        "production-both-sinks",
      ].includes(scenario)
    )
      throw Error("release upload failed");
  },
};
function assertUpload(command, args) {
  if (command !== "gh" || args[0] !== "release" || args[1] !== "upload")
    throw Error(`unexpected subprocess ${command} ${args}`);
}
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname;
  let value;
  if (path.endsWith("/zip"))
    return new Response(archives.get(Number(path.split("/").at(-2))));
  if (path.endsWith("/git/ref/heads/main"))
    value = {
      object: { sha: operationFixture.stale ? "3".repeat(40) : source.commit },
    };
  else if (path.endsWith(`/git/commits/${source.commit}`))
    value = { sha: source.commit, tree: { sha: source.tree } };
  else if (path.endsWith("/actions/runs/42")) value = run;
  else if (path.endsWith("/approvals"))
    value = [
      {
        state: "approved",
        environments: [{ name: "production" }],
        user: { id: 7, login: "operator" },
      },
    ];
  else if (path.endsWith("/jobs")) {
    const list = path.includes("/runs/43/")
      ? jobs(["preflight"]).map((j) => ({ ...j, run_id: 43 }))
      : jobs();
    value = { total_count: list.length, jobs: list };
  } else if (path.endsWith("/artifacts")) {
    const list = path.includes("/runs/43/")
      ? [planArtifact]
      : production
        ? [receipt, metadata]
        : [];
    value = { total_count: list.length, artifacts: list };
  } else if (path.endsWith("/releases/tags/v1.2.3"))
    return new Response("", { status: 404 });
  else if (path.endsWith("/releases") && options.method === "POST") {
    operationFixture.event({ type: "draft", body: JSON.parse(options.body) });
    value = { id: 9 };
  } else if (path.endsWith("/releases/9") && options.method === "PATCH") {
    operationFixture.event({ type: "publish", body: JSON.parse(options.body) });
    if (scenario === "production-patch")
      return new Response("", { status: 503 });
    value = { id: 9, draft: false };
  } else throw Error(`unexpected network request ${url}`);
  return new Response(JSON.stringify(value));
};
const adapters = {
  "images.mjs": `export async function prepareArchive(){} export function publishArchive(){return operationFixture.image}`,
  "railway.mjs": `
    export async function requireEnvironment(){}
    export async function inspectRailway(){return {hasEverDeployed:false,activeId:null}}
    export async function deployImage(image, recheck){
      await recheck();
      operationFixture.event({type:'deploy',image});
      if(operationFixture.scenario.endsWith('-deploy'))
        throw Object.assign(Error('deployment observation failed'), {deployment:operationFixture.deployment});
      return operationFixture.deployment;
    }
    export async function observeDeployment(){
      if(operationFixture.scenario.endsWith('-observe')) throw Error('active image observation failed');
    }
    export async function logSummary(){
      if(operationFixture.scenario === 'late-main') operationFixture.stale=true;
      if(operationFixture.scenario === 'stage-log') throw Error('deployment log request failed');
      return {deploymentId:operationFixture.deployment.id};
    }
  `,
  "smoke.mjs": `
    export async function publicChecks(){
      if(operationFixture.scenario.endsWith('-public')) throw Error('public check failed');
      if(operationFixture.scenario.endsWith('-recheck')) operationFixture.stale=true;
      return {readiness:true,unauthorized:true,runtimeConfig:true};
    }
    export async function stagingBrowserChecks(){
      if(operationFixture.scenario === 'stage-browser') throw Error('browser check failed');
      if(operationFixture.scenario === 'stage-invalid') return {...operationFixture.checks, readiness:false};
      return operationFixture.checks;
    }
  `,
  "node:child_process": `export function execFileSync(command,args){return operationFixture.exec(command,args)}`,
};
registerHooks({
  load(url, context, next) {
    const adapter = adapters[url.split("/").pop()];
    return adapter
      ? { format: "module", shortCircuit: true, source: adapter }
      : next(url, context);
  },
});
try {
  await import("../operate.mjs");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
