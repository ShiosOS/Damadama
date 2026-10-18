import { appendFileSync } from "node:fs";
import { observe, formatObservation } from "./monitor.mjs";

function activation(raw) {
  if (raw === undefined || raw === "" || raw === "false") return "disabled";
  if (raw === "true") return "enabled";
  return "invalid";
}

function annotation(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

try {
  const state = activation(process.env.OPS_MONITOR_ENABLED_STAGING);
  const target = {
    environment: "staging",
    enabled: state === "enabled",
    metadataUrl: process.env.BACKUP_METADATA_URL_STAGING,
    metadataOrigin: process.env.BACKUP_METADATA_ORIGIN_STAGING,
    monitorRevision: process.env.GITHUB_SHA,
    runReference: `https://github.com/ShiosOS/Damadama/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/${process.env.GITHUB_RUN_ATTEMPT}`,
  };
  const production = formatObservation(
    await observe({ ...target, environment: "production", enabled: false }),
  );
  let report;
  let severity;
  let message;
  switch (state) {
    case "disabled":
      message =
        "Staging monitoring inactive; zero requests. This successful run reports disabled state and does not establish live health or alert delivery.";
      report = `${message}\n${formatObservation(await observe(target))}`;
      severity = "notice";
      break;
    case "invalid":
      message =
        "Staging monitoring refused; invalid activation; zero requests.";
      report = message;
      severity = "error";
      process.exitCode = 1;
      break;
    case "enabled": {
      const observation = await observe(target);
      report = formatObservation(observation);
      if (observation.verdict !== "healthy") {
        message = report;
        severity = "error";
        process.exitCode = 1;
      }
      break;
    }
  }
  const output = `${report}\n${production}\n`;
  process.stdout.write(output);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, output);
  if (severity && process.env.GITHUB_ACTIONS === "true")
    console.error(
      `::${severity} title=Staging operational monitor::${annotation(message)}`,
    );
} catch {
  console.error(
    "monitor verdict=unavailable reason=monitor-failed trace=unavailable",
  );
  process.exitCode = 1;
}
