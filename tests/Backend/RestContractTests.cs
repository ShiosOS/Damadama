using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Damadama.Protocol;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;
using NUnit.Framework;

namespace Damadama.Tests;

public class RestContractTests
{
    private static readonly Dictionary<string, string[]> ExpectedMethods = new(StringComparer.Ordinal)
    {
        ["application-config"] = ["GET", "HEAD"],
        ["application-profile"] = ["GET", "HEAD"],
        ["list-habits"] = ["GET", "HEAD"],
        ["create-habit"] = ["POST"],
        ["read-habit"] = ["GET", "HEAD"],
        ["scheduled-habits"] = ["GET", "HEAD"],
        ["entries-by-date"] = ["GET", "HEAD"],
        ["read-entry"] = ["GET", "HEAD"],
        ["replace-entry"] = ["PUT"],
        ["options-application-config"] = ["OPTIONS"],
        ["options-application-profile"] = ["OPTIONS"],
        ["options-list-habits"] = ["OPTIONS"],
        ["options-read-habit"] = ["OPTIONS"],
        ["options-scheduled-habits"] = ["OPTIONS"],
        ["options-entries-by-date"] = ["OPTIONS"],
        ["options-read-entry"] = ["OPTIONS"]
    };
    private TestApp app = null!;
    private HttpClient client = null!;
    private readonly HashSet<string> visited = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (HttpMethod Method, Uri Uri)> privateRequests = new(StringComparer.Ordinal);

    [SetUp]
    public async Task Start()
    {
        app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        client = app.SignedIn();
        client.DefaultRequestHeaders.Accept.Add(new(RestContractAssertions.Siren));
        visited.Clear();
        privateRequests.Clear();
        await DatabaseFixture.Reset();
    }

    [TearDown]
    public void Stop()
    {
        client.Dispose();
        app.Dispose();
    }

    [Test]
    public void Every_running_API_endpoint_has_an_independently_tested_method_and_authorization_contract()
    {
        var endpoints = app.Services.GetRequiredService<EndpointDataSource>().Endpoints;
        Assert.That(RestContractAssertions.Inventory(endpoints, ExpectedMethods.Keys.ToHashSet()), Is.Empty);
        foreach (var endpoint in endpoints.OfType<RouteEndpoint>())
        {
            var name = endpoint.Metadata.GetMetadata<IEndpointNameMetadata>()?.EndpointName;
            if (name is null || !ExpectedMethods.TryGetValue(name, out var expected)) continue;
            Assert.That(endpoint.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods, Is.EquivalentTo(expected), name);
            var resourceName = name.StartsWith("options-", StringComparison.Ordinal) ? name["options-".Length..] : name;
            var isPrivate = resourceName is "list-habits" or "create-habit" or "read-habit" or "scheduled-habits" or
                "entries-by-date" or "read-entry" or "replace-entry";
            Assert.That(endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>().Count > 0, Is.EqualTo(isPrivate), name);
            if (isPrivate) Assert.That(endpoint.Metadata.GetMetadata<IAllowAnonymous>(), Is.Null, name);
        }
    }

