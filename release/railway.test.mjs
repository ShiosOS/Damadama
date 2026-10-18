import assert from "node:assert/strict";
import { test } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { deployImage, observeDeployment } from "./railway.mjs";
const image = `ghcr.io/shiosos/damadama@sha256:${"a".repeat(64)}`;
const oldImage = `ghcr.io/shiosos/damadama@sha256:${"b".repeat(64)}`;
const old = { id: "previous", status: "SUCCESS", meta: { image: oldImage } };
const replacement = {
  id: "actual-deployment",
  status: "SUCCESS",
  meta: { image },
};
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

function handoffProvider(
  t,
  {
    previous = [old],
    active = () => [replacement],
    status = () => ({ id: replacement.id, status: "SUCCESS" }),
    intercept = () => {},
  } = {},
) {
  const environment = {
    RAILWAY_TOKEN: "test-only",
    RAILWAY_PROJECT_ID: "project",
    RAILWAY_ENVIRONMENT_ID: "stage",
    RAILWAY_SERVICE_ID: "app",
    RAILWAY_DEPLOYMENT_IMAGE_PATH: "image",
  };
  const saved = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
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
    if (query.startsWith("mutation"))
      state.mutations.push({ query, variables });
    if (query.includes("serviceInstanceUpdate(")) {
      assert.equal(variables.input.source.image, image);
      data = { serviceInstanceUpdate: true };
    } else if (query.includes("serviceInstanceDeployV2(")) {
      state.deployed = true;
      data = { serviceInstanceDeployV2: replacement.id };
    } else if (query.includes("projectToken")) {
      assert.deepEqual(variables, {
        serviceId: process.env.RAILWAY_SERVICE_ID,
        environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
      });
      if (state.deployed) state.observations++;
      data = {
        projectToken: { projectId: "project", environmentId: "stage" },
        serviceInstance: {
          source: { image },
          numReplicas: 1,
          sleepApplication: false,
          healthcheckPath: "/health/ready",
          hasEverDeployed: previous.length > 0,
          activeDeployments: state.deployed ? active(state) : previous,
        },
      };
    } else {
      assert.deepEqual(variables, { id: replacement.id });
      state.polls++;
      data = { deployment: status(state) };
    }
    return (
      intercept({ query, variables, data, state }) ??
      new Response(JSON.stringify({ data }), { status: 200 })
    );
  });
  return state;
}

test("a known previous deployment must drain before the exact replacement succeeds", async (t) => {
  clock(t);
  let drained = false;
  const state = handoffProvider(t, {
    active: () => {
      if (drained) return [replacement];
      return [old, replacement];
    },
  });
  let settled = false;
  let refusal;
  const result = deployImage(image).then(
    (value) => {
      settled = true;
      return { value };
    },
    (error) => {
      settled = true;
      refusal = error;
      return { error };
    },
  );
  await turn();
  assert.equal(
    settled,
    false,
    `known overlap must wait instead of returning or refusing: ${refusal?.message}`,
  );
  assert.ok(state.observations > 0);
  drained = true;
  t.mock.timers.tick(4_999);
  await turn();
  assert.equal(
    settled,
    false,
    "handoff keeps the existing five-second polling cadence",
  );
  t.mock.timers.tick(1);
  await turn();
  assert.deepEqual(await result, { value: applied });
  assert.ok(
    state.observations >= 2,
    "success requires a later strict postdrain read",
  );
  assert.equal(state.mutations.length, 2);
});
test("main supersession at the provider boundary causes zero writes", async (t) => {
  const state = handoffProvider(t);
  await assert.rejects(
    deployImage(image, async () => {
      throw new Error("main superseded");
    }),
    /superseded/,
  );
  assert.equal(state.mutations.length, 0);
});
test("failed observation after mutation retains the actual deployment identity", async (t) => {
  handoffProvider(t, {
    active: () => [{ ...replacement, id: "wrong-replacement" }],
  });
  await assert.rejects(deployImage(image), (error) => {
    assert.deepEqual(error.deployment, {
      id: "actual-deployment",
      environmentId: "stage",
      image,
    });
    return true;
  });
});

async function refusesHandoff(t, options, pattern) {
  clock(t);
  const state = handoffProvider(t, options);
  let outcome;
  const pending = deployImage(image).then(
    (value) => {
      outcome = { value };
    },
    (error) => {
      outcome = { error };
    },
  );
  await turn();
  assert.ok(
    outcome?.error,
    "unsafe handoff must refuse without waiting for a poll",
  );
  assert.match(outcome.error.message, pattern);
  assert.deepEqual(outcome.error.deployment, applied);
  assert.equal(state.mutations.length, 2);
  await pending;
}

