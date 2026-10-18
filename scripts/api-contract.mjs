import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const smoke = process.argv.includes("--smoke");
const directory = smoke ? ".audit/api-contract-smoke" : ".audit/api-contract";
const documentPath = `${directory}/openapi.json`;
const document = JSON.parse(await readFile(documentPath, "utf8"));
const cli = "node_modules/@redocly/cli/bin/cli.js";
assert.equal(
  JSON.parse(await readFile("node_modules/@redocly/cli/package.json", "utf8"))
    .version,
  "2.64.1",
);

function lint(path) {
  const result = spawnSync(
    process.execPath,
    [cli, "lint", path, "--config", "server/redocly.yaml", "--format", "json"],
    {
      encoding: "utf8",
      env: { ...process.env, REDOCLY_TELEMETRY: "off" },
      timeout: 30_000,
    },
  );
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}
const valid = lint(documentPath);
assert.equal(valid.status, 0, valid.output);

const habits = "/api/habits";
const member = "/api/habits/{id}";
const entry = "/api/habits/{id}/entries/{date}";
const mutations = [
  [
    "struct",
    (doc) => {
      doc.info.version = 123;
    },
  ],
  [
    "no-unresolved-refs",
    (doc) => {
      doc.paths[habits].get.responses[200].content["application/json"].schema =
        { $ref: "#/components/schemas/Missing" };
    },
  ],
  [
    "operation-operationId",
    (doc) => {
      delete doc.paths[habits].get.operationId;
    },
  ],
  [
    "operation-operationId-unique",
    (doc) => {
      doc.paths[habits].get.operationId = doc.paths[habits].post.operationId;
    },
  ],
  [
    "path-parameters-defined",
    (doc) => {
      doc.paths[member].get.parameters = [];
    },
  ],
  [
    "path-not-include-query",
    (doc) => {
      doc.paths["/api/habits?date=2026-01-04"] = doc.paths[habits];
    },
  ],
  [
    "path-declaration-must-exist",
    (doc) => {
      doc.paths["/api/habits/{}"] = doc.paths[habits];
    },
  ],
  [
    "no-ambiguous-paths",
    (doc) => {
      doc.paths["/api/habits/{other}"] = doc.paths[member];
    },
  ],
  [
    "operation-2xx-response",
    (doc) => {
      delete doc.paths[habits].get.responses[200];
    },
  ],
  [
    "operation-4xx-response",
    (doc) => {
      doc.paths[habits].get.responses = {
        200: doc.paths[habits].get.responses[200],
      };
    },
  ],
  [
    "security-defined",
    (doc) => {
      delete doc.components.securitySchemes.Bearer;
    },
  ],
  [
    "paths-kebab-case",
    (doc) => {
      doc.paths["/api/badHabits"] = doc.paths[habits];
    },
  ],
  [
    "no-http-verbs-in-paths",
    (doc) => {
      doc.paths["/api/get/habits"] = doc.paths[habits];
    },
  ],
  [
    "path-segment-plural",
    (doc) => {
      doc.paths["/api/habit"] = doc.paths[habits];
    },
  ],
  [
    "request-mime-type",
    (doc) => {
      doc.paths[habits].post.requestBody.content = {
        "text/plain": { schema: { type: "string" } },
      };
    },
  ],
  [
    "response-mime-type",
    (doc) => {
      doc.paths[habits].get.responses[200].content = {
        "text/plain": { schema: { type: "string" } },
      };
    },
  ],
  [
    "rule/get-no-body",
    (doc) => {
      doc.paths[habits].get.requestBody = doc.paths[habits].post.requestBody;
    },
  ],
  [
    "rule/collection-methods",
    (doc) => {
      doc.paths[habits].put = doc.paths[entry].put;
    },
  ],
  [
    "rule/member-methods",
    (doc) => {
      doc.paths[member].post = doc.paths[habits].post;
    },
  ],
  [
    "rule/config-singleton",
    (doc) => {
      doc.paths["/api/config"].put = doc.paths[entry].put;
    },
  ],
  [
    "rule/resource-paths",
    (doc) => {
      doc.paths["/api/habits/{id}/activate"] = doc.paths[member];
    },
  ],
  [
    "rule/created-location",
    (doc) => {
      delete doc.paths[habits].post.responses[201].headers.Location;
    },
  ],
  [
    "rule/cache-header",
    (doc) => {
      delete doc.paths[habits].get.responses[200].headers["Cache-Control"];
    },
  ],
  [
    "rule/response-schema",
    (doc) => {
      delete doc.paths[habits].get.responses[200].content["application/json"]
        .schema;
    },
  ],
  [
    "rule/private-security",
    (doc) => {
      delete doc.paths[habits].get.security;
    },
  ],
  [
    "rule/private-unauthorized",
    (doc) => {
      delete doc.paths[habits].get.responses[401];
    },
  ],
];
await mkdir(`${directory}/negative-controls`, { recursive: true });
for (const [rule, mutate] of mutations) {
  const invalid = structuredClone(document);
  mutate(invalid);
  const path = `${directory}/negative-controls/${rule.replaceAll("/", "-")}.json`;
  await writeFile(path, JSON.stringify(invalid));
  const result = lint(path);
  assert.equal(
    result.status,
    1,
    `${rule} did not reject the mutation: ${result.output}`,
  );
  assert.match(
    result.output,
    new RegExp(`"ruleId":\\s*"${rule}"`),
    `${rule} did not report its own diagnostic: ${result.output}`,
  );
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(document, "urn:damadama:openapi");
const escapePointer = (value) =>
  String(value).replaceAll("~", "~0").replaceAll("/", "~1");
function validator(...segments) {
  return ajv.compile({
    $ref: `urn:damadama:openapi#/${segments.map(escapePointer).join("/")}`,
  });
}
const validHabit = {
  name: "Walking",
  good: "5 minutes",
  better: "15 minutes",
  best: "30 minutes",
  weekdays: [1, 7],
  repeatEveryWeeks: 2,
  timeZone: "America/New_York",
};
const validEdit = {
  result: "Good",
  editedAt: "2026-01-05T00:00:00Z",
  deviceToday: "2026-01-05",
  timeZone: "Asia/Tokyo",
};
for (const [path, method, input] of [
  [habits, "post", validHabit],
  [entry, "put", validEdit],
]) {
  const validate = validator(
    "paths",
    path,
    method,
    "requestBody",
    "content",
    "application/json",
    "schema",
  );
  assert.ok(validate(input), ajv.errorsText(validate.errors));
  for (const key of Object.keys(input)) {
    const missing = { ...input };
    delete missing[key];
    assert.equal(
      validate(missing),
      false,
      `Request schema did not require ${key}`,
    );
    assert.equal(
      validate({ ...input, [key]: null }),
      false,
      `Request schema accepted null ${key}`,
    );
  }
}
const validateHabit = validator(
  "paths",
  habits,
  "post",
  "requestBody",
  "content",
  "application/json",
  "schema",
);
for (const invalid of [
  { ...validHabit, name: " " },
  { ...validHabit, good: "" },
  { ...validHabit, weekdays: [] },
  { ...validHabit, weekdays: [0, 8] },
  { ...validHabit, repeatEveryWeeks: 0 },
  { ...validHabit, repeatEveryWeeks: 1.5 },
  { ...validHabit, repeatEveryWeeks: "2" },
])
  assert.equal(
    validateHabit(invalid),
    false,
    `Habit schema accepted ${JSON.stringify(invalid)}`,
  );
const validateEdit = validator(
  "paths",
  entry,
  "put",
  "requestBody",
  "content",
  "application/json",
  "schema",
);
for (const invalid of [
  { ...validEdit, result: "Unknown" },
  { ...validEdit, deviceToday: "2026-02-30" },
  { ...validEdit, editedAt: "yesterday" },
])
  assert.equal(
    validateEdit(invalid),
    false,
    `Entry schema accepted ${JSON.stringify(invalid)}`,
  );
for (const [path, name, validValue, invalidValue] of [
  [member, "id", "be3990ed-527d-451e-8a11-981648333ac9", "123"],
  [entry, "date", "2026-01-04", "2026-02-30"],
  [habits, "scheduledOn", "2026-01-04", "2026-1-4"],
]) {
  const index = document.paths[path].get.parameters.findIndex(
    (parameter) => parameter.name === name,
  );
  assert.notEqual(index, -1, `Missing parameter ${name}`);
  const validate = validator(
    "paths",
    path,
    "get",
    "parameters",
    index,
    "schema",
  );
  assert.equal(validate(validValue), true, `Parameter schema rejected ${name}`);
  assert.equal(
    validate(invalidValue),
    false,
    `Parameter schema accepted invalid ${name}`,
  );
}
if (!smoke) {
  const observations = JSON.parse(
    await readFile(`${directory}/responses.json`, "utf8"),
  );
  assert.ok(observations.length > 0, "No HTTP responses were exercised.");
  for (const observed of observations) {
    const response =
      document.paths[observed.path]?.[observed.method]?.responses[
        observed.status
      ];
    assert.ok(
      response,
      `Undocumented observed status: ${observed.method} ${observed.path} ${observed.status}`,
    );
    assert.ok(
      response.content?.[observed.mediaType],
      `Undocumented media type: ${observed.mediaType}`,
    );
    const validate = validator(
      "paths",
      observed.path,
      observed.method,
      "responses",
      observed.status,
      "content",
      observed.mediaType,
      "schema",
    );
    assert.ok(
      validate(observed.body),
      `${observed.method} ${observed.path} ${observed.status}: ${ajv.errorsText(validate.errors)}`,
    );
    for (const [name, header] of Object.entries(response.headers ?? {})) {
      const value = observed.headers[name.toLowerCase()];
      if (header.required) assert.ok(value, `Missing response header ${name}`);
      if (value !== undefined && header.schema) {
        const validateHeader = validator(
          "paths",
          observed.path,
          observed.method,
          "responses",
          observed.status,
          "headers",
          name,
          "schema",
        );
        assert.ok(
          validateHeader(value),
          `Invalid response header ${name}: ${ajv.errorsText(validateHeader.errors)}`,
        );
      }
    }
  }
  const success = observations.find(
    (observed) => observed.path === entry && observed.status === 201,
  );
  assert.ok(success, "Entry creation must be exercised.");
  const validateEntry = validator(
    "paths",
    entry,
    "put",
    "responses",
    "201",
    "content",
    "application/json",
    "schema",
  );
  for (const mutate of [
    (body) => {
      delete body.habitId;
    },
    (body) => {
      body.result = "Unknown";
    },
    (body) => {
      body.calendarDate = "2026-02-30";
    },
    (body) => {
      body.editedAt = "yesterday";
    },
    (body) => {
      body.habitId = "not-a-uuid";
    },
  ]) {
    const invalid = structuredClone(success.body);
    mutate(invalid);
    assert.equal(
      validateEntry(invalid),
      false,
      `Response schema accepted invalid entry ${JSON.stringify(invalid)}`,
    );
  }
  console.info(
    `Validated ${observations.length} observed HTTP response bodies and headers against the fresh generated contract.`,
  );
}
console.info(
  `Pinned Redocly accepted the generated contract and rejected ${mutations.length} rule-specific negative controls.`,
);
