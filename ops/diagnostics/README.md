# Correlate a failed request

1. Obtain the support reference shown with the failed request. Do not ask for a token, request body, or habit details.
2. Find the `Damadama.RequestDiagnostics` error event whose `TraceId` equals that reference.
3. Check its `Environment` and `Revision` before investigating that deployment. `unavailable` means the service could not establish the value.
4. Use `Route`, `Status`, and `Classification` to select the failed operation. A route contains registered placeholders, so it does not identify an account or habit.

API problem responses retain their existing `traceId`. The client validates that value and appends `Support reference: <traceId>.` to the existing error message. It accepts 1 through 128 ASCII letters, digits, colons, underscores, and hyphens. Invalid references are omitted without discarding useful problem text. Malformed JSON produces a generic client error without a fabricated reference.

`/health/ready` returns its existing status, body, and media type. Its `X-Trace-Id` header carries the same reference as a failed-readiness event. A healthy response has a reference but emits no failure event. `/health/live` remains a liveness check without this header.

## Diagnostic event contract

The event includes these structured fields, plus the fixed message template supplied by the logger.

| Field            | Values                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `Revision`       | Lowercase 40-character hexadecimal `source.commit` from packaged `wwwroot/release.json`, or `unavailable`                |
| `Environment`    | Trusted process variable `RAILWAY_ENVIRONMENT_NAME`, accepted only as `staging` or `production`, otherwise `unavailable` |
| `Route`          | Registered route template, including the original endpoint after exception handling, or `unavailable`                    |
| `Status`         | `500` or `503`                                                                                                           |
| `TraceId`        | Validated server request reference with the same character and length limits as the client                               |
| `Classification` | `unexpected`, `storage-unavailable`, or `readiness-unavailable`                                                          |

The singleton reads release identity and hosting environment once. Missing or malformed release metadata does not prevent local startup or EF tooling. The ASP.NET environment cannot distinguish Railway staging from production because both use `Production`. Set `RAILWAY_ENVIRONMENT_NAME` through trusted deployment configuration. Do not derive identity from request headers, paths, query values, or the monitor's checkout revision.

Unexpected exceptions emit `unexpected` with status 500 before the existing generic problem response. Database update and Npgsql exceptions emit `storage-unavailable` with status 503 and retain the existing safe storage problem. Failed readiness emits `readiness-unavailable` with status 503. Validation failures, ordinary refusals, and successful requests emit no diagnostic event. An explicit 500 returned outside those exception boundaries does not produce an event.

## Logging privacy and its tradeoff

The final `LoggerFilterOptions` configuration clears all category and provider rules. It enables only Error records from the exact `Damadama.RequestDiagnostics` category. Scopes are disabled, including JSON console scopes. Category-specific environment configuration cannot enable additional output through the standard logger pipeline.

This policy suppresses framework, EF, authentication, startup, and successful-request logs. Operators lose their usual troubleshooting detail. A startup failure may require process status and readiness evidence because request diagnostics do not describe failures before a request is accepted. Do not enable raw framework logs or exception output to work around the filter. Review any change to the event allowlist and add privacy tests first.

The event excludes exception objects, messages, types, stack traces, raw URLs, query strings, route values, account IDs, habit IDs, payloads, and tokens. Logging tests capture the whole enabled provider stream, including structured state, scopes, and exception arguments. They attempt category and provider overrides, exercise exception handling, and check real EF and former identifier-bearing success-log paths.

## Verification and alert activation

Run `bun run check` for the client boundary, actual API and PostgreSQL failures, OpenAPI compatibility, and browser flows. The database-free server cases can also run with `dotnet test tests/Backend --filter FullyQualifiedName~Damadama.DiagnosticsProtocol`.

The browser test named `a simulated entry failure displays its safe support reference` mounts the real EntryControls and simulates a 503 response. It checks the visible reference and retained retry action. Its screenshot and video are `.audit/entries-support-reference.png` and `.audit/entries-support-reference.webm`. These are simulated browser evidence, not a hosted outage or delivered alert.

## Verify the request error receiver

Run `node ops/diagnostics/receiver-verify.mjs` from the repository root with Node.js 24 and .NET SDK 10.0.112 installed. The runner performs a locked backend restore, runs the database-free `Damadama.ReceiverProtocol` test, and runs the Node tests. It deletes any previous fixture first. Missing formatter output fails the lane.

The formatter test sends actual unexpected, storage, and readiness failures through ASP.NET and `AddJsonConsole`. It disposes the host to flush the console queue and restores global console and environment state. The resulting `.audit/receiver-console-fixture.json` contains only validated synthetic events and expected response references. Node tests feed those actual bytes through a local HTTP provider and assert the query, token header, scope binding, safe annotations, and nonzero result. They also cover malformed input, refusal, privacy rejection, saturation, and the whole request deadline. These tests do not contact Railway.