    [Test]
    public async Task A_client_can_complete_every_transition_by_following_advertised_links_and_actions()
    {
        var bootstrap = await Get("application-config", "/api/config");
        var profile = await Get("application-profile", RequiredLink(bootstrap.Body, "profile"));
        Assert.That(profile.Body.GetProperty("class").EnumerateArray().Select(value => value.GetString()), Does.Contain("profile"));

        var created = await Act("create-habit", bootstrap.Body, "create-habit", HabitTests.Walking with
        { Weekdays = [1, 2, 3, 4, 5, 6, 7], RepeatEveryWeeks = 1 });
        Assert.That(RestContractAssertions.Resource(created, 201, created: true), Is.Empty);
        var habit = created.Body.GetProperty("properties");
        var habitUri = RequiredLink(created.Body, "self");
        var listUri = RequiredLink(bootstrap.Body, "https://github.com/ShiosOS/Damadama/rels/habits");
        var list = await Get("list-habits", listUri);
        Assert.That(list.Body.GetProperty("entities").GetArrayLength(), Is.EqualTo(1));
        var single = await Get("read-habit", habitUri);
        Assert.That(single.Body.GetProperty("properties").GetProperty("id").GetGuid(), Is.EqualTo(habit.GetProperty("id").GetGuid()));

        var scheduledRequest = Form(bootstrap.Body, "scheduled-habits", new { date = "2026-01-04" });
        var scheduledUri = scheduledRequest.RequestUri!.ToString();
        var scheduled = await Send("scheduled-habits", scheduledRequest);
        Assert.That(RestContractAssertions.Resource(scheduled, 200), Is.Empty);
        var scheduledHabit = scheduled.Body.GetProperty("entities")[0];
        var candidate = new { result = "Good", editedAt = "2026-01-05T00:00:00Z", deviceToday = "2026-01-05", timeZone = "Asia/Tokyo" };
        var first = await Act("replace-entry", scheduledHabit, "replace-entry", candidate);
        Assert.That(RestContractAssertions.Resource(first, 201, created: true), Is.Empty);
        var entryUri = RequiredLink(first.Body, "self");
        Assert.That(first.Body.GetProperty("properties").GetProperty("result").GetString(), Is.EqualTo("Good"));

        var replay = await Act("replace-entry", first.Body, "replace-entry", candidate);
        Assert.That(RestContractAssertions.Resource(replay, 200, entryUri), Is.Empty);
        Assert.That(JsonElement.DeepEquals(replay.Body.GetProperty("properties"), first.Body.GetProperty("properties")), Is.True);
        var afterReplay = await Get("read-entry", entryUri);
        Assert.That(JsonElement.DeepEquals(afterReplay.Body.GetProperty("properties"), first.Body.GetProperty("properties")), Is.True);
        Assert.That(await DatabaseFixture.Count("DailyEntries"), Is.EqualTo(1));
        var newer = await Act("replace-entry", replay.Body, "replace-entry", candidate with
        { result = "Best", editedAt = "2026-01-05T00:00:10Z" });
        Assert.That(RestContractAssertions.Resource(newer, 200, entryUri), Is.Empty);
        var lost = await Act("replace-entry", newer.Body, "replace-entry", candidate);
        Assert.That(RestContractAssertions.Conflict(lost), Is.Empty);
        Assert.That(lost.Body.GetProperty("current").GetProperty("properties").GetProperty("result").GetString(), Is.EqualTo("Best"));

        var cleared = await Act("replace-entry", lost.Body.GetProperty("current"), "replace-entry", candidate with
        { result = "Clear", editedAt = "2026-01-05T00:00:20Z" });
        Assert.That(RestContractAssertions.Resource(cleared, 200, entryUri), Is.Empty);
        var stale = await Act("replace-entry", cleared.Body, "replace-entry", candidate);
        Assert.That(RestContractAssertions.Conflict(stale), Is.Empty);
        Assert.That(stale.Body.GetProperty("current").GetProperty("properties").GetProperty("result").GetString(), Is.EqualTo("Clear"));
        var canonical = await Get("read-entry", entryUri);
        Assert.That(canonical.Body.GetProperty("properties").GetProperty("result").GetString(), Is.EqualTo("Clear"));

        var entriesRequest = Form(bootstrap.Body, "entries-by-date", new { date = "2026-01-04" });
        var entriesUri = entriesRequest.RequestUri!.ToString();
        var entries = await Send("entries-by-date", entriesRequest);
        Assert.That(RestContractAssertions.Resource(entries, 200), Is.Empty);
        Assert.That(RequiredLink(entries.Body.GetProperty("entities")[0], "self"), Is.EqualTo(entryUri));
        await DatabaseFixture.Execute($"UPDATE \"InitialSchedules\" SET \"Weekdays\" = ARRAY[3] WHERE \"HabitId\" = '{habit.GetProperty("id").GetGuid()}'");
        var retained = await Get("entries-by-date", entriesUri);
        var retainedEntry = retained.Body.GetProperty("entities")[0];
        var editedHistory = await Act("replace-entry", retainedEntry, "replace-entry", candidate with
        { result = "Rest", editedAt = "2026-01-05T00:00:30Z" });
        Assert.That(RestContractAssertions.Resource(editedHistory, 200, entryUri), Is.Empty);
        Assert.That(editedHistory.Body.GetProperty("properties").GetProperty("good").GetString(), Is.EqualTo("5 minutes"));
        var noSchedule = await Get("scheduled-habits", scheduledUri);
        Assert.That(noSchedule.Body.GetProperty("entities").GetArrayLength(), Is.Zero);

        await ProbeMethods("application-config", "/api/config", "GET", "HEAD", "OPTIONS");
        await ProbeMethods("application-profile", RequiredLink(profile.Body, "self"), "GET", "HEAD", "OPTIONS");
        await ProbeMethods("list-habits", listUri, "GET", "HEAD", "POST", "OPTIONS");
        await ProbeMethods("read-habit", habitUri, "GET", "HEAD", "OPTIONS");
        await ProbeMethods("scheduled-habits", scheduledUri, "GET", "HEAD", "OPTIONS");
        await ProbeMethods("entries-by-date", entriesUri, "GET", "HEAD", "OPTIONS");
        await ProbeMethods("read-entry", entryUri, "GET", "HEAD", "PUT", "OPTIONS");
        Assert.That(visited, Is.EquivalentTo(ExpectedMethods.Keys), "A registered endpoint requires a completed behavioral probe.");

        using var other = app.SignedIn("rest-other-owner");
        foreach (var uri in new[] { habitUri, entryUri })
        {
            using var refused = await other.GetAsync(uri);
            Assert.That(RestContractAssertions.Problem(await RestContractAssertions.Read(refused), 404), Is.Empty);
        }
        using var anonymous = app.CreateClient();
        foreach (var (name, sample) in privateRequests)
        {
            using var request = new HttpRequestMessage(sample.Method, sample.Uri);
            if (sample.Method == HttpMethod.Post || sample.Method == HttpMethod.Put) request.Content = JsonContent.Create(new { });
            using var signedOut = await anonymous.SendAsync(request);
            Assert.That(signedOut.Headers.WwwAuthenticate.Select(value => value.Scheme), Does.Contain("Bearer"), name);
            Assert.That(RestContractAssertions.Problem(await RestContractAssertions.Read(signedOut), 401), Is.Empty, name);
        }

        using var freshApp = new TestApp(DatabaseFixture.Database.GetConnectionString());
        using var freshClient = freshApp.SignedIn();
        using var afterRestart = await freshClient.GetAsync(entryUri);
        var durable = await RestContractAssertions.Read(afterRestart);
        Assert.That(RestContractAssertions.Resource(durable, 200, entryUri), Is.Empty);
        Assert.That(durable.Body.GetProperty("properties").GetProperty("result").GetString(), Is.EqualTo("Rest"));
    }

