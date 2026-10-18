# Private request tracing

This library prepares trace-only ASP.NET Core, HttpClient, and Npgsql instrumentation. The application does not reference or register it yet. Server startup and package integration wait for the ops owner's final published diagnostics handoff.

After that handoff, reference `Damadama.Telemetry.csproj` from the server and call `builder.Services.AddPrivateRequestTracing()` before building the host. Npgsql already emits the `Npgsql` activity source. This module subscribes to that source without changing database settings.

## Export contract

Without `OTEL_EXPORTER_OTLP_ENDPOINT`, the module registers no provider. With an endpoint, the official OTLP exporter reads `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`, and `OTEL_EXPORTER_OTLP_HEADERS`. The exporter supports its normal protocols. The proof exercises `http/protobuf` against a local receiver. Export timeout is capped at one second. The queue holds at most 256 spans and each batch holds at most 64. Exporter refusal does not fail an HTTP request.

Only tracing is registered. No metric or log exporter is registered. Resource attributes come only from `OTEL_SERVICE_NAME`, `OTEL_SERVICE_VERSION`, and the SDK-generated service instance ID. Arbitrary `OTEL_RESOURCE_ATTRIBUTES` are excluded.

The final processor retains trace IDs, span IDs, parent IDs, span kind, timestamps, status code, fixed span names, known HTTP methods, numeric HTTP response codes, and the constant PostgreSQL system name. It permits Npgsql's `received-first-response` timing event only when it has no attributes. It removes all other tags, trace state, and status descriptions. It drops spans containing other events or any links because .NET Activity cannot remove those through its public API. Failed database spans containing exception events may therefore be absent. The enclosing HTTP span still reports the request outcome.

The processor does not export URL paths, query strings, route values, headers, tokens, cookies, request bodies, habit text, account identifiers, SQL, parameters, database names, peer addresses, or exception details. W3C trace context remains available for HTTP propagation. Export privacy does not configure the application's separate log pipeline or external Railway edge tracing.

## Run the proof

Run `dotnet run --project tests/TelemetryProof` with `TELEMETRY_POSTGRES` pointing to a disposable local PostgreSQL database. The proof performs a successful parameterized SQL query and a real PostgreSQL parameter refusal through Npgsql during a Kestrel request. It parses the exported OTLP protobuf and compares literal incoming parent IDs, HTTP child IDs, downstream received context, and PostgreSQL parent IDs. It scans every received export for private sentinels and forbidden attribute keys.

The proof also drives a receiver returning HTTP 503, an unavailable receiver, a receiver that stalls, and an unconfigured endpoint. It checks working HTTP responses, real unexpected exceptions, and bounded exporter flush plus host shutdown. It sends spans with unremovable private events and links to prove rejection. The `Railway tracing proof` workflow runs this against an ephemeral PostgreSQL service. It uses no provider credentials.

`dotnet run --project tests/TelemetryProof -- --http-only` runs an explicitly partial local proof when Docker is unavailable. It does not establish PostgreSQL coverage.

## Activation remains separate

No Railway setting is changed by this code. Native tracing activation, application integration, deployment, and live edge, application, and database readback remain separate work. Enabling tracing adds Railway's OTEL variables on the next deployment. It requires review of the concrete activation plan. Do not enable automatic instrumentation alongside this SDK.

The primary references are [Railway .NET tracing](https://docs.railway.com/observability/tracing/dotnet), [OpenTelemetry .NET exporters](https://opentelemetry.io/docs/languages/dotnet/exporters/), and [Npgsql tracing](https://www.npgsql.org/doc/diagnostics/tracing.html).
