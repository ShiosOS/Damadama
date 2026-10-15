using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Damadama.Habits;
using Npgsql;
using NUnit.Framework;
using Reqnroll;

namespace Damadama.Tests;

[Binding]
public sealed class DailyEntrySteps
{
    private TestApp app = null!;
    private HttpClient client = null!;
    private HttpResponseMessage response = null!;
    private Guid habitId;

    [Given("I own a daily habit created on January 4")]
    public Task DailyHabit() => Create([1, 2, 3, 4, 5, 6, 7]);

    [Given("I own a Wednesday habit created on January 4")]
    public Task WednesdayHabit() => Create([3]);

    private async Task Create(int[] weekdays)
    {
        app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        client = app.SignedIn();
        await DatabaseFixture.Reset();
        using var created = await client.PostAsJsonAsync("/api/habits", HabitTests.Walking with
        { Weekdays = weekdays, RepeatEveryWeeks = 1 });
        Assert.That(created.StatusCode, Is.EqualTo(HttpStatusCode.Created));
        habitId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    internal static object Change(string result = "Good", string editedAt = "2026-01-05T00:00:00.1234567Z") =>
        new { result, editedAt, deviceToday = "2026-01-05", timeZone = "Asia/Tokyo" };

    [When("I record Good for January 4 while my device is in Tokyo on January 5")]
    public Task SavePast() => Save("2026-01-04");

    [When("I record Good for {string} while my device is in Tokyo on January 5")]
    public async Task Save(string date) =>
        response = await client.PutAsJsonAsync($"/api/habits/{habitId}/entries/{date}", Change());

    [Then("Good is acknowledged with its original definitions after commit")]
    public async Task Committed()
    {
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        AssertEntry(await response.Content.ReadFromJsonAsync<JsonElement>());
        await using var connection = new NpgsqlConnection(DatabaseFixture.Database.GetConnectionString());
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand("""
            SELECT "Result", "CalendarDate", "EditedAtTicks", "Good", "Better", "Best"
            FROM "DailyEntries" WHERE "HabitId" = @id
            """, connection);
        command.Parameters.AddWithValue("id", habitId);
        await using var row = await command.ExecuteReaderAsync();
        Assert.That(await row.ReadAsync(), Is.True, "An acknowledgment requires a separately visible committed row.");
        Assert.Multiple(() =>
        {
            Assert.That(row.GetInt32(0), Is.EqualTo(2));
            Assert.That(row.GetFieldValue<DateOnly>(1), Is.EqualTo(new DateOnly(2026, 1, 4)));
            Assert.That(row.GetInt64(2), Is.EqualTo(DateTimeOffset.Parse("2026-01-05T00:00:00.1234567Z").UtcTicks));
            Assert.That(row.GetString(3), Is.EqualTo("5 minutes"));
            Assert.That(row.GetString(4), Is.EqualTo("15 minutes"));
            Assert.That(row.GetString(5), Is.EqualTo("30 minutes"));
        });
    }

    private void AssertEntry(JsonElement entry)
    {
        Assert.Multiple(() =>
        {
            Assert.That(entry.GetProperty("habitId").GetGuid(), Is.EqualTo(habitId));
            Assert.That(entry.GetProperty("calendarDate").GetString(), Is.EqualTo("2026-01-04"));
            Assert.That(entry.GetProperty("result").GetString(), Is.EqualTo("Good"));
            Assert.That(entry.GetProperty("editedAt").GetDateTimeOffset(), Is.EqualTo(DateTimeOffset.Parse("2026-01-05T00:00:00.1234567Z")));
            Assert.That(entry.GetProperty("good").GetString(), Is.EqualTo("5 minutes"));
            Assert.That(entry.GetProperty("better").GetString(), Is.EqualTo("15 minutes"));
            Assert.That(entry.GetProperty("best").GetString(), Is.EqualTo("30 minutes"));
        });
    }

    [Then("another account cannot read or replace that entry")]
    public async Task ForeignRefusal()
    {
        using var foreign = app.SignedIn("foreign-entry-account");
        using var read = await foreign.GetAsync("/api/entries?date=2026-01-04");
        Assert.That(read.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        Assert.That((await read.Content.ReadFromJsonAsync<JsonElement>()).GetArrayLength(), Is.Zero);
        using var write = await foreign.PutAsJsonAsync($"/api/habits/{habitId}/entries/2026-01-04", Change("Best"));
        Assert.That(write.StatusCode, Is.EqualTo(HttpStatusCode.NotFound));
        using var owner = await client.GetAsync("/api/entries?date=2026-01-04");
        AssertEntry((await owner.Content.ReadFromJsonAsync<JsonElement>())[0]);
    }

    [Then("a signed-out browser cannot read or replace that entry")]
    public async Task SignedOutRefusal()
    {
        using var signedOut = app.CreateClient();
        using var read = await signedOut.GetAsync("/api/entries?date=2026-01-04");
        using var write = await signedOut.PutAsJsonAsync($"/api/habits/{habitId}/entries/2026-01-04", Change("Rest"));
        Assert.Multiple(() =>
        {
            Assert.That(read.StatusCode, Is.EqualTo(HttpStatusCode.Unauthorized));
            Assert.That(write.StatusCode, Is.EqualTo(HttpStatusCode.Unauthorized));
        });
        using var owner = await client.GetAsync("/api/entries?date=2026-01-04");
        AssertEntry((await owner.Content.ReadFromJsonAsync<JsonElement>())[0]);
    }

    [Then("a fresh application reads Good for January 4")]
    public async Task FreshRead()
    {
        client.Dispose();
        app.Dispose();
        app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        client = app.SignedIn();
        using var read = await client.GetAsync("/api/entries?date=2026-01-04");
        Assert.That(read.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        var entries = await read.Content.ReadFromJsonAsync<JsonElement>();
        Assert.That(entries.GetArrayLength(), Is.EqualTo(1));
        AssertEntry(entries[0]);
    }

    [Then("the entry request is refused without storing a row")]
    public async Task NoEntry()
    {
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.BadRequest));
        Assert.That(await DatabaseFixture.Count("DailyEntries"), Is.Zero);
    }

    [AfterScenario]
    public void Dispose()
    {
        response?.Dispose();
        client?.Dispose();
        app?.Dispose();
    }
}