for (const startup of [0, 345_000]) {
  test(`persistent known overlap after ${startup}ms startup exhausts the original six-minute budget`, async (t) => {
    clock(t);
    const state = handoffProvider(t, {
      active: () => [old, replacement],
      status: () => {
        if (Date.now() < startup)
          return { id: replacement.id, status: "DEPLOYING" };
        return { id: replacement.id, status: "SUCCESS" };
      },
    });
    let outcome;
    const pending = deployImage(image).then(
      (value) => {
        outcome = { value };
      },
      (error) => {
        outcome = { error };
      },
    );
    await turn();
    for (let elapsed = 5_000; elapsed < 360_000; elapsed += 5_000) {
      t.mock.timers.tick(5_000);
      await turn();
      assert.equal(
        outcome,
        undefined,
        `known overlap still pending at ${elapsed}ms`,
      );
    }
    t.mock.timers.tick(5_000);
    await pending;
    assert.equal(Date.now(), 360_000);
    assert.match(outcome.error.message, /within six minutes/);
    assert.deepEqual(outcome.error.deployment, applied);
    assert.ok(
      state.observations > 0,
      "the exact pair remained active through the original deadline",
    );
    assert.equal(state.mutations.length, 2);
  });
}

const unsafeActiveSets = [
  ["unknown previous deployment", [{ ...old, id: "stranger" }, replacement]],
  ["third deployment", [old, replacement, { ...old, id: "stranger" }]],
  ["duplicate previous participant", [old, old]],
  ["duplicate replacement participant", [replacement, replacement]],
  ["missing replacement", [old]],
  ["no active deployment", []],
  ["wrong previous image", [{ ...old, meta: { image } }, replacement]],
  [
    "wrong replacement image",
    [old, { ...replacement, meta: { image: oldImage } }],
  ],
  ["wrong replacement identity", [old, { ...replacement, id: "stranger" }]],
];
for (const [name, active] of unsafeActiveSets) {
  test(`${name} refuses instead of waiting`, async (t) => {
    await refusesHandoff(t, { active: () => active }, /active deployment/);
  });
}

test("overlap without a captured previous deployment refuses", async (t) => {
  await refusesHandoff(
    t,
    { previous: [], active: () => [old, replacement] },
    /multiple active/,
  );
});

test("a reused deployment ID cannot authorize a distinct old and new handoff", async (t) => {
  await refusesHandoff(
    t,
    {
      previous: [{ ...old, id: replacement.id }],
      active: () => [old, replacement],
    },
    /multiple active/,
  );
});

for (const id of [null, "", 23]) {
  test(`malformed overlap identity ${JSON.stringify(id)} refuses`, async (t) => {
    await refusesHandoff(
      t,
      { active: () => [{ ...old, id }, replacement] },
      /identity is unavailable/,
    );
  });
}

for (const meta of [{}, { image: "ghcr.io/shiosos/damadama:latest" }]) {
  test(`invalid overlap metadata ${JSON.stringify(meta)} refuses`, async (t) => {
    await refusesHandoff(
      t,
      { active: () => [{ ...old, meta }, replacement] },
      /metadata/,
    );
  });
}

test("wrong queried deployment ID refuses before known overlap can wait", async (t) => {
  await refusesHandoff(
    t,
    {
      status: () => ({ id: "stranger", status: "SUCCESS" }),
      active: () => [old, replacement],
    },
    /another deployment identity/,
  );
});

for (const status of ["FAILED", "CRASHED", "REMOVED", "SLEEPING", "SKIPPED"]) {
  test(`terminal ${status} refuses immediately`, async (t) => {
    await refusesHandoff(
      t,
      { status: () => ({ id: replacement.id, status }) },
      /deployment failed/,
    );
  });
}

test("terminal failure after known overlap is not deferred", async (t) => {
  clock(t);
  const state = handoffProvider(t, {
    active: () => [old, replacement],
    status: () => {
      if (Date.now() === 0) return { id: replacement.id, status: "SUCCESS" };
      return { id: replacement.id, status: "CRASHED" };
    },
  });
  let outcome;
  const pending = deployImage(image).catch((error) => {
    outcome = error;
  });
  await turn();
  assert.equal(outcome, undefined);
  assert.ok(state.observations > 0);
  t.mock.timers.tick(5_000);
  await pending;
  assert.match(outcome.message, /deployment failed/);
  assert.deepEqual(outcome.deployment, applied);
  assert.equal(state.mutations.length, 2);
});

