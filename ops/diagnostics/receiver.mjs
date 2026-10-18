import routes from "./receiver-routes.json" with { type: "json" };

const endpoint = "https://backboard.railway.com/graphql/v2";
const query = `query RequestFailureWindow($projectId: String!, $environmentId: String!, $serviceId: String!, $filter: String!, $start: String!, $end: String!) {
  projectToken { projectId environmentId }
  environment(id: $environmentId, projectId: $projectId) { id projectId name }
  serviceInstance(environmentId: $environmentId, serviceId: $serviceId) { environmentId serviceId }
  environmentLogs(environmentId: $environmentId, filter: $filter, beforeDate: $start, anchorDate: $end, beforeLimit: 500, afterLimit: 0) {
    timestamp message attributes { key value }
  }
}`;
const rootKeys = ["EventId", "LogLevel", "Category", "Message", "State"];
const stateKeys = [
  "Revision",
  "Environment",
  "Route",
  "Status",
  "TraceId",
  "Classification",
  "{OriginalFormat}",
];
const template =
  "Request failure. Revision {Revision}, Environment {Environment}, Route {Route}, Status {Status}, TraceId {TraceId}, Classification {Classification}";
const category = "Damadama.RequestDiagnostics";
const statusByClassification = new Map([
  ["unexpected", 500],
  ["storage-unavailable", 503],
  ["readiness-unavailable", 503],
]);
const approvedRoutes = new Set([...routes, "unavailable"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const byteLength = (value) => Buffer.byteLength(value, "utf8");

class VisibilityFailure extends Error {
  constructor(reason, status = "unavailable") {
    super(reason);
    this.reason = reason;
    this.status = status;
  }
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return (
    object(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new VisibilityFailure("invalid-response");
  }
}

function timestamp(value) {
  if (typeof value !== "string") return null;
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return null;
  const [, day, hour, minute, second, fraction = "", zone] = match;
  if (
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    zone === "-00:00"
  )
    return null;
  const local = `${day}T${hour}:${minute}:${second}`;
  const date = new Date(`${local}Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 19) !== local
  )
    return null;
  let offset = 0;
  if (zone !== "Z") {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4, 6));
    if (hours > 23 || minutes > 59) return null;
    offset = (hours * 60 + minutes) * 60_000;
    if (zone[0] === "-") offset = -offset;
  }
  return (
    BigInt(date.getTime() - offset) * 1_000_000n +
    BigInt(fraction.padEnd(9, "0"))
  );
}

function parseEvent(value, eventTime) {
  if (
    !exactKeys(value, rootKeys) ||
    value.EventId !== 0 ||
    value.LogLevel !== "Error" ||
    value.Category !== category ||
    !exactKeys(value.State, stateKeys)
  ) {
    throw new VisibilityFailure("invalid-event");
  }
  const state = value.State;
  if (
    typeof state.Revision !== "string" ||
    !/^(?:[a-f0-9]{40}|unavailable)$/.test(state.Revision) ||
    state.Environment !== "staging" ||
    !approvedRoutes.has(state.Route) ||
    !statusByClassification.has(state.Classification) ||
    statusByClassification.get(state.Classification) !== state.Status ||
    typeof state.TraceId !== "string" ||
    !/^[A-Za-z0-9:_-]{1,128}$/.test(state.TraceId) ||
    state["{OriginalFormat}"] !== template
  ) {
    throw new VisibilityFailure("invalid-event");
  }
  const message = `Request failure. Revision ${state.Revision}, Environment staging, Route ${state.Route}, Status ${state.Status}, TraceId ${state.TraceId}, Classification ${state.Classification}`;
  if (value.Message !== message) throw new VisibilityFailure("invalid-event");
  return {
    timestamp: eventTime,
    revision: state.Revision,
    environment: "staging",
    route: state.Route,
    status: state.Status,
    traceId: state.TraceId,
    classification: state.Classification,
  };
}

function attributeValue(value) {
  const trimmed = value.replace(/^"+|"+$/g, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function recordEvent(record, window) {
  if (
    !exactKeys(record, ["timestamp", "message", "attributes"]) ||
    typeof record.message !== "string" ||
    byteLength(record.message) > 8192 ||
    !Array.isArray(record.attributes) ||
    record.attributes.length > 32
  ) {
    throw new VisibilityFailure("invalid-record");
  }
  const instant = timestamp(record.timestamp);
  if (
    instant === null ||
    instant < timestamp(window.start) ||
    instant > timestamp(window.end)
  )
    throw new VisibilityFailure("invalid-timestamp");
  const attributes = Object.create(null);
  for (const attribute of record.attributes) {
    if (
      !exactKeys(attribute, ["key", "value"]) ||
      typeof attribute.key !== "string" ||
      typeof attribute.value !== "string" ||
      byteLength(attribute.key) > 128 ||
      byteLength(attribute.value) > 8192 ||
      Object.hasOwn(attributes, attribute.key)
    ) {
      throw new VisibilityFailure("invalid-record");
    }
    attributes[attribute.key] = attributeValue(attribute.value);
  }
  let raw;
  try {
    raw = JSON.parse(record.message);
  } catch {
    raw = null;
  }
  const rawDiagnostic =
    object(raw) &&
    (Object.hasOwn(raw, "State") ||
      Object.hasOwn(raw, "EventId") ||
      (typeof raw.Category === "string" && raw.Category.startsWith(category)));
  const attributeDiagnostic = rootKeys.some((key) =>
    Object.hasOwn(attributes, key),
  );
  if (rawDiagnostic) {
    const keys = Object.keys(attributes);
    if (
      keys.length !== 0 &&
      !(keys.length === 1 && attributes.level === "error")
    )
      throw new VisibilityFailure("conflicting-event");
    return parseEvent(raw, record.timestamp);
  }
  if (attributeDiagnostic) {
    if (Object.hasOwn(attributes, "level")) {
      if (attributes.level !== "error")
        throw new VisibilityFailure("conflicting-event");
      delete attributes.level;
    }
    if (record.message !== "" && record.message !== attributes.Message)
      throw new VisibilityFailure("conflicting-event");
    return parseEvent(attributes, record.timestamp);
  }
  if (
    record.message.includes(category) ||
    record.message.startsWith("Request failure.")
  )
    throw new VisibilityFailure("invalid-event");
  return null;
}

function trustedScope(data, config) {
  return (
    object(data) &&
    object(data.projectToken) &&
    data.projectToken.projectId === config.projectId &&
    data.projectToken.environmentId === config.environmentId &&
    object(data.environment) &&
    data.environment.id === config.environmentId &&
    data.environment.projectId === config.projectId &&
    data.environment.name === "staging" &&
    object(data.serviceInstance) &&
    data.serviceInstance.environmentId === config.environmentId &&
    data.serviceInstance.serviceId === config.serviceId
  );
}

async function readBody(response, signal) {
  if (
    !response.body ||
    !/^application\/json(?:\s*;|$)/i.test(
      response.headers.get("content-type") ?? "",
    )
  )
    throw new VisibilityFailure("invalid-response");
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 1_048_576))
    throw new VisibilityFailure("body-limit");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_048_576) throw new VisibilityFailure("body-limit");
      chunks.push(value);
    }
    try {
      return parseJson(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch (error) {
      if (error instanceof VisibilityFailure) throw error;
      throw new VisibilityFailure("invalid-response");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}

export async function observeRequestFailures(
  config,
  { fetch = globalThis.fetch, now = () => new Date() } = {},
) {
  const observation = {
    window: null,
    events: [],
    coverage: { status: "refused", reason: "invalid-config" },
  };
  if (config?.environment === "production") {
    observation.coverage.reason = "production-disabled";
    return observation;
  }
  if (
    !object(config) ||
    config.environment !== "staging" ||
    ![config.projectId, config.environmentId, config.serviceId].every(
      (id) => typeof id === "string" && uuid.test(id),
    ) ||
    typeof config.token !== "string" ||
    !/^[\x21-\x7e]{1,4096}$/.test(config.token)
  )
    return observation;
  const end = now();
  if (!(end instanceof Date) || !Number.isFinite(end.getTime()))
    return observation;
  observation.window = {
    start: new Date(end.getTime() - 30 * 60_000).toISOString(),
    end: end.toISOString(),
  };
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new VisibilityFailure("deadline"));
      controller.abort();
    }, 10_000);
  });
  try {
    const responseBody = (async () => {
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "Project-Access-Token": config.token,
        },
        body: JSON.stringify({
          query,
          variables: {
            projectId: config.projectId,
            environmentId: config.environmentId,
            serviceId: config.serviceId,
            filter: `@service:${config.serviceId}`,
            start: observation.window.start,
            end: observation.window.end,
          },
        }),
      });
      if (
        (response.status >= 300 && response.status < 400) ||
        response.redirected
      )
        throw new VisibilityFailure("redirect", "refused");
      if (response.status === 401 || response.status === 403)
        throw new VisibilityFailure("provider-refused", "refused");
      if (!response.ok) throw new VisibilityFailure("http-error");
      return readBody(response, controller.signal);
    })();
    const body = await Promise.race([responseBody, deadline]);
    if (!trustedScope(body?.data, config))
      throw new VisibilityFailure("scope-mismatch", "refused");
    if (!Array.isArray(body.data.environmentLogs))
      throw new VisibilityFailure("invalid-response");
    observation.coverage = { status: "observed", reason: "window-observed" };
    const incomplete = (reason) => {
      if (observation.coverage.status === "observed")
        observation.coverage = { status: "unavailable", reason };
    };
    if (
      Object.hasOwn(body, "errors") &&
      (!Array.isArray(body.errors) || body.errors.length !== 0)
    )
      incomplete("provider-errors");
    const records = body.data.environmentLogs;
    if (records.length >= 500) incomplete("record-limit");
    const seen = new Set();
    for (const record of records.slice(0, 500)) {
      try {
        const event = recordEvent(record, observation.window);
        if (!event) continue;
        const identity = JSON.stringify([
          event.revision,
          event.environment,
          event.route,
          event.status,
          event.traceId,
          event.classification,
        ]);
        if (seen.has(identity)) continue;
        if (observation.events.length === 100) {
          incomplete("event-limit");
          continue;
        }
        seen.add(identity);
        observation.events.push(event);
      } catch (error) {
        if (!(error instanceof VisibilityFailure)) throw error;
        incomplete(error.reason);
      }
    }
  } catch (error) {
    observation.coverage = { status: "unavailable", reason: "network-failure" };
    if (error instanceof VisibilityFailure)
      observation.coverage = { status: error.status, reason: error.reason };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return observation;
}
