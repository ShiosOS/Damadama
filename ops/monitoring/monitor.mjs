const freshnessMs = 86_400_000;
const bodyLimit = 16_384;
const appOrigin = "https://staging.damadama.app";
const routes = {
  liveness: "/health/live",
  readiness: "/health/ready",
  identity: "/release.json",
  completion: "backup-metadata",
  job: "backup-job",
  retention: "backup-retention",
};
const outcomes = {
  succeeded: "healthy",
  failed: "unavailable",
  unknown: "unknown",
};
const sha = /^[a-f0-9]{40}$/;
const trace =
  /^(?:[a-f0-9]{32}|[0-9A-Z]{13}:[0-9A-F]{8}|00-[a-f0-9]{32}-[a-f0-9]{16}-0[01])$/;

function isSha(value) {
  return typeof value === "string" && value.length === 40 && sha.test(value);
}

function isTrace(value) {
  return (
    typeof value === "string" &&
    value.length <= 55 &&
    !/[\r\n]/.test(value) &&
    trace.test(value)
  );
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

function instant(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return NaN;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return NaN;
  const canonical = value.length === 20 ? value.replace("Z", ".000Z") : value;
  if (new Date(time).toISOString() !== canonical) return NaN;
  return time;
}

function completionValid(value, environment, now) {
  if (
    !exactKeys(value, [
      "environment",
      "backup",
      "completedAt",
      "retentionDays",
      "durationSeconds",
    ])
  )
    return false;
  if (value.environment !== environment || typeof value.backup !== "string")
    return false;
  const match = new RegExp(
    `^damadama/${environment}/(\\d{8}T\\d{6}Z)-[a-f0-9]{16}\\.dump\\.age$`,
  ).exec(value.backup);
  if (!match) return false;
  const stamp = match[1].replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
    "$1-$2-$3T$4:$5:$6Z",
  );
  const started = instant(stamp);
  const completed = instant(value.completedAt);
  return (
    Number.isFinite(started) &&
    Number.isFinite(completed) &&
    started <= completed &&
    completed <= now &&
    Number.isSafeInteger(value.retentionDays) &&
    value.retentionDays >= 7 &&
    Number.isSafeInteger(value.durationSeconds) &&
    value.durationSeconds >= 0
  );
}

function backupChecks(raw, environment, now) {
  if (
    !exactKeys(raw, [
      "schemaVersion",
      "origin",
      "observedAt",
      "completion",
      "archivePresent",
      "checksumPresent",
      "job",
      "retention",
    ]) ||
    raw.schemaVersion !== 1 ||
    typeof raw.archivePresent !== "boolean" ||
    typeof raw.checksumPresent !== "boolean" ||
    typeof raw.job !== "string" ||
    typeof raw.retention !== "string" ||
    !Object.hasOwn(outcomes, raw.job) ||
    !Object.hasOwn(outcomes, raw.retention)
  )
    return backupFailure("invalid", "invalid-metadata");
  if (raw.origin !== "hosted")
    return backupFailure("invalid", "non-hosted-evidence");
  const observed = instant(raw.observedAt);
  if (!Number.isFinite(observed) || observed > now)
    return backupFailure("invalid", "invalid-observation-time");
  if (
    raw.completion !== null &&
    !completionValid(raw.completion, environment, now)
  )
    return backupFailure("invalid", "invalid-completion");
  if (raw.completion !== null && observed < instant(raw.completion.completedAt))
    return backupFailure("invalid", "observation-before-completion");
  if (now - observed > freshnessMs)
    return backupFailure("stale", "stale-observation");
  const checks = {
    job: check(outcomes[raw.job], `job-${raw.job}`),
    retention: check(outcomes[raw.retention], `retention-${raw.retention}`),
  };
  if (raw.completion === null || !raw.archivePresent || !raw.checksumPresent) {
    checks.completion = check("missing", "incomplete-triplet");
  } else if (now - instant(raw.completion.completedAt) > freshnessMs) {
    checks.completion = check("stale", "stale-completion");
  } else {
    checks.completion = check("healthy", "completed-triplet");
  }
  return checks;
}

