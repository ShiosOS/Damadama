using Damadama.Tests;
using Microsoft.AspNetCore.Http;
using System.Text.Json;
using Damadama.Habits;
using Damadama.Entries;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using NUnit.Framework;

namespace Damadama.Protocol;

[TestFixture]
public class OpenApiGenerationTests
{
    [Test]
    public async Task Conflict_problem_preserves_the_typed_current_entry_on_the_wire()
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Services.AddApiContract();
        builder.Services.AddProblemDetails();
        builder.Services.AddSingleton<IStartupFilter>(new TestApp.AdditionalEndpoints(endpoints =>
            endpoints.MapGet("/api/extra-probe", () => TypedResults.Ok(new { value = "extra" }))));
        await using var app = builder.Build();
        app.UseRouting();
        app.UseApiProtocol();
        var entry = new EntryResponse(Guid.NewGuid(), "Walking", new DateOnly(2026, 1, 4), "Clear",
            DateTimeOffset.Parse("2026-01-05T00:00:00Z"), "5 minutes", "15 minutes", "30 minutes");
        app.MapPut("/api/conflict-probe", () => TypedResults.Problem(new EntryConflictProblem
        {
            Status = 409,
            Title = "A newer entry is saved.",
            Current = entry
        }));
        app.MapGet("/api/config", () => TypedResults.Ok(new ApplicationConfig("fixture")));
        app.MapFallbackToFile("index.html").WithName("application-shell");
        await app.StartAsync();
        using var client = app.GetTestClient();
        using var extra = await client.GetAsync("/api/extra-probe");
        Assert.That(ApiContractAssertions.Response(await ApiContractAssertions.Read(extra, "/api/extra-probe", "GET"), 200), Is.Empty);
        using var conflict = await client.PutAsync("/api/conflict-probe", null);
        var observed = await ApiContractAssertions.Read(conflict, "/api/conflict-probe", "PUT");
        Assert.That(ApiContractAssertions.Response(observed, 409), Is.Empty);
        Assert.That(observed.Body.GetProperty("current").GetProperty("habitId").GetGuid(), Is.EqualTo(entry.HabitId));
        Assert.That(observed.Body.GetProperty("current").GetProperty("result").GetString(), Is.EqualTo("Clear"));
        using var bodyRequest = new HttpRequestMessage(HttpMethod.Get, "/api/config") { Content = new StringContent("{}") };
        using var refused = await client.SendAsync(bodyRequest);
        Assert.That(ApiContractAssertions.Response(await ApiContractAssertions.Read(refused, "/api/config", "GET"), 400), Is.Empty);
        using var missing = await client.GetAsync("/api/unknown");
        Assert.That(ApiContractAssertions.Response(await ApiContractAssertions.Read(missing, "/api/unknown", "GET"), 404), Is.Empty);
    }

    [Test]
    public async Task Actual_endpoint_modules_generate_lintable_schema_without_database_IO()
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Services.AddApiContract();
        builder.Services.AddProblemDetails();
        builder.Services.AddAuthorization();
        builder.Services.AddAuthentication();
        builder.Services.AddSingleton(TimeProvider.System);
        builder.Services.AddDbContext<HabitsDb>(options => options.UseNpgsql("Host=unused.invalid;Database=unused;Username=unused"));
        builder.Services.AddScoped<HabitHistory>();
        await using var app = builder.Build();
        app.MapHabits();
        app.MapEntries();
        app.MapGet("/api/config", () => new ApplicationConfig("pk_test_fixture")).WithName("application-config").ProducesProblem(400);
        app.MapOpenApi().WithName("openapi-document");
        await app.StartAsync();
        using var client = app.GetTestClient();
        var json = await client.GetStringAsync("/openapi/v1.json");
        using var document = JsonDocument.Parse(json);
        Assert.That(document.RootElement.GetProperty("openapi").GetString(), Does.StartWith("3.1."));
        Assert.That(ApiContractAssertions.Inventory(app.Services.GetRequiredService<Microsoft.AspNetCore.Routing.EndpointDataSource>().Endpoints,
            document.RootElement, ApiContractTests.Scenarios), Is.Empty);
        var artifacts = Path.Combine(ApiContractTests.RepositoryRoot(), ".audit", "api-contract-smoke");
        Directory.CreateDirectory(artifacts);
        await File.WriteAllTextAsync(Path.Combine(artifacts, "openapi.json"), json);
        var process = new System.Diagnostics.ProcessStartInfo("node") { WorkingDirectory = ApiContractTests.RepositoryRoot(), RedirectStandardOutput = true, RedirectStandardError = true };
        process.ArgumentList.Add("scripts/api-contract.mjs");
        process.ArgumentList.Add("--smoke");
        using var child = System.Diagnostics.Process.Start(process)!;
        var output = child.StandardOutput.ReadToEndAsync();
        var error = child.StandardError.ReadToEndAsync();
        await child.WaitForExitAsync();
        Assert.That(child.ExitCode, Is.Zero, await output + await error);
    }
}
