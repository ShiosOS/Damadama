using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using Damadama.Telemetry;
using Npgsql;
using OpenTelemetry;
using OpenTelemetry.Trace;
using TelemetryProof;

var httpOnly = args.Contains("--http-only", StringComparer.Ordinal);
var connectionString = Environment.GetEnvironmentVariable("TELEMETRY_POSTGRES");
if (!httpOnly && string.IsNullOrWhiteSpace(connectionString))
    throw new InvalidOperationException("TELEMETRY_POSTGRES is required. Use --http-only for explicitly partial local proof.");

string[] sentinels = ["token-sentinel", "cookie-sentinel", "query-sentinel", "habit-sentinel",
    "account-sentinel", "sql-sentinel", "exception-sentinel", "baggage-sentinel", "resource-sentinel", "event-sentinel", "link-sentinel"];
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

    var builder = WebApplication.CreateBuilder();
    builder.Logging.ClearProviders();
    builder.WebHost.UseUrls("http://127.0.0.1:0");
    builder.Services.AddPrivateRequestTracing();
    builder.Services.AddExceptionHandler(options => options.ExceptionHandler = context =>
    {
        context.Response.StatusCode = 500;
        return Task.CompletedTask;
    });
    await using var app = builder.Build();
    app.UseExceptionHandler();
    string? downstreamParent = null;
    app.MapGet("/dependency/{id}", (HttpContext context) =>
    {
        downstreamParent = context.Request.Headers["traceparent"];
        return Results.Ok();
    });
    app.MapPost("/work/{id}", async (HttpContext context) =>
    {
        Activity.Current?.SetTag("account.id", "account-sentinel");
        Activity.Current?.SetStatus(ActivityStatusCode.Error, "exception-sentinel");
        await context.Request.Body.CopyToAsync(Stream.Null);
        using var downstream = new HttpClient();
        var dependency = await downstream.GetAsync(app.Urls.Single() + "/dependency/account-sentinel?value=query-sentinel");
        dependency.EnsureSuccessStatusCode();
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
    app.MapGet("/exception/{id}", Fail);
    await app.StartAsync();
    var origin = app.Urls.Single();
    using var caller = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
    const string trace = "11111111111111111111111111111111";
    const string parent = "2222222222222222";
    using (SuppressInstrumentationScope.Begin())
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, origin + "/work/account-sentinel?value=query-sentinel");
        request.Headers.TryAddWithoutValidation("traceparent", $"00-{trace}-{parent}-01");
        request.Headers.TryAddWithoutValidation("tracestate", "private=account-sentinel");
        request.Headers.TryAddWithoutValidation("baggage", "private=baggage-sentinel");
        request.Headers.TryAddWithoutValidation("Authorization", "Bearer token-sentinel");
        request.Headers.TryAddWithoutValidation("Cookie", "private=cookie-sentinel");
        request.Content = new StringContent("{\"habit\":\"habit-sentinel\",\"account\":\"account-sentinel\"}", Encoding.UTF8, "application/json");
        using var response = await caller.SendAsync(request);
        Require(response.StatusCode == HttpStatusCode.OK, "Requests work with the configured exporter state.");
        using var error = await caller.GetAsync(origin + "/exception/account-sentinel?value=query-sentinel");
        Require(error.StatusCode == HttpStatusCode.InternalServerError, "Error responses work with the configured exporter state.");
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
            Require(!text.Contains(sentinel, StringComparison.Ordinal), "No private sentinel reaches OTLP.");
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
        var server = spans.Single(span => span.Kind == 2 && Convert.ToHexStringLower(span.Parent) == parent);
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
    Console.WriteLine($"PASS {scenario}. HTTP responses, privacy, and bounded shutdown verified.");
}
Console.WriteLine(httpOnly ? "PARTIAL proof. Actual PostgreSQL was not exercised." : "PASS actual HTTP, PostgreSQL, W3C parent continuity, OTLP privacy, and exporter refusal proof.");

static void Require(bool condition, string message)
{
    if (!condition)
        throw new InvalidOperationException(message);
}

static IResult Fail() => throw new InvalidOperationException("exception-sentinel");

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
