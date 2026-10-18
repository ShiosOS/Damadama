using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Logging;
using NUnit.Framework;

namespace Damadama.ReceiverProtocol;

[NonParallelizable]
public class RequestReceiverFormatterTests
{
    [Test]
    public async Task Real_json_console_bytes_correlate_with_failed_HTTP_responses_without_private_data()
    {
        const string revision = "cb5888772b6150ceb083fdf84ac1572cba053336";
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "Damadama.slnx"))) root = root.Parent;
        var repository = root?.FullName ?? throw new InvalidOperationException("Run tests inside the repository.");
        var fixture = Path.Combine(repository, ".audit", "receiver-console-fixture.json");
        Directory.CreateDirectory(Path.GetDirectoryName(fixture)!);
        File.Delete(fixture);
        var webRoot = Path.Combine(repository, ".audit", $"receiver-host-{Guid.NewGuid():N}");
        Directory.CreateDirectory(webRoot);
        await File.WriteAllTextAsync(Path.Combine(webRoot, "release.json"), JsonSerializer.Serialize(new { source = new { commit = revision } }));
        var previousEnvironment = Environment.GetEnvironmentVariable("RAILWAY_ENVIRONMENT_NAME");
        var previousOutput = Console.Out;
        using var output = new StringWriter();
        var expected = new List<object>();
        try
        {
            Environment.SetEnvironmentVariable("RAILWAY_ENVIRONMENT_NAME", "staging");
            Console.SetOut(output);
            var builder = WebApplication.CreateBuilder(new WebApplicationOptions { WebRootPath = webRoot });
            builder.WebHost.UseTestServer();
            builder.Logging.ClearProviders();
            builder.Logging.AddJsonConsole(options => options.IncludeScopes = true);
            builder.Services.AddRequestDiagnostics();
            builder.Services.AddHealthChecks().AddCheck("receiver-readiness", () => HealthCheckResult.Unhealthy("private-readiness-sentinel"));
            await using (var app = builder.Build())
            {
                app.UseRouting();
                app.Use(async (context, next) =>
                {
                    using var scope = context.RequestServices.GetRequiredService<ILogger<RequestDiagnostics>>().BeginScope(
                        new Dictionary<string, string> { ["private-scope-sentinel"] = "private-account-sentinel" });
                    await next(context);
                });
                app.UseExceptionHandler();
                app.MapPut("/api/habits/{id:guid}/entries/{date}", Fail);
                app.MapPost("/api/habits", IResult () => throw new DbUpdateException("private-storage-sentinel"));
                app.MapHealthChecks("/health/ready", new() { ResponseWriter = RequestDiagnostics.WriteReadinessResponse });
                await app.StartAsync();
                using var client = app.GetTestClient();
                using var request = new HttpRequestMessage(HttpMethod.Put,
                    "/api/habits/29ca9d81-d50d-45a8-a04b-976ca30f8fc4/entries/2026-01-04?private-query-sentinel=1")
                {
                    Content = new StringContent("private-body-sentinel")
                };
                request.Headers.Authorization = new("Bearer", "private-token-sentinel");
                using var unexpected = await client.SendAsync(request);
                Assert.That(unexpected.StatusCode, Is.EqualTo(HttpStatusCode.InternalServerError));
                var problem = await unexpected.Content.ReadFromJsonAsync<JsonElement>();
                Assert.That(problem.TryGetProperty("detail", out _), Is.False);
                expected.Add(new
                {
                    revision,
                    environment = "staging",
                    route = "/api/habits/{id:guid}/entries/{date}",
                    status = 500,
                    traceId = problem.GetProperty("traceId").GetString(),
                    classification = "unexpected"
                });
                using var storage = await client.PostAsync("/api/habits", null);
                Assert.That(storage.StatusCode, Is.EqualTo(HttpStatusCode.ServiceUnavailable));
                var storageProblem = await storage.Content.ReadFromJsonAsync<JsonElement>();
                expected.Add(new
                {
                    revision,
                    environment = "staging",
                    route = "/api/habits",
                    status = 503,
                    traceId = storageProblem.GetProperty("traceId").GetString(),
                    classification = "storage-unavailable"
                });
                using var readiness = await client.GetAsync("/health/ready");
                Assert.That(readiness.StatusCode, Is.EqualTo(HttpStatusCode.ServiceUnavailable));
                expected.Add(new
                {
                    revision,
                    environment = "staging",
                    route = "/health/ready",
                    status = 503,
                    traceId = readiness.Headers.GetValues("X-Trace-Id").Single(),
                    classification = "readiness-unavailable"
                });
                await app.StopAsync();
            }
        }
        finally
        {
            Console.SetOut(previousOutput);
            Environment.SetEnvironmentVariable("RAILWAY_ENVIRONMENT_NAME", previousEnvironment);
            File.Delete(Path.Combine(webRoot, "release.json"));
            Directory.Delete(webRoot);
        }
        var bytes = output.ToString();
        foreach (var secret in new[] { "private-", "29ca9d81-d50d-45a8-a04b-976ca30f8fc4", "2026-01-04", "InvalidOperationException", "DbUpdateException" })
            Assert.That(bytes.Contains(secret, StringComparison.Ordinal), Is.False, "The console stream must exclude private values.");
        var lines = bytes.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        Assert.That(lines, Has.Length.EqualTo(3));
        for (var index = 0; index < lines.Length; index++)
        {
            using var document = JsonDocument.Parse(lines[index]);
            var state = document.RootElement.GetProperty("State");
            var response = JsonSerializer.SerializeToElement(expected[index]);
            Assert.That(state.GetProperty("TraceId").GetString(), Is.EqualTo(response.GetProperty("traceId").GetString()));
            Assert.That(state.GetProperty("Revision").GetString(), Is.EqualTo(revision));
            Assert.That(state.GetProperty("Environment").GetString(), Is.EqualTo("staging"));
        }
        await File.WriteAllTextAsync(fixture, JsonSerializer.Serialize(new { lines, expected }));
    }

    private static IResult Fail(HttpContext context, ILoggerFactory loggers)
    {
        loggers.CreateLogger("Damadama.RequestDiagnostics.Unsafe").LogError("private-habit-sentinel {Token}", context.Request.Headers.Authorization.ToString());
        throw new InvalidOperationException("private-exception-sentinel");
    }
}
