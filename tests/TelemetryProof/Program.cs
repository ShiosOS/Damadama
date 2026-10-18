using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Damadama;
using Damadama.Telemetry;
using Npgsql;
using OpenTelemetry;
using OpenTelemetry.Trace;
using TelemetryProof;

var httpOnly = args.Contains("--http-only", StringComparer.Ordinal);
var connectionString = Environment.GetEnvironmentVariable("TELEMETRY_POSTGRES");
if (!httpOnly && string.IsNullOrWhiteSpace(connectionString))
    throw new InvalidOperationException("TELEMETRY_POSTGRES is required. Use --http-only for explicitly partial local proof.");

(string Kind, string Value)[] sentinels = [("token", "token-sentinel"), ("cookie", "cookie-sentinel"),
    ("query", "query-sentinel"), ("habit", "habit-sentinel"), ("account", "account-sentinel"), ("sql", "sql-sentinel"),
    ("exception", "exception-sentinel"), ("baggage", "baggage-sentinel"), ("resource", "resource-sentinel"),
    ("event", "event-sentinel"), ("link", "link-sentinel"), ("scope", "scope-sentinel")];
foreach (var scenario in new[] { "accepted", "refused", "unavailable", "stalled", "disabled" })
{
    await using var receiver = new Receiver(scenario == "refused" ? 503 : 200, scenario == "stalled");
    Environment.SetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT", scenario == "disabled" ? null : receiver.Origin);
    Environment.SetEnvironmentVariable("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf");
    Environment.SetEnvironmentVariable("OTEL_EXPORTER_OTLP_HEADERS", "x-proof-key=collector-only");
    Environment.SetEnvironmentVariable("OTEL_RESOURCE_ATTRIBUTES", "private=resource-sentinel");
    Environment.SetEnvironmentVariable("OTEL_EXPORTER_OTLP_TIMEOUT", "10000");
    Environment.SetEnvironmentVariable("OTEL_SERVICE_NAME", "damadama-proof");
    Environment.SetEnvironmentVariable("OTEL_SERVICE_VERSION", "proof-version");
    if (scenario != "unavailable")
        receiver.Start();

    var previousOutput = Console.Out;
    using var console = new StringWriter();
    string? supportReference = null;
    const string trace = "11111111111111111111111111111111";
    const string parent = "2222222222222222";
    Console.SetOut(console);
    try
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = "Production" });
        builder.Logging.ClearProviders();
        builder.Logging.AddJsonConsole(options => options.IncludeScopes = true);
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Logging:LogLevel:Default"] = "Trace",
            ["Logging:Console:LogLevel:Default"] = "Trace",
            ["Logging:Console:FormatterOptions:IncludeScopes"] = "true"
        });
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Services.AddRequestDiagnostics();
        builder.Services.AddPrivateRequestTracing();
        await using var app = builder.Build();
        app.UseRouting();
        app.UseApiProtocol();
        app.UseExceptionHandler();
        string? downstreamParent = null;
        app.MapGet("/dependency/{id}", (HttpContext context) =>
        {
            downstreamParent = context.Request.Headers["traceparent"];
            return Results.Ok();
        });
        app.MapPost("/api/work/{id}", async (HttpContext context) =>
        {
            Activity.Current?.SetTag("account.id", "account-sentinel");
            Activity.Current?.SetStatus(ActivityStatusCode.Error, "exception-sentinel");
            await context.Request.Body.CopyToAsync(Stream.Null);
            using var downstream = new HttpClient();
            var dependency = await downstream.GetAsync(app.Urls.Single() + "/dependency/account-sentinel?value=query-sentinel");
            dependency.EnsureSuccessStatusCode();
            app.Services.GetService<TracerProvider>()?.ForceFlush(2500);
            if (!httpOnly)
            {
                await using var database = new NpgsqlConnection(connectionString);
                await database.OpenAsync();
                await using var query = new NpgsqlCommand("SELECT @habit::text /* sql-sentinel */", database);
                query.Parameters.AddWithValue("habit", "habit-sentinel");
                Require((string?)await query.ExecuteScalarAsync() == "habit-sentinel", "Actual PostgreSQL query returned its parameter.");
                await using var refused = new NpgsqlCommand("SELECT CAST(@habit AS integer) /* sql-sentinel */", database);
                refused.Parameters.AddWithValue("habit", "habit-sentinel");
                try
                {
                    await refused.ExecuteScalarAsync();
                }
                catch (PostgresException error) when (error.SqlState == "22P02")
                {
                    return Results.Ok();
                }
                throw new InvalidOperationException("PostgreSQL must refuse the private nonnumeric parameter.");
            }
            return Results.Ok();
        });
        app.MapGet("/api/exception/{id}", Fail);
        await app.StartAsync();
        var origin = app.Urls.Single();
        using var caller = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        using (SuppressInstrumentationScope.Begin())
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, origin + "/api/work/account-sentinel?value=query-sentinel");
            request.Headers.TryAddWithoutValidation("traceparent", $"00-{trace}-{parent}-01");
            request.Headers.TryAddWithoutValidation("tracestate", "private=account-sentinel");
            request.Headers.TryAddWithoutValidation("baggage", "private=baggage-sentinel");
            request.Headers.TryAddWithoutValidation("Authorization", "Bearer token-sentinel");
            request.Headers.TryAddWithoutValidation("Cookie", "private=cookie-sentinel");
            request.Content = new StringContent("{\"habit\":\"habit-sentinel\",\"account\":\"account-sentinel\"}", Encoding.UTF8, "application/json");
            using var response = await caller.SendAsync(request);
            Require(response.StatusCode == HttpStatusCode.OK, "Requests work with the configured exporter state.");
            Require(response.Headers.CacheControl is { Private: true, NoStore: true }, "Actual API protocol keeps successful responses private.");
            using var failed = new HttpRequestMessage(HttpMethod.Get, origin + "/api/exception/account-sentinel?value=query-sentinel");
            failed.Headers.TryAddWithoutValidation("traceparent", $"00-{trace}-{parent}-01");
            failed.Headers.TryAddWithoutValidation("tracestate", "private=account-sentinel");
            failed.Headers.TryAddWithoutValidation("Authorization", "Bearer token-sentinel");
            using var error = await caller.SendAsync(failed);
            Require(error.StatusCode == HttpStatusCode.InternalServerError, "Error responses work with the configured exporter state.");
            Require(error.Headers.CacheControl is { Private: true, NoStore: true }, "Actual API protocol keeps error responses private.");
            Require(error.Content.Headers.ContentType?.MediaType == "application/problem+json", "Actual ApiErrors retains problem responses.");
            using var problem = JsonDocument.Parse(await error.Content.ReadAsStringAsync());
            Require(problem.RootElement.GetProperty("title").GetString() == "An error occurred while processing your request." &&
                !problem.RootElement.TryGetProperty("detail", out _), "Unexpected errors retain the generic problem without exception details.");
            supportReference = problem.RootElement.GetProperty("traceId").GetString();
            Require(supportReference is not null && Regex.IsMatch(supportReference, "^[A-Za-z0-9:_-]{1,128}$") &&
                !supportReference.Contains(trace, StringComparison.Ordinal), "Server support references remain safe and separate from inherited W3C trace IDs.");
        }

        using (var source = new ActivitySource("Npgsql"))
        {
            using (var activity = source.StartActivity("event-sentinel", ActivityKind.Client))
                activity?.AddEvent(new ActivityEvent("exception-sentinel"));
            using (var activity = source.StartActivity("account-sentinel", ActivityKind.Client))
                activity?.AddEvent(new ActivityEvent("received-first-response"));
            using (var activity = source.StartActivity("event-sentinel", ActivityKind.Client))
                activity?.AddEvent(new ActivityEvent("received-first-response", tags: new ActivityTagsCollection { { "private", "event-sentinel" } }));
            using var linked = source.StartActivity("link-sentinel", ActivityKind.Client,
                default(ActivityContext), links: [new ActivityLink(new ActivityContext(ActivityTraceId.CreateRandom(),
                ActivitySpanId.CreateRandom(), ActivityTraceFlags.Recorded, "private=account-sentinel"))]);
        }

        var provider = app.Services.GetService<TracerProvider>();
        var shutdown = Stopwatch.StartNew();
        provider?.ForceFlush(2500);
        await app.StopAsync().WaitAsync(TimeSpan.FromSeconds(5));
        await app.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
        shutdown.Stop();
        Require(shutdown.Elapsed < TimeSpan.FromSeconds(8), "Exporter flush and host shutdown are bounded.");
        foreach (var payload in receiver.Payloads)
        {
            var text = Encoding.UTF8.GetString(payload);
            foreach (var sentinel in sentinels)
                Require(!text.Contains(sentinel.Value, StringComparison.Ordinal),
                    $"Private sentinel category {sentinel.Kind} at {OtlpSpans.Locate(payload, sentinel.Value)} in {scenario}.");
            foreach (var forbidden in new[] { "url.full", "url.path", "url.query", "db.query.text", "db.statement", "db.namespace", "server.address", "exception.message", "account.id" })
                Require(!text.Contains(forbidden, StringComparison.Ordinal), "Only allowlisted attributes reach OTLP.");
        }
        Require(receiver.InvalidRequests == 0, "Only protobuf trace exports with the configured header reach the receiver.");

        if (scenario is "accepted" or "refused" or "stalled")
            Require(receiver.Payloads.Count > 0, "The local receiver observed actual OTLP export attempts.");
        if (scenario == "disabled")
        {
            Require(provider is null, "No tracing provider is registered without an endpoint.");
            Require(receiver.Payloads.Count == 0, "Disabled tracing sends no exports.");
        }
        if (scenario == "accepted")
        {
            var spans = receiver.Payloads.SelectMany(OtlpSpans.Read)
                .Where(span => Convert.ToHexStringLower(span.Trace) == trace).ToArray();
            var server = spans.Single(span => span.Kind == 2 && Convert.ToHexStringLower(span.Parent) == parent &&
                spans.Any(child => child.Kind == 3 && child.Name == "HTTP request" && child.Parent.SequenceEqual(span.Id)));
            Require(spans.Count(span => span.Kind == 2 && Convert.ToHexStringLower(span.Parent) == parent) == 2,
                "Both successful and failed requests preserve the deliberately supplied W3C trace parent.");
            Require(server.Name == "HTTP request", "Server names exclude concrete URLs and route values.");
            var client = spans.Single(span => span.Kind == 3 && span.Name == "HTTP request" && span.Parent.SequenceEqual(server.Id));
            Require(downstreamParent?.StartsWith($"00-{trace}-{Convert.ToHexStringLower(client.Id)}-", StringComparison.Ordinal) == true,
                "HttpClient propagates the actual child context to the next HTTP handler.");
            Require(spans.Any(span => span.Kind == 2 && span.Parent.SequenceEqual(client.Id)), "The downstream server continues its HttpClient parent.");
            if (!httpOnly)
                Require(spans.Any(span => span.Kind == 3 && span.Name == "PostgreSQL" && span.Parent.SequenceEqual(server.Id)),
                    "Actual PostgreSQL work exports a child of the incoming server span.");
            var all = receiver.Payloads.SelectMany(OtlpSpans.Read).ToArray();
            Require(all.All(span => span.Name is "HTTP request" or "PostgreSQL"), "Unremovable event and link spans are dropped.");
            Require(receiver.Payloads.Any(payload => Encoding.UTF8.GetString(payload).Contains("received-first-response", StringComparison.Ordinal)),
                "The attribute-free Npgsql timing event remains exportable.");
        }
    }
    finally
    {
        Console.SetOut(previousOutput);
    }
    var bytes = console.ToString();
    foreach (var sentinel in sentinels)
        Require(!bytes.Contains(sentinel.Value, StringComparison.Ordinal), $"JSON console excludes private {sentinel.Kind} values.");
    Require(!bytes.Contains("InvalidOperationException", StringComparison.Ordinal), "JSON console excludes exception types.");
    var lines = bytes.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    Require(lines.Length == 1, "Actual diagnostic filters emit only one safe failure event despite permissive logging configuration.");
    using var record = JsonDocument.Parse(lines.Single());
    var entry = record.RootElement;
    var state = entry.GetProperty("State");
    Require(entry.GetProperty("Category").GetString() == "Damadama.RequestDiagnostics" &&
        entry.GetProperty("LogLevel").GetString() == "Error", "The sole JSON console event has the exact approved category and level.");
    Require(state.GetProperty("TraceId").GetString() == supportReference &&
        state.GetProperty("Route").GetString() == "/api/exception/{id}" &&
        state.GetProperty("Status").GetInt32() == 500 && state.GetProperty("Classification").GetString() == "unexpected",
        "The failure event matches its response support reference and safe original route.");
    Require(!entry.TryGetProperty("Scopes", out _) && !entry.TryGetProperty("Exception", out _),
        "Actual JSON console configuration excludes scopes and exceptions.");
    Console.WriteLine($"PASS {scenario}. HTTP responses, diagnostic reference and log privacy, OTLP privacy, and bounded shutdown verified.");
}
Console.WriteLine(httpOnly ? "PARTIAL proof. Actual PostgreSQL was not exercised." : "PASS actual HTTP, PostgreSQL, W3C parent continuity, OTLP privacy, and exporter refusal proof.");

