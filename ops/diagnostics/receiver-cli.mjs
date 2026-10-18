import { pathToFileURL } from "node:url";
import { observeRequestFailures } from "./receiver.mjs";

export async function runReceiver(config, dependencies, write = console.log) {
  const observation = await observeRequestFailures(config, dependencies);
  for (const event of observation.events) {
    write(
      `::error title=Staging request failure::revision=${event.revision} environment=${event.environment} route=${event.route} status=${event.status} trace=${event.traceId} classification=${event.classification} time=${event.timestamp}`,
    );
  }
  if (observation.coverage.status !== "observed") {
    write(
      `::error title=Request error visibility::status=${observation.coverage.status} reason=${observation.coverage.reason}`,
    );
    return 2;
  }
  write(
    `Observed window ${observation.window.start} through ${observation.window.end}; accepted failures=${observation.events.length}. This observation does not establish application health.`,
  );
  return observation.events.length === 0 ? 0 : 1;
}

function stagingActivation(raw) {
  if (raw === undefined || raw === "" || raw === "false") return "inactive";
  if (raw === "true") return "observe";
  return "invalid";
}

async function runDirectReceiver() {
  const environment = process.env.REQUEST_ERRORS_ENVIRONMENT;
  if (environment !== "staging") return runReceiver({ environment });

  const activation = stagingActivation(
    process.env.REQUEST_ERRORS_ENABLED_STAGING,
  );
  if (activation === "inactive") {
    console.log(
      "::notice title=Staging request-error observation::Inactive; zero provider requests.",
    );
    return 0;
  }
  if (activation === "invalid") {
    console.log(
      "::error title=Request error activation::status=refused reason=invalid-activation",
    );
    return 2;
  }
  return runReceiver({
    environment,
    projectId: process.env.RAILWAY_PROJECT_ID,
    environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
    serviceId: process.env.RAILWAY_SERVICE_ID,
    token: process.env.RAILWAY_LOG_READER_TOKEN_STAGING,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await runDirectReceiver();
}
