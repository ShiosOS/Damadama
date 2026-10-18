using System.Net.Http.Json;
using System.Text.Json;
using Damadama.Protocol;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using NUnit.Framework;

namespace Damadama.Tests;

[TestFixture]
public class ApiContractTests
{
    internal static readonly ApiScenario[] Scenarios =
    [
        new("GET", "/api/config", "application-config", ResourceKind.Configuration, run => run.Configuration()),
        new("POST", "/api/habits", "create-habit", ResourceKind.Collection, run => run.CreateHabit()),
        new("GET", "/api/habits", "list-habits", ResourceKind.Collection, run => run.ListHabits()),
        new("GET", "/api/habits/{id}", "read-habit", ResourceKind.Member, run => run.ReadHabit()),
        new("PUT", "/api/habits/{id}/entries/{date}", "replace-entry", ResourceKind.Member, run => run.SaveEntry()),
        new("GET", "/api/habits/{id}/entries/{date}", "read-entry", ResourceKind.Member, run => run.ReadEntry()),
        new("GET", "/api/entries", "entries-by-date", ResourceKind.Collection, run => run.ListEntries())
    ];

    [Test]
    public async Task Generated_contract_matches_every_real_endpoint_and_exercised_operation()
    {
        using var app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        using var client = app.SignedIn();
        await DatabaseFixture.Reset();
        var document = await client.GetFromJsonAsync<JsonElement>("/openapi/v1.json");
        var artifacts = Path.Combine(RepositoryRoot(), ".audit", "api-contract");
        Directory.CreateDirectory(artifacts);
        await File.WriteAllTextAsync(Path.Combine(artifacts, "openapi.json"), document.GetRawText());
        Assert.That(document.GetProperty("openapi").GetString(), Does.StartWith("3.1."));
        Assert.That(ApiContractAssertions.Inventory(app.Services.GetRequiredService<EndpointDataSource>().Endpoints, document, Scenarios), Is.Empty);
        var run = new ContractRun(app, client);
        foreach (var scenario in Scenarios)
        {
            run.Scenario = scenario;
            await scenario.Exercise(run);
            await run.Anonymous();
        }
        Assert.That(run.Observations.Select(observed => $"{observed.Method.ToUpperInvariant()} {observed.Path}").Distinct(),
            Is.EquivalentTo(Scenarios.Select(scenario => scenario.Key)));
        var before = await ContractRun.Snapshot();
        foreach (var path in new[] { "/api/unknown", "/api/habits/scheduled", "/api/profile" })
        {
            using var unknown = await client.GetAsync(path);
            var observed = await ApiContractAssertions.Read(unknown, path, "GET");
            Assert.That(ApiContractAssertions.Response(observed, 404), Is.Empty);
        }
        using var unsupported = await client.DeleteAsync($"/api/habits/{run.HabitId}");
        Assert.That((int)unsupported.StatusCode, Is.EqualTo(405));
        Assert.That(unsupported.Content.Headers.Allow, Does.Contain("GET"));
        using var shell = await client.GetAsync("/habits");
        Assert.That(shell.Content.Headers.ContentType?.MediaType, Is.EqualTo("text/html"));
        ApiContractAssertions.Unchanged(before, await ContractRun.Snapshot());
        await File.WriteAllTextAsync(Path.Combine(artifacts, "responses.json"), JsonSerializer.Serialize(run.Observations, new JsonSerializerOptions(JsonSerializerDefaults.Web)));
    }

    [TestCase("/api/unclassified", false)]
    [TestCase("/unexpected-command", false)]
    [TestCase("/api/habits/{id:guid}/activate", false)]
    [TestCase("/api/hidden", true)]
    public async Task Actual_unclassified_and_hidden_routes_fail_admission(string path, bool hidden)
    {
        using var app = new TestApp(DatabaseFixture.Database.GetConnectionString(), endpoints =>
        {
            var endpoint = endpoints.MapGet(path, () => TypedResults.Ok(new { value = "unexpected" })).WithName("negative-route");
            if (hidden) endpoint.ExcludeFromDescription();
        });
        using var client = app.SignedIn();
        var document = await client.GetFromJsonAsync<JsonElement>("/openapi/v1.json");
        var failures = ApiContractAssertions.Inventory(app.Services.GetRequiredService<EndpointDataSource>().Endpoints, document, Scenarios);
        Assert.That(failures, Does.Contain($"endpoint.unclassified:GET {path.Replace("{id:guid}", "{id}")}"));
        if (hidden) Assert.That(failures, Does.Contain($"endpoint.hidden:{path}"));
    }

