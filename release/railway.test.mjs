import assert from "node:assert/strict";
import { test } from "node:test";
import { deployImage } from "./railway.mjs";
const image = `ghcr.io/shiosos/damadama@sha256:${"a".repeat(64)}`;
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
                  id: failObservation ? "replacement" : "actual-deployment",
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