for (const [name, alter] of [
  [
    "token environment",
    (data) => {
      data.projectToken.environmentId = "other";
    },
  ],
  [
    "token project",
    (data) => {
      data.projectToken.projectId = "other";
    },
  ],
  [
    "service settings",
    (data) => {
      data.serviceInstance.numReplicas = 2;
    },
  ],
]) {
  test(`changed ${name} refuses instead of waiting`, async (t) => {
    await refusesHandoff(
      t,
      {
        active: () => [old, replacement],
        intercept: ({ query, data, state }) => {
          if (state.deployed && query.includes("projectToken")) alter(data);
        },
      },
      /another environment|one awake replica/,
    );
  });
}

for (const key of ["RAILWAY_ENVIRONMENT_ID", "RAILWAY_SERVICE_ID"]) {
  test(`changed configured ${key} cannot authorize the captured handoff`, async (t) => {
    await refusesHandoff(
      t,
      {
        active: () => [old, replacement],
        intercept: ({ query, data }) => {
          if (query.includes("deployment(id:")) process.env[key] = "other";
          if (query.includes("projectToken"))
            data.projectToken.environmentId =
              process.env.RAILWAY_ENVIRONMENT_ID;
        },
      },
      /multiple active/,
    );
  });
}

for (const [name, response] of [
  ["HTTP failure", () => new Response("unavailable", { status: 503 })],
  [
    "GraphQL failure",
    () => new Response(JSON.stringify({ errors: [{ message: "test-only" }] })),
  ],
  ["missing GraphQL data", () => new Response("{}")],
]) {
  test(`${name} after apply refuses instead of retrying`, async (t) => {
    await refusesHandoff(
      t,
      {
        intercept: ({ query, state }) => {
          if (state.deployed && query.includes("projectToken"))
            return response();
        },
      },
      /Railway API/,
    );
  });
}

test("an unrelated error with the overlap message still refuses immediately", async (t) => {
  await refusesHandoff(
    t,
    {
      intercept: ({ query, state }) => {
        if (state.deployed && query.includes("projectToken"))
          throw new Error(
            "multiple active deployments must drain before verification",
          );
      },
    },
    /multiple active/,
  );
});

test("the strict final deployment query still refuses a wrong response ID", async (t) => {
  await refusesHandoff(
    t,
    {
      status: (state) => {
        if (state.polls === 1) return { id: replacement.id, status: "SUCCESS" };
        return { id: "stranger", status: "SUCCESS" };
      },
    },
    /does not match verified candidate/,
  );
});

test("ambiguous preflight refuses before either provider mutation", async (t) => {
  const state = handoffProvider(t, { previous: [old, replacement] });
  await assert.rejects(deployImage(image), /multiple active/);
  assert.equal(state.mutations.length, 0);
});

test("standalone observer keeps refusing the exact old and new pair", async (t) => {
  const state = handoffProvider(t, { previous: [old, replacement] });
  await assert.rejects(observeDeployment(applied), /multiple active/);
  assert.equal(state.mutations.length, 0);
});

test("initial release requires strict final replacement observation", async (t) => {
  const state = handoffProvider(t, { previous: [] });
  assert.deepEqual(await deployImage(image), applied);
  assert.ok(state.observations > 0);
  assert.equal(state.mutations.length, 2);
});

test("same-image redeploy waits for distinct deployment identities to drain", async (t) => {
  clock(t);
  const sameImageOld = { ...old, meta: { image } };
  const state = handoffProvider(t, {
    previous: [sameImageOld],
    active: () => {
      if (Date.now() === 0) return [replacement, sameImageOld];
      return [replacement];
    },
  });
  let outcome;
  const pending = deployImage(image).then((value) => {
    outcome = value;
  });
  await turn();
  assert.equal(outcome, undefined);
  t.mock.timers.tick(5_000);
  await pending;
  assert.deepEqual(outcome, applied);
  assert.equal(state.mutations.length, 2);
});

test("second mutation guard retains applied source identity and prevents deploy", async (t) => {
  const state = handoffProvider(t);
  let guards = 0;
  await assert.rejects(
    deployImage(image, async () => {
      guards++;
      if (guards === 2) throw new Error("main superseded");
    }),
    (error) => {
      assert.match(error.message, /main superseded/);
      assert.deepEqual(error.deployment, {
        id: null,
        environmentId: "stage",
        image,
      });
      return true;
    },
  );
  assert.equal(guards, 2);
  assert.equal(state.mutations.length, 1);
});
