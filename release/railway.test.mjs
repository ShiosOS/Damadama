import assert from "node:assert/strict";
import { test } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { deployImage, observeDeployment } from "./railway.mjs";
const image = `ghcr.io/shiosos/damadama@sha256:${"a".repeat(64)}`;
const oldImage = `ghcr.io/shiosos/damadama@sha256:${"b".repeat(64)}`;
const old = { id: "previous", status: "SUCCESS", meta: { image: oldImage } };
const replacement = { id: "actual-deployment", status: "SUCCESS", meta: { image } };
const applied = { id: replacement.id, environmentId: "stage", image };
const turn = () => new Promise((resolve) => setImmediate(resolve));

function clock(t) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.timers.reset();
    syncBuiltinESMExports();
  });
}

function handoffProvider(t, { previous = [old], active = () => [replacement], status = () => ({ id: replacement.id, status: "SUCCESS" }), intercept = () => {} } = {}) {
  const environment = {
    RAILWAY_TOKEN: "test-only",
    RAILWAY_PROJECT_ID: "project",
    RAILWAY_ENVIRONMENT_ID: "stage",
    RAILWAY_SERVICE_ID: "app",
    RAILWAY_DEPLOYMENT_IMAGE_PATH: "image",
  };
  const saved = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const state = { mutations: [], observations: 0, polls: 0, deployed: false };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://backboard.railway.com/graphql/v2");
    const { query, variables } = JSON.parse(options.body);
    assert.ok(options.signal instanceof AbortSignal);
    let data;
    if (query.startsWith("mutation")) state.mutations.push({ query, variables });
    if (query.includes("serviceInstanceUpdate(")) {
      assert.equal(variables.input.source.image, image);
      data = { serviceInstanceUpdate: true };
    } else if (query.includes("serviceInstanceDeployV2(")) {
      state.deployed = true;
      data = { serviceInstanceDeployV2: replacement.id };
    } else if (query.includes("projectToken")) {
      assert.deepEqual(variables, { serviceId: "app", environmentId: "stage" });
      if (state.deployed) state.observations++;
      data = {
        projectToken: { projectId: "project", environmentId: "stage" },
        serviceInstance: {
          source: { image }, numReplicas: 1, sleepApplication: false,
          healthcheckPath: "/health/ready", hasEverDeployed: previous.length > 0,
          activeDeployments: state.deployed ? active(state) : previous,
        },
      };
    } else {
      assert.deepEqual(variables, { id: replacement.id });
      state.polls++;
      data = { deployment: status(state) };
    }
    return intercept({ query, variables, data, state }) ?? new Response(JSON.stringify({ data }), { status: 200 });
  });
  return state;
}

test("a known previous deployment must drain before the exact replacement succeeds", async (t) => {
  clock(t);
  let drained = false;
  const state = handoffProvider(t, { active: () => {
    if (drained) return [replacement];
    return [old, replacement];
  } });
  let settled = false;
  let refusal;
  const result = deployImage(image).then(
    (value) => { settled = true; return { value }; },
    (error) => { settled = true; refusal = error; return { error }; },
  );
  await turn();
  assert.equal(settled, false, `known overlap must wait instead of returning or refusing: ${refusal?.message}`);
  assert.ok(state.observations > 0);
  drained = true;
  t.mock.timers.tick(4_999);
  await turn();
  assert.equal(settled, false, "handoff keeps the existing five-second polling cadence");
  t.mock.timers.tick(1);
  await turn();
  assert.deepEqual(await result, { value: applied });
  assert.ok(state.observations >= 2, "success requires a later strict postdrain read");
  assert.equal(state.mutations.length, 2);
});
function provider(t, failObservation = false) {
  Object.assign(process.env, {
    RAILWAY_TOKEN: "test-only",
    RAILWAY_PROJECT_ID: "project",
    RAILWAY_ENVIRONMENT_ID: "stage",
    RAILWAY_SERVICE_ID: "app",
    RAILWAY_DEPLOYMENT_IMAGE_PATH: "image",
  });
  const mutations = [];
  let deployed = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://backboard.railway.com/graphql/v2");
    const { query } = JSON.parse(options.body);
    let data;
    const deploymentId = failObservation ? "replacement" : "actual-deployment";
    if (query.startsWith("mutation")) mutations.push(query);
    if (query.includes("serviceInstanceUpdate("))
      data = { serviceInstanceUpdate: true };
    else if (query.includes("serviceInstanceDeployV2(")) {
      deployed = true;
      data = { serviceInstanceDeployV2: "actual-deployment" };
    } else if (query.includes("projectToken"))
      data = {
        projectToken: { projectId: "project", environmentId: "stage" },
        serviceInstance: {
          source: { image },
          numReplicas: 1,
          sleepApplication: false,
          healthcheckPath: "/health/ready",
          hasEverDeployed: deployed,
          activeDeployments: deployed
            ? [
                {
                  id: deploymentId,
                  status: "SUCCESS",
                  meta: { image },
                },
              ]
            : [],
        },
      };
    else data = { deployment: { id: "actual-deployment", status: "SUCCESS" } };
    return new Response(JSON.stringify({ data }), { status: 200 });
  });
  return mutations;
}
test("main supersession at the provider boundary causes zero writes", async (t) => {
  const mutations = provider(t);
  await assert.rejects(
    deployImage(image, async () => {
      throw new Error("main superseded");
    }),
    /superseded/,
  );
  assert.equal(mutations.length, 0);
});
test("failed observation after mutation retains the actual deployment identity", async (t) => {
  provider(t, true);
  await assert.rejects(deployImage(image), (error) => {
    assert.deepEqual(error.deployment, {
      id: "actual-deployment",
      environmentId: "stage",
      image,
    });
    return true;
  });
});
