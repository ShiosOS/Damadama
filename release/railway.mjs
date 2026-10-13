import { setTimeout } from "node:timers/promises";
import {
  requireLiveImage,
  requireIsolation,
  deployedImage,
} from "./runtime.mjs";

function configuration() {
  const {
    RAILWAY_TOKEN: token,
    RAILWAY_PROJECT_ID: projectId,
    RAILWAY_ENVIRONMENT_ID: environmentId,
    RAILWAY_SERVICE_ID: serviceId,
  } = process.env;
  if (![token, projectId, environmentId, serviceId].every(Boolean))
    throw new Error(
      "Railway environment token and project/environment/service IDs are required",
    );
  return { token, projectId, environmentId, serviceId };
}

async function query(query, variables = {}) {
  const { token } = configuration();
  const response = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: {
      "Project-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Railway API returned ${response.status}`);
  const body = await response.json();
  if (body.errors?.length || !body.data)
    throw new Error(
      "Railway API rejected operation; inspect provider logs without exposing credentials",
    );
  return body.data;
}

export async function inspectRailway() {
  const config = configuration();
  const data = await query(
    "query($serviceId:String!,$environmentId:String!){projectToken{projectId environmentId} serviceInstance(serviceId:$serviceId,environmentId:$environmentId){source{image repo} numReplicas sleepApplication healthcheckPath hasEverDeployed activeDeployments{id status meta} latestDeployment{id status}}}",
    { serviceId: config.serviceId, environmentId: config.environmentId },
  );
  if (
    data.projectToken.projectId !== config.projectId ||
    data.projectToken.environmentId !== config.environmentId
  )
    throw new Error("Railway token belongs to another environment");
  const instance = data.serviceInstance;
  if (
    instance.source?.repo ||
    instance.numReplicas !== 1 ||
    instance.sleepApplication !== false ||
    instance.healthcheckPath !== "/health/ready"
  )
    throw new Error(
      "Railway app must use an image, one awake replica, and readiness healthcheck",
    );
  const active = instance.activeDeployments.filter(
    (deployment) => deployment.status === "SUCCESS",
  );
  if (active.length > 1)
    throw new Error(
      "multiple active deployments must drain before verification",
    );
  return {
    image: active[0]
      ? deployedImage(active[0].meta, process.env.RAILWAY_DEPLOYMENT_IMAGE_PATH)
      : null,
    configuredImage: instance.source?.image ?? null,
    hasEverDeployed: instance.hasEverDeployed,
    activeId: active[0]?.id ?? null,
    environmentId: config.environmentId,
    serviceId: config.serviceId,
  };
}

export async function requireEnvironment(name) {
  const policy = requireIsolation(JSON.parse(process.env.RELEASE_ENVIRONMENTS))[
    name
  ];
  const config = configuration();
  if (
    policy.railwayProjectId !== config.projectId ||
    policy.railwayEnvironmentId !== config.environmentId ||
    policy.appServiceId !== config.serviceId
  )
    throw new Error(
      "Railway configuration differs from environment isolation policy",
    );
  const data = await query(
    "query($projectId:String!,$environmentId:String!,$serviceId:String!){variables(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId)}",
    {
      projectId: config.projectId,
      environmentId: config.environmentId,
      serviceId: config.serviceId,
    },
  );
  const variables = data.variables;
  if (
    variables.Clerk__Issuer !== policy.clerkIssuer ||
    variables.Clerk__PublishableKey !== policy.clerkPublishableKey ||
    variables.Clerk__AuthorizedParties__0 !== policy.origin ||
    Object.keys(variables).some(
      (key) =>
        /^Clerk__AuthorizedParties__/.test(key) &&
        key !== "Clerk__AuthorizedParties__0",
    )
  )
    throw new Error(
      "runtime Clerk instance or authorized origins differ from isolation policy",
    );
  const connection = variables.ConnectionStrings__habits ?? "";
  const value = (key) =>
    connection
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.toLowerCase().startsWith(`${key}=`))
      ?.split("=")
      .slice(1)
      .join("=");
  if (
    !value("host")?.endsWith(".railway.internal") ||
    value("database") !== policy.databaseName ||
    value("username") !== policy.databaseUser ||
    !value("password")
  )
    throw new Error(
      "database must use the private environment database and dedicated role",
    );
  if (process.env.APP_ORIGIN && process.env.APP_ORIGIN !== policy.origin)
    throw new Error("browser origin differs from isolation policy");
  if (
    process.env.CLERK_PUBLISHABLE_KEY &&
    process.env.CLERK_PUBLISHABLE_KEY !== policy.clerkPublishableKey
  )
    throw new Error("browser Clerk key differs from isolation policy");
  return policy;
}

export async function observeDeployment(expected) {
  const active = await inspectRailway();
  const data = await query(
    "query($id:String!){deployment(id:$id){id status}}",
    { id: expected.id },
  );
  const observed = { ...data.deployment, ...active };
  requireLiveImage(expected, observed);
  return observed;
}

export async function deployImage(image) {
  if (!/^ghcr\.io\/shiosos\/damadama@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("deployment requires an immutable Damadama digest");
  await inspectRailway();
  if (!process.env.RAILWAY_DEPLOYMENT_IMAGE_PATH)
    throw new Error(
      "verify Railway immutable deployment metadata during approved setup before automated deployment",
    );
  const config = configuration();
  await query(
    "mutation($serviceId:String!,$environmentId:String!,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$serviceId,environmentId:$environmentId,input:$input)}",
    {
      serviceId: config.serviceId,
      environmentId: config.environmentId,
      input: {
        source: { image },
        numReplicas: 1,
        sleepApplication: false,
        healthcheckPath: "/health/ready",
        healthcheckTimeout: 300,
      },
    },
  );
  const data = await query(
    "mutation($serviceId:String!,$environmentId:String!){serviceInstanceDeployV2(serviceId:$serviceId,environmentId:$environmentId)}",
    { serviceId: config.serviceId, environmentId: config.environmentId },
  );
  const id = data.serviceInstanceDeployV2;
  if (typeof id !== "string" || !id)
    throw new Error("Railway did not return a deployment ID");
  const deadline = Date.now() + 360_000;
  while (Date.now() < deadline) {
    const result = await query(
      "query($id:String!){deployment(id:$id){id status}}",
      { id },
    );
    console.log(`Deployment ${id}: ${result.deployment.status}`);
    if (
      ["FAILED", "CRASHED", "REMOVED", "SLEEPING", "SKIPPED"].includes(
        result.deployment.status,
      )
    )
      throw new Error("deployment failed; inspect Railway runtime logs");
    if (result.deployment.status === "SUCCESS") {
      await observeDeployment({ id, image });
      return { id, environmentId: config.environmentId, image };
    }
    await setTimeout(5_000);
  }
  throw new Error("deployment did not become ready within six minutes");
}

export async function logSummary(id) {
  const logs = await query(
    "query($id:String!){deploymentLogs(deploymentId:$id,limit:100){timestamp severity message}}",
    { id },
  );
  return {
    deploymentId: id,
    logLines: logs.deploymentLogs.length,
    console:
      "Use Railway deployment logs for migration and trace IDs. Raw runtime logs are not uploaded publicly.",
  };
}
