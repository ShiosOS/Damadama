using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Damadama.Habits;
using Microsoft.Extensions.DependencyInjection;
using NUnit.Framework;

namespace Damadama.Tests;

public class ScheduledHabitsTests
{
    private TestApp app = null!;
    private HttpClient client = null!;

    [SetUp]
    public async Task SetUp()
    {
        app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        client = app.SignedIn();
        await DatabaseFixture.Reset();
    }

    [Test]
    public async Task Owner_receives_the_unchanged_habit_response_and_other_accounts_receive_no_habits()
    {
        var habit = await Save(HabitTests.Walking with { Weekdays = [1, 3, 7] });

        using var ownerResponse = await client.GetAsync("/api/habits?scheduledOn=2026-10-14");
        Assert.That(ownerResponse.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        var ownerList = await ownerResponse.Content.ReadFromJsonAsync<JsonElement>();
        Assert.That(ownerList.GetArrayLength(), Is.EqualTo(1));
        AssertWalking(ownerList[0], habit.Id);

        using var other = app.SignedIn("another-account");
        using var otherResponse = await other.GetAsync("/api/habits?scheduledOn=2026-10-14");
        Assert.That(otherResponse.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        var otherList = await otherResponse.Content.ReadFromJsonAsync<JsonElement>();
        Assert.That(otherList.GetArrayLength(), Is.Zero);
    }

    [Test]
    public async Task Repeated_reads_use_the_requested_calendar_date_and_preserve_stored_schedule_dates()
    {
        var habit = await Save(HabitTests.Walking with { Weekdays = [1, 3, 7] });

        foreach (var date in new[] { "2026-10-14", "2026-10-18", "2026-10-26", "2026-10-14" })
        {
            using var response = await client.GetAsync($"/api/habits?scheduledOn={date}");
            Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK));
            var list = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.That(list.GetArrayLength(), Is.EqualTo(1), date);
            AssertWalking(list[0], habit.Id);
        }

        foreach (var date in new[] { "2026-10-12", "2026-10-15", "2026-10-19", "2026-10-25" })
        {
            using var response = await client.GetAsync($"/api/habits?scheduledOn={date}");
            Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK));
            var list = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.That(list.GetArrayLength(), Is.Zero, date);
        }

        using var readResponse = await client.GetAsync($"/api/habits/{habit.Id}");
        Assert.That(readResponse.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        AssertWalking(await readResponse.Content.ReadFromJsonAsync<JsonElement>(), habit.Id);
    }

    [Test]
    public async Task Scheduled_habits_retain_creation_and_id_order_and_exclude_unscheduled_and_other_owners()
    {
        var later = await Save(HabitTests.Walking with { Name = "Later", Weekdays = [3], RepeatEveryWeeks = 1 },
            creationInstant: "2026-10-14T15:00:00Z");
        var firstTie = await Save(HabitTests.Walking with { Name = "First tie", Weekdays = [3], RepeatEveryWeeks = 1 });
        var secondTie = await Save(HabitTests.Walking with { Name = "Second tie", Weekdays = [3], RepeatEveryWeeks = 1 });
        await Save(HabitTests.Walking with { Name = "Thursday", Weekdays = [4], RepeatEveryWeeks = 1 });
        await Save(HabitTests.Walking with { Name = "Private", Weekdays = [3], RepeatEveryWeeks = 1 }, "another-account");

        using var response = await client.GetAsync("/api/habits?scheduledOn=2026-10-14");
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        var list = await response.Content.ReadFromJsonAsync<JsonElement>();
        var tiedIds = new[] { firstTie.Id, secondTie.Id }.Order().ToArray();
        Assert.That(list.EnumerateArray().Select(item => item.GetProperty("id").GetGuid()),
            Is.EqualTo(new[] { tiedIds[0], tiedIds[1], later.Id }));
    }


    [TestCase("?scheduledOn=")]
    [TestCase("?scheduledOn=%20")]
    [TestCase("?scheduledOn=2026-2-03")]
    [TestCase("?scheduledOn=10/14/2026")]
    [TestCase("?scheduledOn=2026-02-30")]
    [TestCase("?scheduledOn=2026-10-14T00:00:00Z")]
    [TestCase("?scheduledOn=%202026-10-14")]
    [TestCase("?scheduledOn=2026-10-14%20")]
    [TestCase("?scheduledOn=2026-10-14&scheduledOn=2026-10-14")]
    [TestCase("?scheduledOn=2026-10-14&scheduledOn=2026-10-18")]
    [TestCase("?scheduledOn=2026-10-14&scheduledOn=")]
    [TestCase("?scheduledOn=2026-10-14,2026-10-18")]
    public async Task Requires_exactly_one_valid_ISO_calendar_date(string query)
    {
        using var response = await client.GetAsync($"/api/habits{query}");

        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.BadRequest));
        Assert.That(response.Content.Headers.ContentType?.MediaType, Is.EqualTo("application/problem+json"));
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Multiple(() =>
        {
            Assert.That(problem.GetProperty("title").GetString(), Is.EqualTo("Check the requested date."));
            var errors = problem.GetProperty("errors");
            Assert.That(errors.EnumerateObject().Select(error => error.Name), Is.EqualTo(new[] { "scheduledOn" }));
            Assert.That(errors.GetProperty("scheduledOn")[0].GetString(),
                Is.EqualTo("Use one valid calendar date in YYYY-MM-DD format."));
            Assert.That(problem.GetProperty("traceId").GetString(), Is.Not.Empty);
        });
    }

    [Test]
    public async Task Signed_out_scheduled_read_is_refused_before_date_validation()
    {
        await Save(HabitTests.Walking with { Weekdays = [1, 3, 7] });
        using var ownerResponse = await client.GetAsync("/api/habits?scheduledOn=2026-10-14");
        var ownerList = await ownerResponse.Content.ReadFromJsonAsync<JsonElement>();
        Assert.That(ownerResponse.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        Assert.That(ownerList.GetArrayLength(), Is.EqualTo(1));

        using var signedOut = app.CreateClient();
        foreach (var query in new[] { "?scheduledOn=2026-10-14", "", "?scheduledOn=invalid" })
        {
            using var response = await signedOut.GetAsync($"/api/habits{query}");
            Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.Unauthorized));
            var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.That(problem.GetProperty("title").GetString(), Is.EqualTo("Sign in to continue."));
        }
    }

    private async Task<Habit> Save(CreateHabit input, string owner = "owner", string creationInstant = "2026-10-14T12:00:00Z")
    {
        var habit = Habit.Create(input, owner, DateTimeOffset.Parse(creationInstant));
        await using var scope = app.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<HabitsDb>();
        db.Habits.Add(habit);
        await db.SaveChangesAsync();
        return habit;
    }

    private static void AssertWalking(JsonElement habit, Guid expectedId)
    {
        Assert.Multiple(() =>
        {
            Assert.That(habit.EnumerateObject().Select(field => field.Name),
                Is.EquivalentTo(new[] { "id", "name", "good", "better", "best", "createdAt", "schedule" }));
            Assert.That(habit.GetProperty("id").GetGuid(), Is.EqualTo(expectedId));
            Assert.That(habit.GetProperty("name").GetString(), Is.EqualTo("Walking"));
            Assert.That(habit.GetProperty("good").GetString(), Is.EqualTo("5 minutes"));
            Assert.That(habit.GetProperty("better").GetString(), Is.EqualTo("15 minutes"));
            Assert.That(habit.GetProperty("best").GetString(), Is.EqualTo("30 minutes"));
            Assert.That(habit.GetProperty("createdAt").GetDateTimeOffset(),
                Is.EqualTo(DateTimeOffset.Parse("2026-10-14T12:00:00Z")));
            var schedule = habit.GetProperty("schedule");
            Assert.That(schedule.EnumerateObject().Select(field => field.Name),
                Is.EquivalentTo(new[] { "habitId", "weekdays", "repeatEveryWeeks", "timeZone", "creationDate", "firstWeekMonday" }));
            Assert.That(schedule.GetProperty("habitId").GetGuid(), Is.EqualTo(expectedId));
            Assert.That(schedule.GetProperty("weekdays").EnumerateArray().Select(day => day.GetInt32()), Is.EqualTo(new[] { 1, 3, 7 }));
            Assert.That(schedule.GetProperty("repeatEveryWeeks").GetInt32(), Is.EqualTo(2));
            Assert.That(schedule.GetProperty("timeZone").GetString(), Is.EqualTo("America/New_York"));
            Assert.That(schedule.GetProperty("creationDate").GetString(), Is.EqualTo("2026-10-14"));
            Assert.That(schedule.GetProperty("firstWeekMonday").GetString(), Is.EqualTo("2026-10-12"));
        });
    }

    [TearDown]
    public void Dispose()
    {
        client.Dispose();
        app.Dispose();
    }
}
