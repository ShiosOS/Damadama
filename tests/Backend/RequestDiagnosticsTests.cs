using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Damadama.Testing;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Console;
using Microsoft.Extensions.Options;
using NUnit.Framework;

namespace Damadama.DiagnosticsProtocol;

public class RequestDiagnosticsTests
{
    [Test]
    public async Task Unexpected_failure_preserves_generic_problem_and_correlates_original_route_under_real_filters()
    {
        using var capture = new DiagnosticLogCapture();
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        builder.Logging.AddProvider(capture);
        builder.Services.AddRequestDiagnostics();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Logging:LogLevel:Default"] = "Trace",
            ["Logging:LogLevel:Microsoft.AspNetCore.Diagnostics.ExceptionHandlerMiddleware"] = "Trace",
            ["Logging:LogLevel:Damadama.RequestDiagnostics"] = "Trace",
            ["Logging:DiagnosticCapture:LogLevel:Default"] = "Trace",
            ["Logging:DiagnosticCapture:LogLevel:Damadama.RequestDiagnostics.Unsafe"] = "Trace",
            ["Logging:Console:LogLevel:Default"] = "Trace",
            ["Logging:Console:FormatterOptions:IncludeScopes"] = "true"
        });
        builder.Services.Configure<LoggerFilterOptions>(options =>
        {
            options.CaptureScopes = true;
            options.Rules.Add(new LoggerFilterRule(null, null, LogLevel.Trace, (_, _, _) => true));
        });
        builder.Services.Configure<JsonConsoleFormatterOptions>(options => options.IncludeScopes = true);
        await using var app = builder.Build();
        app.UseRouting();
        app.UseExceptionHandler();
        app.MapPost("/api/diagnostic-probe/{id:guid}", Fail);
        app.MapGet("/api/validation-probe", IResult () => throw new ArgumentException("Use a name.", "name"));
        await app.StartAsync();
        using var client = app.GetTestClient();
        using var request = new HttpRequestMessage(HttpMethod.Post,
            "/api/diagnostic-probe/29ca9d81-d50d-45a8-a04b-976ca30f8fc4?private-query-sentinel=1")
        {
            Content = new StringContent("private-body-sentinel")
        };
        request.Headers.Authorization = new("Bearer", "private-token-sentinel");
        using var response = await client.SendAsync(request);
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.InternalServerError));
        Assert.That(response.Content.Headers.ContentType?.MediaType, Is.EqualTo("application/problem+json"));
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.That(problem.GetProperty("title").GetString(), Is.EqualTo("An error occurred while processing your request."));
        Assert.That(problem.TryGetProperty("detail", out _), Is.False);
        Assert.That(capture.Entries.Count, Is.EqualTo(1));
        var failure = capture.Entries.Single();
        Assert.That(failure.Field("TraceId"), Is.EqualTo(problem.GetProperty("traceId").GetString()));
        Assert.That(failure.Field("Route"), Is.EqualTo("/api/diagnostic-probe/{id:guid}"));
        Assert.That(failure.Field("Status"), Is.EqualTo(500));
        Assert.That(failure.Field("Classification"), Is.EqualTo("unexpected"));
        using var invalid = await client.GetAsync("/api/validation-probe");
        Assert.That(invalid.StatusCode, Is.EqualTo(HttpStatusCode.BadRequest));
        var validation = await invalid.Content.ReadFromJsonAsync<JsonElement>();
        Assert.That(validation.GetProperty("errors").GetProperty("name")[0].GetString(), Does.StartWith("Use a name."));
        Assert.That(capture.Entries.Count, Is.EqualTo(1));
        capture.AssertPrivate("private-token-sentinel", "private-body-sentinel", "private-query-sentinel",
            "29ca9d81-d50d-45a8-a04b-976ca30f8fc4", "private-owner-sentinel", "private-habit-sentinel",
            "private-exception-sentinel", "private-scope-sentinel", "InvalidOperationException");
        Assert.That(app.Services.GetRequiredService<IOptions<LoggerFilterOptions>>().Value.CaptureScopes, Is.False);
        Assert.That(app.Services.GetRequiredService<IOptions<JsonConsoleFormatterOptions>>().Value.IncludeScopes, Is.False);
    }

    [Test]
    public async Task Storage_and_readiness_failures_keep_default_responses_and_matching_references()
    {
        using var capture = new DiagnosticLogCapture();
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        builder.Logging.AddProvider(capture);
        builder.Services.AddRequestDiagnostics();
        builder.Services.AddHealthChecks().AddCheck("readiness-probe", () => HealthCheckResult.Unhealthy(
            "private-readiness-sentinel", new InvalidOperationException("private-readiness-exception")), tags: ["ready"]);
        await using var app = builder.Build();
        app.UseRouting();
        app.UseExceptionHandler();
        app.MapPost("/api/storage-probe/{id:guid}", IResult () => throw new DbUpdateException("private-storage-exception"));
        app.MapHealthChecks("/health/ready", new()
        {
            Predicate = check => check.Tags.Contains("ready"),
            ResponseWriter = RequestDiagnostics.WriteReadinessResponse
        });
        await app.StartAsync();
        using var client = app.GetTestClient();
        using var storage = await client.PostAsync("/api/storage-probe/29ca9d81-d50d-45a8-a04b-976ca30f8fc4?private-storage-query=1", null);
        Assert.That(storage.StatusCode, Is.EqualTo(HttpStatusCode.ServiceUnavailable));
        Assert.That(storage.Content.Headers.ContentType?.MediaType, Is.EqualTo("application/problem+json"));
        var problem = await storage.Content.ReadFromJsonAsync<JsonElement>();
        Assert.That(problem.GetProperty("title").GetString(), Is.EqualTo("The habit could not be saved or loaded."));
        Assert.That(problem.GetProperty("detail").GetString(), Is.EqualTo("Storage is unavailable. Try again when the service is ready."));
        var storageEvent = capture.Entries.Single();
        Assert.That(storageEvent.Field("TraceId"), Is.EqualTo(problem.GetProperty("traceId").GetString()));
        Assert.That(storageEvent.Field("Route"), Is.EqualTo("/api/storage-probe/{id:guid}"));
        Assert.That(storageEvent.Field("Status"), Is.EqualTo(503));
        Assert.That(storageEvent.Field("Classification"), Is.EqualTo("storage-unavailable"));

        using var readiness = await client.GetAsync("/health/ready?private-readiness-query=1");
        Assert.That(readiness.StatusCode, Is.EqualTo(HttpStatusCode.ServiceUnavailable));
        Assert.That(readiness.Content.Headers.ContentType?.MediaType, Is.EqualTo("text/plain"));
        Assert.That(await readiness.Content.ReadAsStringAsync(), Is.EqualTo("Unhealthy"));
        Assert.That(capture.Entries.Count, Is.EqualTo(2));
        var readinessEvent = capture.Entries.Last();
        Assert.That(readinessEvent.Field("TraceId"), Is.EqualTo(readiness.Headers.GetValues("X-Trace-Id").Single()));
        Assert.That(readinessEvent.Field("Route"), Is.EqualTo("/health/ready"));
        Assert.That(readinessEvent.Field("Status"), Is.EqualTo(503));
        Assert.That(readinessEvent.Field("Classification"), Is.EqualTo("readiness-unavailable"));
        capture.AssertPrivate("private-storage-exception", "private-storage-query", "private-readiness-sentinel",
            "private-readiness-exception", "private-readiness-query", "29ca9d81-d50d-45a8-a04b-976ca30f8fc4",
            "DbUpdateException", "InvalidOperationException");
    }

    private static IResult Fail(HttpContext context, ILoggerFactory loggers)
    {
        var unsafeLogger = loggers.CreateLogger("Damadama.RequestDiagnostics.Unsafe");
        using var scope = unsafeLogger.BeginScope(new Dictionary<string, string> { ["private-scope-sentinel"] = "private-owner-sentinel" });
        var exception = new InvalidOperationException("private-exception-sentinel");
        unsafeLogger.LogError(exception, "Unsafe {Token} {Habit} {Path} {Query}",
            context.Request.Headers.Authorization.ToString(), "private-habit-sentinel", context.Request.Path, context.Request.QueryString);
        loggers.CreateLogger<RequestDiagnostics>().LogInformation("private-habit-sentinel");
        throw exception;
    }

    [TestCase(null)]
    [TestCase("not json")]
    [TestCase("{}")]
    [TestCase("[]")]
    [TestCase("{\"source\":null}")]
    [TestCase("{\"source\":{\"commit\":40}}")]
    [TestCase("{\"source\":{\"commit\":\"bad\"}}")]
    [TestCase("{\"source\":{\"commit\":\"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\"}}")]
    public void Missing_or_invalid_packaged_identity_is_explicitly_unavailable(string? metadata)
    {
        using var identity = new PackagedIdentity(metadata);
        using var capture = new DiagnosticLogCapture();
        using var logs = LoggerFactory.Create(logging => logging.AddProvider(capture));
        var diagnostics = new RequestDiagnostics(identity, logs.CreateLogger<RequestDiagnostics>());
        var context = new DefaultHttpContext();
        context.Request.Path = "/private-unregistered-path";
        context.Request.QueryString = new("?private-query=1");
        diagnostics.Record(context, RequestFailure.Unexpected);
        Assert.That(capture.Entries.Single().Field("Revision"), Is.EqualTo("unavailable"));
        Assert.That(capture.Entries.Single().Field("Route"), Is.EqualTo("unavailable"));
        capture.AssertPrivate("private-unregistered-path", "private-query");
    }

    [TestCase("staging", "staging")]
    [TestCase("production", "production")]
    [TestCase(null, "unavailable")]
    [TestCase("private-environment-sentinel", "unavailable")]
    public void Identity_reads_packaged_commit_and_trusted_environment_once(string? railway, string expected)
    {
        const string revision = "CB5888772B6150CEB083FDF84AC1572CBA053336";
        using var identity = new PackagedIdentity(JsonSerializer.Serialize(new { source = new { commit = revision } }));
        using var capture = new DiagnosticLogCapture();
        using var logs = LoggerFactory.Create(logging => logging.AddProvider(capture));
        var previous = Environment.GetEnvironmentVariable("RAILWAY_ENVIRONMENT_NAME");
        try
        {
            Environment.SetEnvironmentVariable("RAILWAY_ENVIRONMENT_NAME", railway);
            var diagnostics = new RequestDiagnostics(identity, logs.CreateLogger<RequestDiagnostics>());
            File.WriteAllText(Path.Combine(identity.WebRootPath, "release.json"), "{}");
            Environment.SetEnvironmentVariable("RAILWAY_ENVIRONMENT_NAME", "changed-after-construction");
            diagnostics.Record(new DefaultHttpContext(), RequestFailure.Unexpected);
            diagnostics.Record(new DefaultHttpContext(), RequestFailure.Storage);
            Assert.That(capture.Entries.Select(entry => entry.Field("Revision")), Is.All.EqualTo(revision.ToLowerInvariant()));
            Assert.That(capture.Entries.Select(entry => entry.Field("Environment")), Is.All.EqualTo(expected));
        }
        finally
        {
            Environment.SetEnvironmentVariable("RAILWAY_ENVIRONMENT_NAME", previous);
        }
    }

    [TestCase("")]
    [TestCase("private trace\r\nvalue")]
    [TestCase("<invalid>")]
    [TestCase("not/allowed")]
    public void Invalid_server_trace_is_replaced_before_response_or_event_use(string trace)
    {
        var context = new DefaultHttpContext { TraceIdentifier = trace };
        var validated = RequestDiagnostics.TraceId(context);
        Assert.That(validated, Does.Match("^[A-Za-z0-9:_-]{1,128}$"));
        Assert.That(validated, Is.EqualTo(context.TraceIdentifier));
        Assert.That(RequestDiagnostics.TraceId(context), Is.EqualTo(validated));
    }

    [Test]
    public void Server_trace_length_boundary_preserves_valid_and_replaces_overlong_values()
    {
        var context = new DefaultHttpContext { TraceIdentifier = new string('a', 128) };
        Assert.That(RequestDiagnostics.TraceId(context), Is.EqualTo(new string('a', 128)));
        context.TraceIdentifier = new string('a', 129);
        Assert.That(RequestDiagnostics.TraceId(context), Does.Match("^[A-Za-z0-9:_-]{1,128}$"));
    }

    private sealed class PackagedIdentity : IWebHostEnvironment, IDisposable
    {
        private readonly PhysicalFileProvider files;
        public PackagedIdentity(string? metadata)
        {
            WebRootPath = Path.Combine(Path.GetTempPath(), $"damadama-diagnostics-{Guid.NewGuid():N}");
            Directory.CreateDirectory(WebRootPath);
            if (metadata is not null) File.WriteAllText(Path.Combine(WebRootPath, "release.json"), metadata);
            files = new PhysicalFileProvider(WebRootPath);
            WebRootFileProvider = files;
        }
        public string ApplicationName { get; set; } = "Damadama";
        public string EnvironmentName { get; set; } = "Production";
        public string WebRootPath { get; set; }
        public IFileProvider WebRootFileProvider { get; set; }
        public string ContentRootPath { get; set; } = "";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public void Dispose()
        {
            files.Dispose();
            File.Delete(Path.Combine(WebRootPath, "release.json"));
            Directory.Delete(WebRootPath);
        }
    }
}
