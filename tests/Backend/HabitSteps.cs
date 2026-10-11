using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Damadama.Habits;
using NUnit.Framework;
using Npgsql;
using Reqnroll;

namespace Damadama.Tests;

[Binding]
public sealed class HabitSteps
{
    private TestApp app = null!;
    private HttpClient client = null!;
    private HttpResponseMessage response = null!;
    private JsonElement saved;
    private HttpResponseMessage? otherList;
    private HttpResponseMessage? otherRead;
    private readonly List<HttpResponseMessage> signedOutResponses = [];

    [Given("an account has a valid signed token")]
    public async Task SignedIn()
    {
        app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        client = app.SignedIn();
        await DatabaseFixture.Reset();
    }

    [When("the account creates Walking with its definitions and Monday and Wednesday every two weeks")]
    public async Task Create() => response = await client.PostAsJsonAsync("/api/habits", HabitTests.Walking);

    [Then("the server returns the saved definitions and device calendar schedule")]
    public async Task Saved()
    {
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.Created));
        saved = await response.Content.ReadFromJsonAsync<JsonElement>();
        AssertSaved(saved);
    }

    public static void AssertSaved(JsonElement habit)
    {
        Assert.Multiple(() =>
        {
            Assert.That(habit.GetProperty("name").GetString(), Is.EqualTo("Walking"));
            Assert.That(habit.GetProperty("good").GetString(), Is.EqualTo("5 minutes"));
            Assert.That(habit.GetProperty("better").GetString(), Is.EqualTo("15 minutes"));
            Assert.That(habit.GetProperty("best").GetString(), Is.EqualTo("30 minutes"));
            var schedule = habit.GetProperty("schedule");
            Assert.That(schedule.GetProperty("weekdays").EnumerateArray().Select(x => x.GetInt32()), Is.EqualTo(new[] { 1, 3 }));
            Assert.That(schedule.GetProperty("repeatEveryWeeks").GetInt32(), Is.EqualTo(2));
            Assert.That(schedule.GetProperty("timeZone").GetString(), Is.EqualTo("America/New_York"));
            Assert.That(schedule.GetProperty("creationDate").GetString(), Is.EqualTo("2026-01-04"));
            Assert.That(schedule.GetProperty("firstWeekMonday").GetString(), Is.EqualTo("2025-12-29"));
        });
    }

    [Then("both records are visible through an independent PostgreSQL connection")]
    public async Task Committed()
    {
        await using var connection = new NpgsqlConnection(DatabaseFixture.Database.GetConnectionString());
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand("""
            SELECT h."Name", h."Good", h."Better", h."Best", s."Weekdays", s."RepeatEveryWeeks",
                   s."CreationDate", s."FirstWeekMonday", s."TimeZone", h."OwnerId"
            FROM "Habits" h JOIN "InitialSchedules" s ON h."Id" = s."HabitId" WHERE h."Id" = @id
            """, connection);
        command.Parameters.AddWithValue("id", saved.GetProperty("id").GetGuid());
        await using var row = await command.ExecuteReaderAsync();
        Assert.That(await row.ReadAsync(), Is.True, "POST must acknowledge an already committed row.");
        Assert.Multiple(() =>
        {
            Assert.That(row.GetString(0), Is.EqualTo("Walking"));
            Assert.That(row.GetString(1), Is.EqualTo("5 minutes"));
            Assert.That(row.GetString(2), Is.EqualTo("15 minutes"));
            Assert.That(row.GetString(3), Is.EqualTo("30 minutes"));
            Assert.That(row.GetFieldValue<int[]>(4), Is.EqualTo(new[] { 1, 3 }));
            Assert.That(row.GetInt32(5), Is.EqualTo(2));
            Assert.That(row.GetFieldValue<DateOnly>(6), Is.EqualTo(new DateOnly(2026, 1, 4)));
            Assert.That(row.GetFieldValue<DateOnly>(7), Is.EqualTo(new DateOnly(2025, 12, 29)));
            Assert.That(row.GetString(8), Is.EqualTo("America/New_York"));
            Assert.That(row.GetString(9), Is.EqualTo("owner"));
        });
    }

    [When("the application restarts against the same database")]
    public void Restart()
    {
        client.Dispose();
        app.Dispose();
        app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        client = app.SignedIn();
    }

    [Then("the owner can list and open the saved habit with all values")]
    public async Task OwnerCanRead()
    {
        using var listResponse = await client.GetAsync("/api/habits");
        Assert.That(listResponse.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        var list = await listResponse.Content.ReadFromJsonAsync<JsonElement>();
        Assert.That(list.GetArrayLength(), Is.EqualTo(1));
        AssertSaved(list[0]);
        using var readResponse = await client.GetAsync($"/api/habits/{saved.GetProperty("id").GetGuid()}");
        Assert.That(readResponse.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        AssertSaved(await readResponse.Content.ReadFromJsonAsync<JsonElement>());
    }

    [When("another account lists and opens that known habit")]
    public async Task OtherAccount()
    {
        using var other = app.SignedIn("another-account");
        otherList = await other.GetAsync("/api/habits");
        otherRead = await other.GetAsync($"/api/habits/{saved.GetProperty("id").GetGuid()}");
    }

    [Then("the other account receives an empty list and not found")]
    public async Task RefusesOther()
    {
        Assert.That(otherList!.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        var list = await otherList.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Multiple(() =>
        {
            Assert.That(list.GetArrayLength(), Is.Zero);
            Assert.That(otherRead!.StatusCode, Is.EqualTo(HttpStatusCode.NotFound));
        });
    }

    [When("a signed-out browser creates lists or opens that habit")]
    public async Task SignedOutRequests()
    {
        using var signedOut = app.CreateClient();
        signedOutResponses.Add(await signedOut.PostAsJsonAsync("/api/habits", HabitTests.Walking));
        signedOutResponses.Add(await signedOut.GetAsync("/api/habits"));
        signedOutResponses.Add(await signedOut.GetAsync($"/api/habits/{saved.GetProperty("id").GetGuid()}"));
    }

    [Then("every request is refused with a sign-in error")]
    public async Task RefusedSignIn()
    {
        foreach (var refusal in signedOutResponses)
        {
            Assert.That(refusal.StatusCode, Is.EqualTo(HttpStatusCode.Unauthorized));
            Assert.That(refusal.Content.Headers.ContentType?.MediaType, Is.EqualTo("application/problem+json"));
            var problem = await refusal.Content.ReadFromJsonAsync<JsonElement>();
            Assert.That(problem.GetProperty("title").GetString(), Is.EqualTo("Sign in to continue."));
            Assert.That(problem.GetProperty("traceId").GetString(), Is.Not.Empty);
        }
    }

    [AfterScenario]
    public void Dispose()
    {
        response?.Dispose();
        otherList?.Dispose();
        otherRead?.Dispose();
        signedOutResponses.ForEach(r => r.Dispose());
        client?.Dispose();
        app?.Dispose();
    }
}
