using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Damadama.Testing;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using NUnit.Framework;

namespace Damadama.Tests;

public class RequestFailureTests
{
    [Test]
    public async Task Actual_storage_and_schema_failures_correlate_without_private_logs_or_protocol_changes()
    {
        using var capture = new DiagnosticLogCapture();
        using var app = new TestApp(DatabaseFixture.Database.GetConnectionString(), endpoints =>
            endpoints.MapGet("/api/failure-probe/{id:guid}",
                IResult () => throw new InvalidOperationException("private-unexpected-diagnostics")));
        using var capturedApp = app.WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Logging:LogLevel:Default"] = "Trace",
                ["Logging:LogLevel:Microsoft.EntityFrameworkCore.Database.Command"] = "Trace",
                ["Logging:LogLevel:Damadama.Habits.HabitsDb"] = "Trace",
                ["Logging:DiagnosticCapture:LogLevel:Default"] = "Trace",
                ["Logging:Console:LogLevel:Default"] = "Trace"
            }));
            builder.ConfigureTestServices(services => services.AddSingleton<ILoggerProvider>(capture));
        });
        using var client = capturedApp.CreateClient();
        var token = app.Token("private-owner-diagnostics");
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        using var created = await client.PostAsJsonAsync("/api/habits", HabitTests.Walking with
        {
            Name = "private-habit-diagnostics",
            Good = "private-good-diagnostics",
            Weekdays = [1, 2, 3, 4, 5, 6, 7],
            RepeatEveryWeeks = 1
        });
        Assert.That(created.StatusCode, Is.EqualTo(HttpStatusCode.Created));
        var habitId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var path = $"/api/habits/{habitId}/entries/2026-01-04";
        await using (await EntryWriteFailure.Install(DatabaseFixture.Execute, EntryWriteOperation.Insert, EntryFailureTiming.BeforeWrite))
        {
            using var failed = await client.PutAsJsonAsync($"{path}?private-query-diagnostics=1", EntrySteps.Change());
            Assert.That(failed.StatusCode, Is.EqualTo(HttpStatusCode.ServiceUnavailable));
            Assert.That(failed.Headers.CacheControl?.ToString(), Does.Contain("no-store"));
            Assert.That(failed.Content.Headers.ContentType?.MediaType, Is.EqualTo("application/problem+json"));
            var problem = await failed.Content.ReadFromJsonAsync<JsonElement>();
            Assert.That(problem.GetProperty("title").GetString(), Is.EqualTo("The habit could not be saved or loaded."));
            Assert.That(problem.GetProperty("detail").GetString(), Is.EqualTo("Storage is unavailable. Try again when the service is ready."));
            var storage = capture.Entries.Single();
            Assert.That(storage.Field("Status"), Is.EqualTo(503));
            Assert.That(storage.Field("Classification"), Is.EqualTo("storage-unavailable"));
            Assert.That(storage.Field("Route"), Is.EqualTo("/api/habits/{id:guid}/entries/{date}"));
            Assert.That(storage.Field("TraceId"), Is.EqualTo(problem.GetProperty("traceId").GetString()));
        }

        using var healthy = await client.GetAsync("/health/ready");
        Assert.That(healthy.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        Assert.That(await healthy.Content.ReadAsStringAsync(), Is.EqualTo("Healthy"));
        Assert.That(healthy.Content.Headers.ContentType?.MediaType, Is.EqualTo("text/plain"));
        Assert.That(healthy.Headers.GetValues("X-Trace-Id").Single(), Does.Match("^[A-Za-z0-9:_-]{1,128}$"));
        await DatabaseFixture.Execute("ALTER TABLE \"DailyEntries\" RENAME TO \"MissingDiagnosticEntries\"");
        try
        {
            using var ready = await client.GetAsync("/health/ready?private-probe-query=1");
            Assert.That(ready.StatusCode, Is.EqualTo(HttpStatusCode.ServiceUnavailable));
            Assert.That(await ready.Content.ReadAsStringAsync(), Is.EqualTo("Unhealthy"));
            Assert.That(ready.Content.Headers.ContentType?.MediaType, Is.EqualTo("text/plain"));
            var readiness = capture.Entries.Last();
            Assert.That(readiness.Field("Status"), Is.EqualTo(503));
            Assert.That(readiness.Field("Classification"), Is.EqualTo("readiness-unavailable"));
            Assert.That(readiness.Field("Route"), Is.EqualTo("/health/ready"));
            Assert.That(readiness.Field("TraceId"), Is.EqualTo(ready.Headers.GetValues("X-Trace-Id").Single()));
            using var live = await client.GetAsync("/health/live");
            Assert.That(live.StatusCode, Is.EqualTo(HttpStatusCode.OK));
            Assert.That(await live.Content.ReadAsStringAsync(), Is.EqualTo("Healthy"));
            Assert.That(live.Headers.Contains("X-Trace-Id"), Is.False);
        }
        finally
        {
            await DatabaseFixture.Execute("ALTER TABLE \"MissingDiagnosticEntries\" RENAME TO \"DailyEntries\"");
        }
        using var unexpected = await client.GetAsync($"/api/failure-probe/{habitId}?private-unexpected-query=1");
        Assert.That(unexpected.StatusCode, Is.EqualTo(HttpStatusCode.InternalServerError));
        Assert.That(unexpected.Headers.CacheControl?.ToString(), Does.Contain("no-store"));
        Assert.That(unexpected.Content.Headers.ContentType?.MediaType, Is.EqualTo("application/problem+json"));
        var unexpectedProblem = await unexpected.Content.ReadFromJsonAsync<JsonElement>();
        Assert.That(unexpectedProblem.GetProperty("title").GetString(), Is.EqualTo("An error occurred while processing your request."));
        Assert.That(unexpectedProblem.TryGetProperty("detail", out _), Is.False);
        var unexpectedEvent = capture.Entries.Last();
        Assert.That(unexpectedEvent.Field("Status"), Is.EqualTo(500));
        Assert.That(unexpectedEvent.Field("Classification"), Is.EqualTo("unexpected"));
        Assert.That(unexpectedEvent.Field("Route"), Is.EqualTo("/api/failure-probe/{id:guid}"));
        Assert.That(unexpectedEvent.Field("TraceId"), Is.EqualTo(unexpectedProblem.GetProperty("traceId").GetString()));
        using var badRequest = await client.GetAsync("/api/entries?date=invalid");
        Assert.That(badRequest.StatusCode, Is.EqualTo(HttpStatusCode.BadRequest));
        using var missing = await client.GetAsync($"/api/habits/{Guid.NewGuid()}");
        Assert.That(missing.StatusCode, Is.EqualTo(HttpStatusCode.NotFound));
        using var anonymous = capturedApp.CreateClient();
        using var unauthorized = await anonymous.GetAsync("/api/habits");
        Assert.That(unauthorized.StatusCode, Is.EqualTo(HttpStatusCode.Unauthorized));
        Assert.That((await unauthorized.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("title").GetString(), Is.EqualTo("Sign in to continue."));
        Assert.That(capture.Entries.Count, Is.EqualTo(3));
        capture.AssertPrivate(token, "private-owner-diagnostics", "private-habit-diagnostics", "private-good-diagnostics",
            habitId.ToString(), "2026-01-04", "private-query-diagnostics", "private-probe-query", "test-owned entry failure",
            "MissingDiagnosticEntries", "private-unexpected-diagnostics", "private-unexpected-query", "InvalidOperationException",
            "DbUpdateException", "PostgresException", DatabaseFixture.Database.GetConnectionString());
    }
}
