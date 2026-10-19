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
const preflight = scenario.startsWith("preflight-");
const production = scenario.startsWith("production-") || preflight;
process.argv[2] = production ? "promote" : "stage";
if (preflight) process.argv[2] = "preflight";
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
  GITHUB_OUTPUT: "outputs.txt",
  STAGING_RUN_ID: "42",
  RELEASE_VERSION: "v1.2.3",
  RELEASE_NOTES: "Controlled promotion",
  RECOVERY_EVIDENCE: "{}",
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
  schema: 2,
  supply: staged.evidence.supply,
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
  supply: staged.evidence.supply,
  signedCalls: 0,
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
const realRailway = scenario.includes("-real-");
if (realRailway) {
  const policies = Object.fromEntries(
    ["staging", "production"].map((name) => [
      name,
      {
        railwayProjectId: "project",
        railwayEnvironmentId: name === "staging" ? "stage-1" : "prod-env",
        appServiceId: "app",
        databaseServiceId: "postgres",
        volumeId: name + "-volume",
        backupBucket: name + "-backup",
        databaseName: name + "-db",
        databaseUser: name + "-user",
        clerkApplicationId: name + "-clerk",
        clerkIssuer: "https://" + name + ".clerk.example.com",
        clerkPublishableKey: "pk_live_" + name,
        origin:
          name === "staging"
            ? "https://staging.damadama.app"
            : "https://prod.damadama.app",
      },
    ]),
  );
  Object.assign(process.env, {
    RELEASE_ENVIRONMENTS: JSON.stringify(policies),
    RAILWAY_TOKEN: "synthetic-provider",
    RAILWAY_PROJECT_ID: "project",
    RAILWAY_ENVIRONMENT_ID: operationFixture.deployment.environmentId,
    RAILWAY_SERVICE_ID: "app",
    RAILWAY_DEPLOYMENT_IMAGE_PATH: "image",
  });
  operationFixture.policy = policies[production ? "production" : "staging"];
  operationFixture.providerDeployed = false;
}
globalThis.fetch = async (url, options = {}) => {
  if (url === "https://backboard.railway.com/graphql/v2") {
    if (!realRailway) throw Error("unexpected provider transport");
    const { query, variables } = JSON.parse(options.body);
    const fixture = operationFixture;
    let data;
    if (query.includes("serviceInstanceUpdate(")) {
      fixture.event({
        type: "source",
        image: variables.input.source.image,
        signedCalls: fixture.signedCalls,
      });
      data = { serviceInstanceUpdate: true };
    } else if (query.includes("serviceInstanceDeployV2(")) {
      fixture.providerDeployed = true;
      fixture.event({
        type: "deploy",
        image: fixture.image.reference,
        signedCalls: fixture.signedCalls,
      });
      data = { serviceInstanceDeployV2: fixture.deployment.id };
    } else if (query.includes("projectToken")) {
      data = {
        projectToken: {
          projectId: "project",
          environmentId: fixture.deployment.environmentId,
        },
        serviceInstance: {
          source: { image: fixture.image.reference },
          numReplicas: 1,
          sleepApplication: false,
          healthcheckPath: "/health/ready",
          hasEverDeployed: fixture.providerDeployed,
          activeDeployments: fixture.providerDeployed
            ? [
                {
                  id: fixture.deployment.id,
                  status: "SUCCESS",
                  meta: { image: fixture.image.reference },
                },
              ]
            : [],
        },
      };
    } else if (query.includes("deploymentLogs")) data = { deploymentLogs: [] };
    else if (query.includes("deployment(id:"))
      data = { deployment: { id: fixture.deployment.id, status: "SUCCESS" } };
    else if (query.includes("variables(")) {
      const policy = fixture.policy;
      data = {
        variables: {
          Clerk__Issuer: policy.clerkIssuer,
          Clerk__PublishableKey: policy.clerkPublishableKey,
          Clerk__AuthorizedParties__0: policy.origin,
          ConnectionStrings__habits:
            "Host=db.railway.internal;Database=" +
            policy.databaseName +
            ";Username=" +
            policy.databaseUser +
            ";Password=synthetic",
        },
      };
    } else throw Error("unexpected provider query");
    return new Response(JSON.stringify({ data }));
  }
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
    let list = path.includes("/runs/43/")
      ? jobs(["preflight"]).map((j) => ({ ...j, run_id: 43 }))
      : jobs();
    if (!path.includes("/runs/43/") && scenario.includes("-barrier-")) {
      const result = scenario.split("-").at(-1);
      if (result === "missing") list = list.slice(1);
      else if (result === "duplicate") list.push(list[0]);
      else list[0].conclusion = result;
    }
    value = {
      total_count: scenario.endsWith("-over100") ? 101 : list.length,
      jobs: list,
    };
  } else if (path.endsWith("/artifacts")) {
    let list = [];
    if (path.includes("/runs/43/")) list = [planArtifact];
    else if (production) list = [receipt, metadata];
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
  "supply-release.mjs": `
    export async function locateRelease(){ return {image:operationFixture.image,supply:operationFixture.supply}; }
    export async function authenticateRelease(){
      operationFixture.signedCalls++;
      await new Promise(resolve => setImmediate(resolve));
      const target = Number(operationFixture.scenario.split('-').at(-1));
      if(operationFixture.signedCalls === target){
        if(operationFixture.scenario.includes('-signed-')) throw Error('signed admission refused');
        if(operationFixture.scenario.includes('-native-')) operationFixture.stale=true;
      }
    }
  `,
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
if (realRailway) delete adapters["railway.mjs"];
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
