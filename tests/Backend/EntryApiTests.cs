using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using NUnit.Framework;

namespace Damadama.Tests;

public class EntryApiTests
{
    private TestApp app = null!;
    private HttpClient client = null!;
    private Guid habitId;

    [SetUp]
    public async Task Start()
    {
        app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        client = app.SignedIn();
        await DatabaseFixture.Reset();
        using var created = await client.PostAsJsonAsync("/api/habits", HabitTests.Walking with
        { Weekdays = [1, 2, 3, 4, 5, 6, 7], RepeatEveryWeeks = 1 });
        habitId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private string Path(string date = "2026-01-04") => $"/api/habits/{habitId}/entries/{date}";

    [TestCase(false)]
    [TestCase(true)]
    public async Task Unknown_or_unowned_habits_are_not_found_before_field_validation(bool foreignOwner)
    {
        using var requester = app.SignedIn(foreignOwner ? "other-owner" : "owner");
        var requestedHabit = foreignOwner ? habitId : Guid.NewGuid();
        using var response = await requester.PutAsJsonAsync($"/api/habits/{requestedHabit}/entries/not-a-date", new
        { result = "Unknown", deviceToday = "invalid", timeZone = "unknown" });

        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.NotFound));
        Assert.That(await DatabaseFixture.Count("DailyEntries"), Is.Zero);
    }

    [TestCase("Clear")]
    [TestCase("Rest")]
    [TestCase("Good")]
    [TestCase("Better")]
    [TestCase("Best")]
    public async Task Accepts_each_distinct_outcome_for_device_today(string result)
    {
        using var response = await client.PutAsJsonAsync(Path(), new
        { result, editedAt = "2026-01-05T00:00:00Z", deviceToday = "2026-01-04", timeZone = "America/New_York" });
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        var saved = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.That(saved.GetProperty("result").GetString(), Is.EqualTo(result));
    }

    [TestCase(null)]
    [TestCase("")]
    [TestCase("Missed")]
    [TestCase("2")]
    [TestCase("good")]
    public async Task Rejects_unknown_or_missing_results(string? result)
    {
        using var response = await client.PutAsJsonAsync(Path(), new
        { result, editedAt = "2026-01-05T00:00:00Z", deviceToday = "2026-01-05", timeZone = "Asia/Tokyo" });
        await AssertRefused(response);
    }

    [TestCase("2026-01-06", "Asia/Tokyo")]
    [TestCase("2026-01-04", "Asia/Tokyo")]
    [TestCase("2026-01-05", "Not/AZone")]
    [TestCase("2026-01-05", "Eastern Standard Time")]
    [TestCase("2026-1-5", "Asia/Tokyo")]
    public async Task Validates_current_device_date_and_timezone_on_server(string today, string timeZone)
    {
        using var response = await client.PutAsJsonAsync(Path(), new
        { result = "Good", editedAt = "2026-01-05T00:00:00Z", deviceToday = today, timeZone });
        await AssertRefused(response);
    }

    [Test]
    public async Task Requires_an_edit_timestamp_and_ISO_calendar_date()
    {
        using var missing = await client.PutAsJsonAsync(Path(), new
        { result = "Good", deviceToday = "2026-01-05", timeZone = "Asia/Tokyo" });
        await AssertRefused(missing);
        using var date = await client.PutAsJsonAsync(Path("2026-1-4"), EntrySteps.Change());
        await AssertRefused(date);
    }

    private static async Task AssertRefused(HttpResponseMessage response)
    {
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.BadRequest));
        Assert.That(response.Content.Headers.ContentType?.MediaType, Is.EqualTo("application/problem+json"));
        Assert.That(await DatabaseFixture.Count("DailyEntries"), Is.Zero);
    }

    [Test]
    public async Task Retained_history_remains_editable_after_the_date_leaves_the_schedule()
    {
        using var first = await client.PutAsJsonAsync(Path(), EntrySteps.Change());
        Assert.That(first.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        await DatabaseFixture.Execute($"UPDATE \"InitialSchedules\" SET \"Weekdays\" = ARRAY[3] WHERE \"HabitId\" = '{habitId}'");
        using var changed = await client.PutAsJsonAsync(Path(), EntrySteps.Change("Better", "2026-01-05T00:01:00Z"));
        Assert.That(changed.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        var saved = await changed.Content.ReadFromJsonAsync<JsonElement>();
        Assert.That(saved.GetProperty("result").GetString(), Is.EqualTo("Better"));
        Assert.That(await DatabaseFixture.Count("DailyEntries"), Is.EqualTo(1));
        using var history = await client.GetAsync("/api/entries?date=2026-01-04");
        var retained = (await history.Content.ReadFromJsonAsync<JsonElement>())[0];
        var name = retained.TryGetProperty("habitName", out var property) ? property.GetString() : null;
        Assert.That(name, Is.EqualTo("Walking"), "Retained history needs its owned habit name even when the scheduled read omits it.");
    }

    [TestCase(false)]
    [TestCase(true)]
    public async Task A_failed_entry_insert_or_commit_cannot_acknowledge_a_save(bool atCommit)
    {
        await DatabaseFixture.Execute("""
            CREATE FUNCTION reject_entry_api() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'test-owned entry failure'; END; $$;
            """);
        await DatabaseFixture.Execute(atCommit
            ? "CREATE CONSTRAINT TRIGGER reject_entry_api AFTER INSERT ON \"DailyEntries\" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_entry_api()"
            : "CREATE TRIGGER reject_entry_api BEFORE INSERT ON \"DailyEntries\" FOR EACH ROW EXECUTE FUNCTION reject_entry_api()");
        try
        {
            using var failed = await client.PutAsJsonAsync(Path(), EntrySteps.Change());
            Assert.That(failed.StatusCode, Is.EqualTo(HttpStatusCode.ServiceUnavailable));
            var problem = await failed.Content.ReadFromJsonAsync<JsonElement>();
            Assert.That(problem.GetProperty("traceId").GetString(), Is.Not.Empty);
            Assert.That(await DatabaseFixture.Count("DailyEntries"), Is.Zero);
        }
        finally
        {
            await DatabaseFixture.Execute("DROP TRIGGER reject_entry_api ON \"DailyEntries\"; DROP FUNCTION reject_entry_api()");
        }
        using var retry = await client.PutAsJsonAsync(Path(), EntrySteps.Change());
        Assert.That(retry.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        Assert.That(await DatabaseFixture.Count("DailyEntries"), Is.EqualTo(1));
    }

    [Test]
    public async Task Readiness_requires_the_entry_schema()
    {
        using var ready = await client.GetAsync("/health/ready");
        Assert.That(ready.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        await DatabaseFixture.Execute("ALTER TABLE \"DailyEntries\" RENAME TO \"MissingEntries\"");
        try
        {
            using var unavailable = await client.GetAsync("/health/ready");
            Assert.That(unavailable.StatusCode, Is.EqualTo(HttpStatusCode.ServiceUnavailable));
            using var live = await client.GetAsync("/health/live");
            Assert.That(live.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        }
        finally
        {
            await DatabaseFixture.Execute("ALTER TABLE \"MissingEntries\" RENAME TO \"DailyEntries\"");
        }
    }

    [TearDown]
    public void Stop()
    {
        client.Dispose();
        app.Dispose();
    }
}