static void Require(bool condition, string message)
{
    if (!condition)
        throw new InvalidOperationException(message);
}

static IResult Fail(HttpContext context, ILoggerFactory loggers)
{
    var unsafeLogger = loggers.CreateLogger("Damadama.RequestDiagnostics.Unsafe");
    using var scope = unsafeLogger.BeginScope(new Dictionary<string, string> { ["scope-sentinel"] = "account-sentinel" });
    unsafeLogger.LogError("Private {Token} {Habit} {Path} {Query}", context.Request.Headers.Authorization.ToString(),
        "habit-sentinel", context.Request.Path, context.Request.QueryString);
    loggers.CreateLogger<RequestDiagnostics>().LogInformation("habit-sentinel");
    throw new InvalidOperationException("exception-sentinel");
}

internal sealed class Receiver : IAsyncDisposable
{
    private readonly HttpListener listener = new();
    private readonly int status;
    private readonly bool stall;
    private readonly CancellationTokenSource stopping = new();
    private Task? loop;
    public ConcurrentQueue<byte[]> Payloads { get; } = new();
    public int InvalidRequests { get; private set; }
    public string Origin { get; }

    public Receiver(int status, bool stall)
    {
        this.status = status;
        this.stall = stall;
        using var reservation = new TcpListener(IPAddress.Loopback, 0);
        reservation.Start();
        Origin = $"http://127.0.0.1:{((IPEndPoint)reservation.LocalEndpoint).Port}/";
        listener.Prefixes.Add(Origin);
    }

    public void Start()
    {
        listener.Start();
        loop = Receive();
    }

    private async Task Receive()
    {
        try
        {
            while (listener.IsListening)
            {
                var context = await listener.GetContextAsync();
                if (context.Request.RawUrl != "/v1/traces" || context.Request.HttpMethod != "POST" ||
                    context.Request.ContentType != "application/x-protobuf" || context.Request.Headers["x-proof-key"] != "collector-only")
                    InvalidRequests++;
                using var body = new MemoryStream();
                await context.Request.InputStream.CopyToAsync(body);
                Payloads.Enqueue(body.ToArray());
                if (stall)
                    await Task.Delay(Timeout.Infinite, stopping.Token);
                context.Response.StatusCode = status;
                context.Response.ContentType = "application/x-protobuf";
                context.Response.ContentLength64 = 0;
                context.Response.Close();
            }
        }
        catch (HttpListenerException) when (!listener.IsListening) { }
        catch (ObjectDisposedException) when (!listener.IsListening) { }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested) { }
    }

    public async ValueTask DisposeAsync()
    {
        await stopping.CancelAsync();
        listener.Close();
        if (loop is not null)
            await loop.WaitAsync(TimeSpan.FromSeconds(5));
        stopping.Dispose();
    }
}
