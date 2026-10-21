using System.Data.Common;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Damadama.Habits;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using NUnit.Framework;

namespace Damadama.Tests;

public class HabitDayTests
{
    private TestApp app = null!;
    private HttpClient client = null!;

    [SetUp]
    public async Task Start()
    {
        app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        client = app.SignedIn();
        await DatabaseFixture.Reset();
    }

    [TearDown]
    public void Stop() { client.Dispose(); app.Dispose(); }

    [Test]
    public async Task Day_read_preserves_scheduled_missing_and_excluded_retained_entries_without_foreign_rows()
    {
        var missing = await Create(client, "Missing");
        var retained = await Create(client, "Retained");
        using var saved = await client.PutAsJsonAsync($"/api/habits/{retained}/entries/2026-01-05", EntrySteps.Change("Clear"));
        saved.EnsureSuccessStatusCode();
        using var archived = await client.PostAsJsonAsync($"/api/habits/{retained}/archives",
            new ArchiveHabit(Guid.NewGuid(), "2026-01-05", "UTC", "Remove"));
        archived.EnsureSuccessStatusCode();
        using var foreign = app.SignedIn("foreign-day-owner");
        var other = await Create(foreign, "Foreign");
        using var foreignEntry = await foreign.PutAsJsonAsync($"/api/habits/{other}/entries/2026-01-05", EntrySteps.Change("Best"));
        foreignEntry.EnsureSuccessStatusCode();

        using var response = await client.GetAsync("/api/habit-days/2026-01-05");
        var day = await response.Content.ReadFromJsonAsync<JsonElement>();
        using var empty = app.SignedIn("empty-day-owner");
        var emptyDay = await empty.GetFromJsonAsync<JsonElement>("/api/habit-days/2026-01-05");
        var beforeCreation = await client.GetFromJsonAsync<JsonElement>("/api/habit-days/2026-01-03");

        Assert.Multiple(() =>
        {
            Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK));
            Assert.That(response.Headers.CacheControl?.Private, Is.True);
            Assert.That(response.Headers.CacheControl?.NoStore, Is.True);
            Assert.That(day.GetProperty("date").GetString(), Is.EqualTo("2026-01-05"));
            Assert.That(day.GetProperty("habits").EnumerateArray().Select(habit => habit.GetProperty("id").GetGuid()), Is.EqualTo(new[] { missing }));
            Assert.That(day.GetProperty("entries").EnumerateArray().Select(entry => entry.GetProperty("habitId").GetGuid()), Is.EqualTo(new[] { retained }));
            Assert.That(day.GetProperty("entries")[0].GetProperty("result").GetString(), Is.EqualTo("Clear"));
            Assert.That(emptyDay.GetProperty("habits").GetArrayLength(), Is.Zero);
            Assert.That(emptyDay.GetProperty("entries").GetArrayLength(), Is.Zero);
            Assert.That(beforeCreation.GetProperty("habits").GetArrayLength(), Is.Zero);
            Assert.That(beforeCreation.GetProperty("entries").GetArrayLength(), Is.Zero);
        });
    }

    [TestCase("invalid")]
    [TestCase("2026-02-30")]
    [TestCase("2026-1-05")]
    [TestCase("2026-01-05T00:00:00Z")]
    public async Task Malformed_day_reads_are_refused(string date)
    {
        using var response = await client.GetAsync($"/api/habit-days/{date}");
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.BadRequest));
        Assert.That(response.Content.Headers.ContentType?.MediaType, Is.EqualTo("application/problem+json"));
    }

    [Test]
    public async Task Day_resource_is_private_and_read_only_with_no_implicit_aliases()
    {
        using var anonymous = app.CreateClient();
        foreach (var date in new[] { "2026-01-05", "invalid" })
        {
            using var refusal = await anonymous.GetAsync($"/api/habit-days/{date}");
            Assert.That(refusal.StatusCode, Is.EqualTo(HttpStatusCode.Unauthorized));
            Assert.That(refusal.Headers.WwwAuthenticate.ToString(), Is.EqualTo("Bearer"));
        }
        foreach (var path in new[] { "/api/habit-days", "/api/habit-day/2026-01-05", "/api/habit-days/2026-01-05/entries" })
        {
            using var missing = await client.GetAsync(path);
            Assert.That(missing.StatusCode, Is.EqualTo(HttpStatusCode.NotFound));
        }
        using var unsupported = await client.PutAsJsonAsync("/api/habit-days/2026-01-05", new { });
        Assert.That(unsupported.StatusCode, Is.EqualTo(HttpStatusCode.MethodNotAllowed));
    }

    [Test]
    public async Task One_three_query_snapshot_does_not_mix_habits_and_entries_from_a_concurrent_change()
    {
        var id = await Create(client, "Walking");
        using var initial = await client.PutAsJsonAsync($"/api/habits/{id}/entries/2026-01-05", EntrySteps.Change("Good"));
        initial.EnsureSuccessStatusCode();
        var gate = new HoldFirstRead();
        await using var db = new HabitsDb(new DbContextOptionsBuilder<HabitsDb>()
            .UseNpgsql(DatabaseFixture.Database.GetConnectionString()).AddInterceptors(gate).Options);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var reading = new HabitHistory(db, TimeProvider.System).ReadDay("owner", new(2026, 1, 5), deadline.Token);
        try
        {
            await gate.Received.Task.WaitAsync(deadline.Token);
            using var edited = await client.PatchAsJsonAsync($"/api/habits/{id}", new EditHabit(Guid.NewGuid(),
                "2026-01-05", "UTC", "Renamed", "10", "20", "30", new([7], 1), "Remove"));
            edited.EnsureSuccessStatusCode();
            using var changedEntry = await client.PutAsJsonAsync($"/api/habits/{id}/entries/2026-01-05",
                EntrySteps.Change("Best", "2026-01-05T00:02:00Z"));
            changedEntry.EnsureSuccessStatusCode();
        }
        finally { gate.Release.TrySetResult(); }
        var original = await reading;
        var fresh = await client.GetFromJsonAsync<JsonElement>("/api/habit-days/2026-01-05");
        Assert.Multiple(() =>
        {
            Assert.That(gate.Reads, Is.EqualTo(3));
            Assert.That(original.Habits.Single().Name, Is.EqualTo("Walking"));
            Assert.That(original.Entries.Single().HabitName, Is.EqualTo("Walking"));
            Assert.That(original.Entries.Single().Result, Is.EqualTo("Good"));
            Assert.That(fresh.GetProperty("habits").GetArrayLength(), Is.Zero);
            Assert.That(fresh.GetProperty("entries")[0].GetProperty("habitName").GetString(), Is.EqualTo("Renamed"));
            Assert.That(fresh.GetProperty("entries")[0].GetProperty("result").GetString(), Is.EqualTo("Best"));
            Assert.That(fresh.GetProperty("entries")[0].GetProperty("good").GetString(), Is.EqualTo(HabitTests.Walking.Good));
        });
    }

    [Test]
    public async Task Habit_and_entry_order_is_stable_when_creation_instants_match()
    {
        var ids = new[] { await Create(client, "One"), await Create(client, "Two"), await Create(client, "Three") };
        foreach (var id in ids)
        {
            using var saved = await client.PutAsJsonAsync($"/api/habits/{id}/entries/2026-01-05", EntrySteps.Change());
            saved.EnsureSuccessStatusCode();
        }
        var day = await client.GetFromJsonAsync<JsonElement>("/api/habit-days/2026-01-05");
        var expected = ids.Select(id => id.ToString()).Order(StringComparer.Ordinal).ToArray();
        Assert.Multiple(() =>
        {
            Assert.That(day.GetProperty("habits").EnumerateArray().Select(habit => habit.GetProperty("id").GetString()), Is.EqualTo(expected));
            Assert.That(day.GetProperty("entries").EnumerateArray().Select(entry => entry.GetProperty("habitId").GetString()), Is.EqualTo(expected));
        });
    }

    private static async Task<Guid> Create(HttpClient creator, string name)
    {
        using var response = await creator.PostAsJsonAsync("/api/habits", HabitTests.Walking with
        { Name = name, Weekdays = [1, 2, 3, 4, 5, 6, 7], RepeatEveryWeeks = 1 });
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private sealed class HoldFirstRead : DbCommandInterceptor
    {
        public TaskCompletionSource Received { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int Reads { get; private set; }

        public override async ValueTask<DbDataReader> ReaderExecutedAsync(DbCommand command,
            CommandExecutedEventData eventData, DbDataReader result, CancellationToken cancellationToken = default)
        {
            Reads++;
            if (Reads == 1)
            {
                Received.TrySetResult();
                await Release.Task.WaitAsync(cancellationToken);
            }
            return result;
        }
    }
}