    [Test]
    public async Task An_actual_public_route_cannot_claim_private_contract_coverage()
    {
        using var app = new TestApp(DatabaseFixture.Database.GetConnectionString(), endpoints =>
            endpoints.MapGet("/api/probes", () => TypedResults.Ok(new { value = "public" })).WithName("private-probe"));
        using var client = app.CreateClient();
        using var probe = await client.GetAsync("/api/probes");
        Assert.That((int)probe.StatusCode, Is.EqualTo(200));
        var document = await client.GetFromJsonAsync<JsonElement>("/openapi/v1.json");
        ApiScenario[] scenarios = [.. Scenarios, new("GET", "/api/probes", "private-probe", ResourceKind.Collection, _ => Task.CompletedTask)];
        var failures = ApiContractAssertions.Inventory(app.Services.GetRequiredService<EndpointDataSource>().Endpoints, document, scenarios);
        Assert.That(failures, Does.Contain("endpoint.auth:GET /api/probes"));
        Assert.That(failures, Does.Contain("document.auth:GET /api/probes"));
    }

    [Test]
    public async Task Body_bound_GET_and_writing_GET_fail_real_guards()
    {
        using var app = new TestApp(DatabaseFixture.Database.GetConnectionString(), endpoints =>
        {
            endpoints.MapGet("/api/body-probes", ([Microsoft.AspNetCore.Mvc.FromBody] JsonElement body) => TypedResults.Ok(body)).WithName("body-probe");
            endpoints.MapGet("/api/write-probes", async () =>
            {
                await DatabaseFixture.Execute("UPDATE \"Habits\" SET \"Name\" = \"Name\"");
                return TypedResults.Ok(new { value = "written" });
            }).WithName("write-probe");
        });
        using var client = app.SignedIn();
        await DatabaseFixture.Reset();
        using var seed = await client.PostAsJsonAsync("/api/habits", HabitTests.Walking);
        seed.EnsureSuccessStatusCode();
        var document = await client.GetFromJsonAsync<JsonElement>("/openapi/v1.json");
        ApiScenario[] scenarios = [.. Scenarios, new("GET", "/api/body-probes", "body-probe", ResourceKind.Collection, _ => Task.CompletedTask)];
        Assert.That(ApiContractAssertions.Inventory(app.Services.GetRequiredService<EndpointDataSource>().Endpoints, document, scenarios),
            Does.Contain("document.get-body:GET /api/body-probes"));
        using var bodyRequest = new HttpRequestMessage(HttpMethod.Get, "/api/body-probes") { Content = JsonContent.Create(new { value = "body" }) };
        using var refusal = await client.SendAsync(bodyRequest);
        Assert.That((int)refusal.StatusCode, Is.EqualTo(400));
        var before = await ContractRun.Snapshot();
        using var written = await client.GetAsync("/api/write-probes");
        written.EnsureSuccessStatusCode();
        var after = await ContractRun.Snapshot();
        var failure = Assert.Throws<AssertionException>(() => ApiContractAssertions.Unchanged(before, after));
        Assert.That(failure!.Message, Does.Contain("get.persisted-state"));
    }

    [TestCase(200, "private, no-store", "response.status")]
    [TestCase(201, "private, no-store", "response.location")]
    [TestCase(201, "public", "response.cache")]
    public async Task Actual_bad_responses_fail_the_same_observation_guard(int status, string cache, string diagnostic)
    {
        using var app = new TestApp(DatabaseFixture.Database.GetConnectionString(), endpoints =>
            endpoints.MapGet("/response-probe", (HttpContext context) =>
            {
                context.Response.Headers.CacheControl = cache;
                return Results.Json(new { id = Guid.NewGuid() }, statusCode: status);
            }));
        using var client = app.CreateClient();
        using var response = await client.GetAsync("/response-probe");
        var observed = await ApiContractAssertions.Read(response, "/response-probe", "GET");
        Assert.That(ApiContractAssertions.Response(observed, 201, "/resource"), Does.Contain(diagnostic));
    }