For receiver fixtures alone, run `node --test ops/diagnostics/receiver.test.mjs`. For the formatter handshake after regenerating the fixture, run `node --test ops/diagnostics/receiver-handshake.test.mjs`.

`bun .github/ci/workflow-lint.mjs --self-test` also reads the actual receiver workflow. Its bounded expression interpreter checks fixture and staging event/ref admission, raw environment bindings, and failure propagation against parsed mutations. It launches the parsed CLI command with Node.js 24 and a sanitized environment. Independent attempted-fetch counts and local HTTP receipts distinguish inactivity from enabled empty observations. All transport stays on loopback. This local check does not establish native Actions scheduling or hosted provider normalization.

Run `bun run check` for canonical verification. `RequestReceiverRouteTests` starts the actual application with its test PostgreSQL database and compares all registered `RouteEndpoint` patterns against `receiver-routes.json`. Update that policy only after reviewing a route change for private or concrete values. The database-free receiver lane does not replace this inventory check.

## Configure staging observation

1. Create a dedicated Railway project token scoped to the intended staging environment. Store it as the GitHub `staging` environment secret `RAILWAY_LOG_READER_TOKEN_STAGING`. Do not copy the deployment `RAILWAY_TOKEN`. A project token can have write capabilities even though this receiver sends only a read query. Limit its environment and distribution, and revoke it if exposed. It is not a read-only credential.
2. Set the GitHub `staging` environment variables `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, and `RAILWAY_SERVICE_ID` to the trusted lowercase UUIDs. Confirm the Railway environment name is exactly `staging` and that the service instance belongs to it. The receiver independently checks all four returned bindings, including the token's project and environment, before accepting even an empty response.
3. Merge the reviewed workflow onto the default branch. The `Request error observation` workflow runs every five minutes at minutes 2, 7, and subsequent five-minute intervals. Manual observation runs also require the default branch. Pull requests and pushes run only secret-free fixtures. The receiver workflow has `contents: read`, disables checkout credential persistence, and uploads no raw logs or artifacts.
4. Set the GitHub `staging` environment variable `REQUEST_ERRORS_ENABLED_STAGING` to exact `true` only when staging observation is authorized. The workflow forwards the raw variable. Unset, empty, or exact `false` means inactive. Every other value, including uppercase or whitespace, fails activation with exit 2 and zero provider requests. Manual dispatch has no activation override. Check effective repository and staging environment values because staging environment values take precedence. Record only the winning scope, absent/empty/false/true/invalid classification, time, and revision. Repository absence alone does not establish inactivity.
5. Run the enabled workflow manually from the default branch and inspect the result. Missing credentials, refused access, or incomplete coverage produce a failed run. Establish hosted provider normalization with an authorized controlled staging failure and compare its revision, registered route, status, and trace with the response. Then inspect a subsequent scheduled run.
6. Verify the intended operator's GitHub Actions notification settings and actual failed-run inbox receipt. A workflow annotation or failed run alone does not prove inbox delivery. Record the run URL and safe matching event fields as activation evidence.

For an authorized local read, provide the same four `RAILWAY_*` values through your secret manager or process environment, set `REQUEST_ERRORS_ENVIRONMENT=staging` and `REQUEST_ERRORS_ENABLED_STAGING=true`, and run `node ops/diagnostics/receiver-cli.mjs`. Do not put the token in command arguments or a committed file. The only supported credential header is `Project-Access-Token`. Account bearer tokens are outside this interface. Environment admission precedes activation. Exact `production` returns `production-disabled`; missing or other environments return `invalid-config`. Both exit 2 without making a network request, regardless of activation.

Inactive staging exits 0 and writes exactly the following notice. It does not validate credentials, construct an observation window, report an accepted-failure count, or establish health or delivery. Unconfigured and deliberately false activation share this message.

```text
::notice title=Staging request-error observation::Inactive; zero provider requests.
```

Malformed staging activation exits 2 with exactly `::error title=Request error activation::status=refused reason=invalid-activation`. Neither terminal message echoes the flag or credentials. Importing the module has no activation side effect. Explicit `runReceiver(config, dependencies, write)` and `observeRequestFailures(config, dependencies)` calls observe independently of ambient CLI activation.

OAuth `project:viewer` is narrower, but OAuth access tokens expire and require a concrete refresh-token renewal arrangement. This implementation does not claim to provide that renewal. The separate metadata-backup observer receives only its presigned single-object GET and does not use this credential.

## Interpret an observation

`observeRequestFailures(config, { fetch, now })` returns a window, fresh normalized events, and coverage with a finite status and reason. The CLI emits one GitHub error annotation per accepted failure. For example:

```text
::error title=Staging request failure::revision=cb5888772b6150ceb083fdf84ac1572cba053336 environment=staging route=/api/habits status=500 trace=request-ref_01:1 classification=unexpected time=2026-10-18T11:55:00.123456789Z
```

Every displayed event value passes the diagnostic allowlist. The receiver constructs a new event and never copies raw messages, attributes, exceptions, provider responses, credentials, or account and habit identifiers into output. It accepts the actual five-field JSON console root and seven-field state observed by the formatter test. Extra fields, including a future `State.Message`, fail visibility until the new formatter representation receives review and proof. It accepts original console JSON with no attributes or an `error` level attribute, and the same exact root represented as string attributes using the pinned Railway CLI coercion. Conflicting representations fail. Hosted normalization remains an activation check.

| Exit | Meaning                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`  | With exact `true`, no accepted event in the observed interval. Inactive CLI execution instead emits only its fixed notice. Neither establishes application health. |
| `1`  | At least one validated request failure in an otherwise observed interval.                                                                                          |
| `2`  | Visibility is refused or incomplete. Independently validated failures still receive annotations when scope binding succeeded.                                      |