function check(verdict, reason, status = null, traceId = "unavailable") {
  return { verdict, reason, status, traceId };
}

function backupFailure(verdict, reason, status = null) {
  return {
    completion: check(verdict, reason, status),
    job: check("unknown", "job-unknown"),
    retention: check("unknown", "retention-unknown"),
  };
}

function metadataAddress(target) {
  if (!target.metadataUrl)
    return { failure: "missing", reason: "metadata-url-missing" };
  try {
    const approved = new URL(target.metadataOrigin);
    const url = new URL(target.metadataUrl);
    if (
      approved.protocol !== "https:" ||
      approved.username ||
      approved.password ||
      approved.hash ||
      approved.search ||
      approved.pathname !== "/" ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.origin !== approved.origin
    )
      return { failure: "invalid", reason: "metadata-origin-invalid" };
    return { url };
  } catch {
    return { failure: "invalid", reason: "metadata-origin-invalid" };
  }
}

async function jsonBody(response) {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > bodyLimit)
  ) {
    void response.body?.cancel().catch(() => {});
    throw new Error("body-limit");
  }
  if (!response.body) throw new Error("invalid-json");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > bodyLimit) throw new Error("body-limit");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    void reader.cancel().catch(() => {});
  }
}

async function request(url, fetcher, parse) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    let deadlineResult = { failure: "unavailable", reason: "timeout" };
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(deadlineResult);
      }, 10_000);
    });
    try {
      const result = await Promise.race([
        deadline,
        (async () => {
          const response = await fetcher(url, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: { Accept: "application/json" },
          });
          if (response.status >= 300 && response.status < 400) {
            void response.body?.cancel().catch(() => {});
            return {
              failure: "invalid",
              reason: "redirect-refused",
              status: response.status,
            };
          }
          if (response.status !== 200)
            deadlineResult = httpFailure(response.status);
          return await parse(response);
        })(),
      ]);
      if (
        attempt === 0 &&
        (result.reason === "timeout" ||
          result.status === 500 ||
          result.status === 503 ||
          result.status === 429)
      )
        continue;
      return result;
    } catch (error) {
      if (
        controller.signal.aborted ||
        error?.name === "TimeoutError" ||
        error?.name === "AbortError"
      ) {
        if (attempt === 0) continue;
        return { failure: "unavailable", reason: "timeout" };
      }
      if (
        error?.message === "body-limit" ||
        error instanceof SyntaxError ||
        error?.message === "invalid-json" ||
        (error instanceof TypeError &&
          error.code === "ERR_ENCODING_INVALID_ENCODED_DATA")
      )
        return { failure: "invalid", reason: "invalid-json" };
      if (attempt === 0) continue;
      return { failure: "unavailable", reason: "network-unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }
}

function httpFailure(status) {
  if (status === 404)
    return { failure: "missing", reason: "http-missing", status };
  if (status === 401 || status === 403)
    return { failure: "refused", reason: "http-refused", status };
  return { failure: "unavailable", reason: "http-failure", status };
}

async function appProbe(name, fetcher) {
  return request(`${appOrigin}${routes[name]}`, fetcher, async (response) => {
    if (response.status !== 200) {
      let traceId = response.headers.get("x-trace-id");
      if (!isTrace(traceId)) {
        traceId = "unavailable";
        try {
          const problem = await jsonBody(response);
          if (isTrace(problem?.traceId)) traceId = problem.traceId;
        } catch {}
      } else {
        void response.body?.cancel().catch(() => {});
      }
      return { ...httpFailure(response.status), traceId };
    }
    if (name !== "identity") {
      void response.body?.cancel().catch(() => {});
      return { verdict: "healthy", reason: "http-ok", status: 200 };
    }
    const identity = await jsonBody(response);
    if (
      !exactKeys(identity, ["source", "version"]) ||
      !exactKeys(identity.source, ["repository", "commit", "tree"]) ||
      identity.source.repository !== "ShiosOS/Damadama" ||
      !isSha(identity.source.commit) ||
      !isSha(identity.source.tree) ||
      identity.version !== `main-${identity.source.commit.slice(0, 12)}`
    )
      return {
        failure: "invalid",
        reason: "invalid-release-identity",
        status: 200,
      };
    return {
      verdict: "healthy",
      reason: "release-identity",
      status: 200,
      commit: identity.source.commit,
      tree: identity.source.tree,
    };
  });
}

export async function observe(
  target,
  { now = Date.now(), fetch: fetcher = globalThis.fetch } = {},
) {
  const environment =
    target.environment === "production" ? "production" : "staging";
  const observation = {
    environment,
    observedAt: new Date(now).toISOString(),
    monitorRevision: isSha(target.monitorRevision)
      ? target.monitorRevision
      : "unavailable",
    runReference:
      typeof target.runReference === "string" &&
      !/[\r\n]/.test(target.runReference) &&
      /^https:\/\/github\.com\/ShiosOS\/Damadama\/actions\/runs\/\d{1,20}(?:\/attempts\/\d{1,6})?$/.test(
        target.runReference,
      )
        ? target.runReference
        : "unavailable",
    appRevision: "unavailable",
    appTree: "unavailable",
    checks: {},
  };
  if (target.environment !== "staging" || target.enabled === false) {
    for (const name of Object.keys(routes))
      observation.checks[name] = check("disabled", "target-disabled");
    observation.verdict = "disabled";
    return observation;
  }
  const address = metadataAddress(target);
  const [app, metadata] = await Promise.all([
    Promise.all(
      ["liveness", "readiness", "identity"].map((name) =>
        appProbe(name, fetcher),
      ),
    ),
    address.failure
      ? address
      : request(address.url, fetcher, async (response) => {
          if (response.status !== 200) {
            void response.body?.cancel().catch(() => {});
            return httpFailure(response.status);
          }
          return { raw: await jsonBody(response) };
        }),
  ]);
  for (const [index, name] of ["liveness", "readiness", "identity"].entries()) {
    const result = app[index];
    observation.checks[name] = check(
      result.verdict ?? result.failure,
      result.reason,
      result.status ?? null,
      result.traceId ?? "unavailable",
    );
  }
  if (app[2].verdict === "healthy") {
    observation.appRevision = app[2].commit;
    observation.appTree = app[2].tree;
  }
  const backup = metadata.failure
    ? backupFailure(metadata.failure, metadata.reason, metadata.status)
    : backupChecks(metadata.raw, environment, now);
  Object.assign(observation.checks, backup);
  const failed = Object.values(observation.checks).find(
    (value) => value.verdict !== "healthy" && value.verdict !== "unknown",
  );
  if (failed) observation.verdict = failed.verdict;
  else if (
    Object.values(observation.checks).some(
      (value) => value.verdict === "unknown",
    )
  )
    observation.verdict = "unknown";
  else observation.verdict = "healthy";
  return observation;
}

export function formatObservation(observation) {
  const lines = [
    `environment=${observation.environment} verdict=${observation.verdict} observedAt=${observation.observedAt} appRevision=${observation.appRevision} appTree=${observation.appTree} monitorRevision=${observation.monitorRevision} run=${observation.runReference}`,
  ];
  for (const [name, result] of Object.entries(observation.checks)) {
    lines.push(
      `environment=${observation.environment} route=${routes[name]} verdict=${result.verdict} reason=${result.reason} status=${result.status ?? "unavailable"} trace=${result.traceId} run=${observation.runReference}`,
    );
  }
  return lines.join("\n");
}