    internal static string RepositoryRoot()
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "Damadama.slnx"))) root = root.Parent;
        return root?.FullName ?? throw new InvalidOperationException("Run contract tests inside the repository.");
    }
}

internal sealed class ContractRun(TestApp app, HttpClient client)
{
    internal ApiScenario Scenario { get; set; } = null!;
    internal Guid HabitId { get; private set; }
    internal List<ApiObservation> Observations { get; } = [];
    private string HabitPath => $"/api/habits/{HabitId}";
    private string EntryPath => $"{HabitPath}/entries/2026-01-04";

    internal async Task Configuration()
    {
        using var anonymous = app.CreateClient();
        await SafeRead("/api/config", requester: anonymous);
    }
    internal async Task CreateHabit()
    {
        using var response = await client.PostAsJsonAsync("/api/habits", HabitTests.Walking with { Weekdays = [1, 2, 3, 4, 5, 6, 7], RepeatEveryWeeks = 1 });
        var observed = await ApiContractAssertions.Read(response, Scenario.Path, Scenario.Method);
        HabitId = observed.Body.GetProperty("id").GetGuid();
        Record(observed, 201, HabitPath);
        using var invalid = await client.PostAsJsonAsync("/api/habits", new { });
        await Observe(invalid, 400);
        using var media = await client.PostAsync("/api/habits", new StringContent("{}"));
        await Observe(media, 415);
    }
    internal async Task ListHabits()
    {
        await SafeRead("/api/habits");
        await SafeRead("/api/habits?scheduledOn=2026-01-04");
        await SafeRead("/api/habits?scheduledOn=2026-01-03");
        await SafeRead("/api/habits?scheduledOn=invalid", 400);
        await SafeRead("/api/habits?scheduledOn=2026-01-04&scheduledOn=2026-01-04", 400);
        using var foreign = app.SignedIn("contract-foreign");
        await SafeRead("/api/habits", requester: foreign);
    }
    internal async Task ReadHabit()
    {
        await SafeRead(HabitPath);
        await SafeRead($"/api/habits/{Guid.NewGuid()}", 404);
        using var foreign = app.SignedIn("contract-foreign");
        await SafeRead(HabitPath, 404, foreign);
    }
    internal async Task SaveEntry()
    {
        using var first = await client.PutAsJsonAsync(EntryPath, EntrySteps.Change());
        var created = await Observe(first, 201, EntryPath);
        var beforeReplay = await Snapshot();
        using var replay = await client.PutAsJsonAsync(EntryPath, EntrySteps.Change());
        var exact = await Observe(replay, 200);
        Assert.That(exact.Body.GetRawText(), Is.EqualTo(created.Body.GetRawText()));
        ApiContractAssertions.Unchanged(beforeReplay, await Snapshot());
        using var winning = await client.PutAsJsonAsync(EntryPath, EntrySteps.Change("Best", "2026-01-05T00:01:00Z"));
        var winner = await Observe(winning, 200);
        var beforeLoser = await Snapshot();
        using var losing = await client.PutAsJsonAsync(EntryPath, EntrySteps.Change());
        var conflict = await Observe(losing, 409);
        Assert.That(conflict.Body.GetProperty("current").GetRawText(), Is.EqualTo(winner.Body.GetRawText()));
        ApiContractAssertions.Unchanged(beforeLoser, await Snapshot());
        using var clear = await client.PutAsJsonAsync(EntryPath, EntrySteps.Change("Clear", "2026-01-05T00:02:00Z"));
        await Observe(clear, 200);
        var beforeFailure = await Snapshot();
        await using (var failure = await EntryWriteFailure.Install(DatabaseFixture.Execute, EntryWriteOperation.Update, EntryFailureTiming.AtCommit))
        {
            using var failed = await client.PutAsJsonAsync(EntryPath, EntrySteps.Change("Good", "2026-01-05T00:03:00Z"));
            await Observe(failed, 503);
        }
        ApiContractAssertions.Unchanged(beforeFailure, await Snapshot());
        using var invalid = await client.PutAsJsonAsync(EntryPath, new { result = "unknown" });
        await Observe(invalid, 400);
        using var foreign = app.SignedIn("contract-foreign");
        using var refused = await foreign.PutAsJsonAsync(EntryPath, EntrySteps.Change());
        await Observe(refused, 404);
        using var media = await client.PutAsync(EntryPath, new StringContent("{}"));
        await Observe(media, 415);
    }
    internal async Task ReadEntry()
    {
        var retained = await SafeRead(EntryPath);
        Assert.That(retained.Body.GetProperty("result").GetString(), Is.EqualTo("Clear"));
        await SafeRead($"{HabitPath}/entries/2026-01-03", 404);
        await SafeRead($"{HabitPath}/entries/invalid", 400);
        using var foreign = app.SignedIn("contract-foreign");
        await SafeRead(EntryPath, 404, foreign);
    }
    internal async Task ListEntries()
    {
        var entries = await SafeRead("/api/entries?date=2026-01-04");
        Assert.That(entries.Body[0].GetProperty("result").GetString(), Is.EqualTo("Clear"));
        await SafeRead("/api/entries?date=2026-01-03");
        await SafeRead("/api/entries?date=invalid", 400);
        await SafeRead("/api/entries", 400);
        using var foreign = app.SignedIn("contract-foreign");
        await SafeRead("/api/entries?date=2026-01-04", requester: foreign);
    }
    internal async Task Anonymous()
    {
        if (!Scenario.Authorized) return;
        using var anonymous = app.CreateClient();
        var path = Scenario.Path.Replace("{id}", HabitId.ToString()).Replace("{date}", "2026-01-04");
        if (Scenario.Method == "GET") { await SafeRead(path, 401, anonymous); return; }
        using var request = new HttpRequestMessage(new HttpMethod(Scenario.Method), path)
        {
            Content = Scenario.Method == "POST" ? JsonContent.Create(HabitTests.Walking) : JsonContent.Create(EntrySteps.Change())
        };
        using var response = await anonymous.SendAsync(request);
        await Observe(response, 401);
    }
    private async Task<ApiObservation> SafeRead(string path, int status = 200, HttpClient? requester = null)
    {
        requester ??= client;
        var before = await Snapshot();
        using var response = await requester.GetAsync(path);
        var observed = await Observe(response, status);
        using var repeated = await requester.GetAsync(path);
        await Observe(repeated, status);
        using var body = new HttpRequestMessage(HttpMethod.Get, path) { Content = JsonContent.Create(new { value = "not-a-query" }) };
        using var refused = await requester.SendAsync(body);
        await Observe(refused, 400);
        ApiContractAssertions.Unchanged(before, await Snapshot());
        return observed;
    }
    private async Task<ApiObservation> Observe(HttpResponseMessage response, int status, string? location = null)
    {
        var observed = await ApiContractAssertions.Read(response, Scenario.Path, Scenario.Method);
        Record(observed, status, location);
        return observed;
    }
    private void Record(ApiObservation observed, int status, string? location)
    {
        Assert.That(ApiContractAssertions.Response(observed, status, location), Is.Empty, Scenario.Key);
        Observations.Add(observed);
    }
    internal static async Task<string> Snapshot()
    {
        await using var connection = new NpgsqlConnection(DatabaseFixture.Database.GetConnectionString());
        await connection.OpenAsync();
        var rows = new List<string>();
        foreach (var table in new[] { "Habits", "InitialSchedules", "DailyEntries" })
        {
            await using var command = new NpgsqlCommand($"""
                SELECT coalesce(jsonb_agg(row_data ORDER BY row_data::text), '[]')::text
                FROM (SELECT to_jsonb(t) || jsonb_build_object('_xmin', xmin::text) AS row_data FROM "{table}" t) snapshot_rows
                """, connection);
            rows.Add((string)(await command.ExecuteScalarAsync())!);
        }
        return string.Join("\n", rows);
    }
}