An incomplete observation emits a separate fixed annotation, such as `::error title=Request error visibility::status=unavailable reason=record-limit`. No provider error text appears in it.

| Reason                                                                      | Next action                                                                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-config`, `production-disabled`                                     | Check trusted staging configuration. Production observation is intentionally disabled.                                                                  |
| `provider-refused`, `scope-mismatch`                                        | Check the dedicated token, its environment scope, all configured UUIDs, the staging name, and the service instance.                                     |
| `redirect`, `http-error`, `network-failure`, `deadline`                     | Check Railway availability and runner connectivity. Do not print raw response bodies or enable raw application logging.                                 |
| `provider-errors`, `invalid-response`                                       | Investigate API/schema or authorization changes using safe metadata. GraphQL partial errors fail coverage.                                              |
| `invalid-record`, `invalid-timestamp`, `invalid-event`, `conflicting-event` | Compare an authorized synthetic event against the formatter handshake and provider representation. Do not widen the allowlist to accept private fields. |
| `body-limit`, `record-limit`, `event-limit`                                 | Treat the interval as incomplete. Investigate volume and missing coverage before changing a limit.                                                      |

The fixed query uses Railway `environmentLogs`, an internal service filter, and a 30-minute overlap ending at the receiver's UTC clock. It spans deployment changes without enumerating deployment IDs. Limits are 500 requested records, 1 MiB response bytes, 8 KiB per message or attribute value, 32 attributes with 128-byte keys, 100 distinct accepted events, and 10 seconds for the entire HTTP request and body. These are operating limits, not measured capacity. Exactly 500 records fails coverage because the provider may have truncated the interval. The output is at most 101 lines. Duplicate revision, environment, route, status, trace, and classification tuples collapse within one observation.

There is no persisted cursor or cross-run deduplication. Overlap can repeat annotations. Delayed or absent GitHub schedules beyond the overlap create gaps. Provider retention, dropped or delayed logs, uninstrumented explicit 500 responses, and failures before request handling can also leave gaps. An empty result does not prove the provider retained every event. Native HTTP 5xx metrics can corroborate failures but do not supply the required per-request revision, route, and trace. They do not replace this reader.

Implementation and local formatter/HTTP proof are separate from hosted activation. No live Railway read, scheduled execution, controlled hosted failure, or operator inbox delivery is claimed by the local fixtures. This receiver adds no public diagnostic endpoint, app dispatch credential, or paid service.

## Provider contract sources

The fixed query and string-valued log attributes follow the [Railway CLI environment log query](https://github.com/railwayapp/cli/blob/05ed159796ef6bf15de0dab388b1054c1af6f395/src/gql/queries/strings/EnvironmentLogs.graphql), [schema](https://github.com/railwayapp/cli/blob/05ed159796ef6bf15de0dab388b1054c1af6f395/src/gql/schema.json), and [attribute normalization](https://github.com/railwayapp/cli/blob/05ed159796ef6bf15de0dab388b1054c1af6f395/src/util/logs.rs). Credential setup follows the [Railway public API](https://docs.railway.com/integrations/api). The narrower alternative is described in [OAuth scopes](https://docs.railway.com/integrations/oauth/scopes-and-user-consent) and [OAuth token renewal](https://docs.railway.com/integrations/oauth/login-and-tokens).