    [TestCase("text/html")]
    [TestCase("application/json")]
    [TestCase("application/vnd.siren+json;q=0, */*;q=1")]
    public async Task Unsupported_or_explicitly_excluded_success_media_is_not_silently_returned(string accept)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/config");
        request.Headers.Accept.ParseAdd(accept);
        using var response = await client.SendAsync(request);
        Assert.That(RestContractAssertions.Problem(await RestContractAssertions.Read(response), 406), Is.Empty);
    }

    [TestCase("*/*")]
    [TestCase("application/*")]
    [TestCase("text/html;q=1, application/vnd.siren+json;q=0.5")]
    public async Task Supported_wildcards_and_quality_preferences_receive_the_resource(string accept)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/config");
        request.Headers.Accept.ParseAdd(accept);
        using var response = await client.SendAsync(request);
        Assert.That(RestContractAssertions.Resource(await RestContractAssertions.Read(response), 200), Is.Empty);
    }

    [Test]
    public async Task Unsupported_write_media_and_unknown_routes_have_self_descriptive_problems()
    {
        var bootstrap = await Get("application-config", "/api/config");
        using var request = Form(bootstrap.Body, "create-habit", HabitTests.Walking);
        request.Content = new StringContent("<habit/>", Encoding.UTF8, "application/xml");
        using var response = await client.SendAsync(request);
        Assert.That(RestContractAssertions.Problem(await RestContractAssertions.Read(response), 415), Is.Empty);
        Assert.That(await DatabaseFixture.Count("Habits"), Is.Zero);
        using var missing = await client.GetAsync("/api/a-resource-that-does-not-exist");
        Assert.That(RestContractAssertions.Problem(await RestContractAssertions.Read(missing), 404), Is.Empty);
        using var invalidId = await client.GetAsync("/api/habits/not-a-guid");
        Assert.That(RestContractAssertions.Problem(await RestContractAssertions.Read(invalidId), 404), Is.Empty);
        using var head = await client.SendAsync(new(HttpMethod.Head, "/api/a-resource-that-does-not-exist"));
        Assert.That((int)head.StatusCode, Is.EqualTo(404));
        Assert.That(await head.Content.ReadAsByteArrayAsync(), Is.Empty);
    }

    private async Task ProbeMethods(string name, string uri, params string[] allowed)
    {
        var head = await Send(name, new(HttpMethod.Head, uri));
        Assert.That(head.Status, Is.EqualTo(200), name);
        Assert.That(head.MediaType, Is.EqualTo(RestContractAssertions.Siren), name);
        Assert.That(head.Content, Is.Empty, name);
        Assert.That(RestContractAssertions.CachePolicy(head), Is.Empty, name);
        var options = await Send($"options-{name}", new(HttpMethod.Options, uri));
        Assert.That(options.Status, Is.AnyOf(200, 204), name);
        Assert.That(options.Allow, Is.EquivalentTo(allowed), name);
        Assert.That(RestContractAssertions.CachePolicy(options), Is.Empty, name);
        using var wrong = await client.SendAsync(new(HttpMethod.Delete, uri));
        Assert.That(RestContractAssertions.MethodNotAllowed(await RestContractAssertions.Read(wrong), allowed), Is.Empty, name);
    }

    private async Task<RestObservation> Get(string name, string uri)
    {
        var result = await Send(name, new(HttpMethod.Get, uri));
        Assert.That(RestContractAssertions.Resource(result, 200, new Uri(client.BaseAddress!, uri).PathAndQuery), Is.Empty, name);
        return result;
    }

    private Task<RestObservation> Act(string endpoint, JsonElement entity, string action, object input) =>
        Send(endpoint, Form(entity, action, input));

    private async Task<RestObservation> Send(string name, HttpRequestMessage request)
    {
        using (request)
        using (var response = await client.SendAsync(request))
        {
            var uri = response.RequestMessage!.RequestUri!;
            var parser = app.Services.GetRequiredService<LinkParser>();
            Assert.That(parser.ParsePathByEndpointName(name, uri.AbsolutePath), Is.Not.Null, $"The request must actually visit {name}.");
            Assert.That(ExpectedMethods[name], Does.Contain(request.Method.Method));
            visited.Add(name);
            var observation = await RestContractAssertions.Read(response);
            if (request.Method != HttpMethod.Head && request.Method != HttpMethod.Options)
            {
                if (name is not ("application-config" or "application-profile")) privateRequests[name] = (request.Method, uri);
                var expectedClass = name switch
                {
                    "application-config" => "application",
                    "application-profile" => "profile",
                    "list-habits" => "habits",
                    "create-habit" or "read-habit" => "habit",
                    "scheduled-habits" => "scheduled-habits",
                    "entries-by-date" => "entries",
                    "replace-entry" or "read-entry" => "entry",
                    _ => throw new InvalidOperationException($"Missing representation contract for {name}.")
                };
                if (observation.Status < 300)
                    Assert.That(RestContractAssertions.Resource(observation, observation.Status, expectedClass: expectedClass), Is.Empty, name);
            }
            return observation;
        }
    }

    private static string RequiredLink(JsonElement entity, string relation) =>
        RestContractAssertions.Link(entity, relation) ?? throw new InvalidDataException($"Missing {relation} link.");

    private static HttpRequestMessage Form(JsonElement entity, string name, object input)
    {
        var action = entity.GetProperty("actions").EnumerateArray().Single(value => value.GetProperty("name").GetString() == name);
        var method = new HttpMethod(action.GetProperty("method").GetString()!);
        var uri = action.GetProperty("href").GetString()!;
        var properties = JsonSerializer.SerializeToElement(input, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        var advertised = action.GetProperty("fields").EnumerateArray().Select(field => field.GetProperty("name").GetString()!).ToArray();
        Assert.That(properties.EnumerateObject().Select(property => property.Name), Is.EquivalentTo(advertised));
        if (method == HttpMethod.Get)
        {
            Assert.That(action.GetProperty("type").GetString(), Is.EqualTo("application/x-www-form-urlencoded"));
            uri = QueryHelpers.AddQueryString(uri, properties.EnumerateObject().ToDictionary(property => property.Name,
                property => property.Value.GetString()));
            return new(method, uri);
        }
        Assert.That(action.GetProperty("type").GetString(), Is.EqualTo("application/json"));
        return new(method, uri) { Content = JsonContent.Create(input, options: new(JsonSerializerDefaults.Web)) };
    }
}
