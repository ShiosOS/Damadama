using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Npgsql;
using NUnit.Framework;

namespace Damadama.Tests;

public class HabitCreationTests
{
    [Test]
    public async Task Creation_response_matches_the_committed_row_and_owner_read_with_submicrosecond_clock_ticks()
    {
        var instant = DateTimeOffset.Parse("2026-10-18T09:04:20.2198161Z");
        using var app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        using var timedApp = app.WithWebHostBuilder(builder => builder.ConfigureTestServices(services =>
            services.Replace(ServiceDescriptor.Singleton<TimeProvider>(new FixedTime(instant)))));
        using var client = timedApp.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", app.Token());
        await DatabaseFixture.Reset();

        using var created = await client.PostAsJsonAsync("/api/habits", HabitTests.Walking with
        {
            Name = " Walking ",
            Good = " 5 minutes ",
            Better = " 15 minutes ",
            Best = " 30 minutes ",
            Weekdays = [7, 1, 7, 3]
        });
        Assert.That(created.StatusCode, Is.EqualTo(HttpStatusCode.Created));
        var saved = await created.Content.ReadFromJsonAsync<JsonElement>();
        var id = saved.GetProperty("id").GetGuid();

        using var read = await client.GetAsync($"/api/habits/{id}");
        Assert.That(read.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        var reloaded = await read.Content.ReadFromJsonAsync<JsonElement>();

        await using var connection = new NpgsqlConnection(DatabaseFixture.Database.GetConnectionString());
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand("""
            SELECT h."CreatedAt", h."OwnerId", h."Name", h."Good", h."Better", h."Best",
                   s."Weekdays", s."RepeatEveryWeeks", s."TimeZone", s."CreationDate", s."FirstWeekMonday"
            FROM "Habits" h JOIN "InitialSchedules" s ON h."Id" = s."HabitId" WHERE h."Id" = @id
            """, connection);
        command.Parameters.AddWithValue("id", id);
        await using var row = await command.ExecuteReaderAsync();
        Assert.That(await row.ReadAsync(), Is.True, "The creation response must acknowledge a committed habit and schedule.");
        Assert.Multiple(() =>
        {
            Assert.That(saved.GetProperty("createdAt").GetDateTimeOffset(), Is.EqualTo(row.GetFieldValue<DateTimeOffset>(0)),
                "POST must return the creation timestamp that PostgreSQL actually stored.");
            Assert.That(reloaded.GetProperty("createdAt").GetDateTimeOffset(), Is.EqualTo(row.GetFieldValue<DateTimeOffset>(0)));
            Assert.That(JsonElement.DeepEquals(saved, reloaded), Is.True,
                "The owner must read the same representation that POST acknowledged.");
            Assert.That(created.Headers.Location?.OriginalString, Is.EqualTo($"/api/habits/{id}"));
            Assert.That(saved.GetProperty("name").GetString(), Is.EqualTo(" Walking "));
            Assert.That(saved.GetProperty("good").GetString(), Is.EqualTo(" 5 minutes "));
            Assert.That(saved.GetProperty("better").GetString(), Is.EqualTo(" 15 minutes "));
            Assert.That(saved.GetProperty("best").GetString(), Is.EqualTo(" 30 minutes "));
            var schedule = saved.GetProperty("schedule");
            Assert.That(schedule.GetProperty("habitId").GetGuid(), Is.EqualTo(id));
            Assert.That(schedule.GetProperty("weekdays").EnumerateArray().Select(day => day.GetInt32()), Is.EqualTo(new[] { 1, 3, 7 }));
            Assert.That(schedule.GetProperty("repeatEveryWeeks").GetInt32(), Is.EqualTo(2));
            Assert.That(schedule.GetProperty("timeZone").GetString(), Is.EqualTo("America/New_York"));
            Assert.That(schedule.GetProperty("creationDate").GetString(), Is.EqualTo("2026-10-18"));
            Assert.That(schedule.GetProperty("firstWeekMonday").GetString(), Is.EqualTo("2026-10-12"));
            Assert.That(row.GetString(1), Is.EqualTo("owner"));
            Assert.That(row.GetString(2), Is.EqualTo(" Walking "));
            Assert.That(row.GetString(3), Is.EqualTo(" 5 minutes "));
            Assert.That(row.GetString(4), Is.EqualTo(" 15 minutes "));
            Assert.That(row.GetString(5), Is.EqualTo(" 30 minutes "));
            Assert.That(row.GetFieldValue<int[]>(6), Is.EqualTo(new[] { 1, 3, 7 }));
            Assert.That(row.GetInt32(7), Is.EqualTo(2));
            Assert.That(row.GetString(8), Is.EqualTo("America/New_York"));
            Assert.That(row.GetFieldValue<DateOnly>(9), Is.EqualTo(new DateOnly(2026, 10, 18)));
            Assert.That(row.GetFieldValue<DateOnly>(10), Is.EqualTo(new DateOnly(2026, 10, 12)));
        });
    }

    private sealed class FixedTime(DateTimeOffset instant) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => instant;
    }
}
