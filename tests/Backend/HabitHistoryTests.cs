using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Damadama.Entries;
using Damadama.Habits;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using NUnit.Framework;

namespace Damadama.Tests;

public class HabitHistoryTests
{
    private TestApp app = null!;
    private HttpClient client = null!;
    private Guid id;
    private string Path => $"/api/habits/{id}";

    [SetUp]
    public async Task Start()
    {
        app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        client = app.SignedIn();
        await DatabaseFixture.Reset();
        using var created = await client.PostAsJsonAsync("/api/habits", HabitTests.Walking with
        { Weekdays = [1, 2, 3, 4, 5, 6, 7], RepeatEveryWeeks = 1 });
        created.EnsureSuccessStatusCode();
        id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    [TearDown]
    public void Stop() { client.Dispose(); app.Dispose(); }

    private static EditHabit Edit(Recurrence? schedule = null, string? choice = null) =>
        new(Guid.NewGuid(), "2026-01-05", "UTC", " Walking now ", " 10 minutes ", " 20 minutes ", " 40 minutes ", schedule, choice);

    [Test]
    public async Task Atomic_edit_preserves_recorded_definitions_and_original_schedule_columns()
    {
        using var recorded = await client.PutAsJsonAsync($"{Path}/entries/2026-01-04", EntrySteps.Change());
        recorded.EnsureSuccessStatusCode();
        using var edited = await client.PatchAsJsonAsync(Path, Edit(new([1, 7, 1], 2)));
        Assert.That(edited.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        var current = await edited.Content.ReadFromJsonAsync<JsonElement>();
        Assert.That(current.GetProperty("name").GetString(), Is.EqualTo(" Walking now "));
        Assert.That(current.GetProperty("schedule").GetProperty("weekdays").GetRawText(), Is.EqualTo("[1,7]"));
        Assert.That(current.GetProperty("schedule").GetProperty("firstWeekMonday").GetString(), Is.EqualTo("2026-01-05"));
        var oldEntry = await client.GetFromJsonAsync<JsonElement>($"{Path}/entries/2026-01-04");
        Assert.That(oldEntry.GetProperty("good").GetString(), Is.EqualTo(HabitTests.Walking.Good));
        using var db = Db();
        var initial = await db.InitialSchedules.SingleAsync();
        Assert.That(initial.Weekdays, Is.EqualTo(new[] { 1, 2, 3, 4, 5, 6, 7 }));
        Assert.That(initial.FirstWeekMonday, Is.EqualTo(new DateOnly(2025, 12, 29)));
        Assert.That(await db.HabitChanges.CountAsync(), Is.EqualTo(2));
        var history = await new HabitHistory(db, TimeProvider.System).ReadOwnedRange("owner", new(new(2026, 1, 4), new(2026, 1, 12)), default);
        Assert.That(history.Records.Single(row => row.Date == new DateOnly(2026, 1, 4)).Scheduled, Is.True);
        Assert.That(history.Records.Any(row => row.Date == new DateOnly(2026, 1, 12) && row.Scheduled), Is.False);
    }

    [TestCase("Keep", true)]
    [TestCase("Remove", false)]
    public async Task Archive_requires_choice_and_keeps_entry_editable_without_rescheduling(string choice, bool scheduled)
    {
        using var saved = await client.PutAsJsonAsync($"{Path}/entries/2026-01-05", EntrySteps.Change("Clear"));
        saved.EnsureSuccessStatusCode();
        var input = new ArchiveHabit(Guid.NewGuid(), "2026-01-05", "UTC", null);
        using var refused = await client.PostAsJsonAsync($"{Path}/archives", input);
        Assert.That(refused.StatusCode, Is.EqualTo(HttpStatusCode.Conflict));
        Assert.That(await DatabaseFixture.Count("HabitChanges"), Is.Zero);
        using var accepted = await client.PostAsJsonAsync($"{Path}/archives", input with { TodayChoice = choice });
        Assert.That(accepted.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        var habits = await client.GetFromJsonAsync<JsonElement>("/api/habits?scheduledOn=2026-01-05");
        Assert.That(habits.GetArrayLength(), Is.EqualTo(scheduled ? 1 : 0));
        var future = await client.GetFromJsonAsync<JsonElement>("/api/habits?scheduledOn=2026-01-06");
        Assert.That(future.GetArrayLength(), Is.Zero);
        using var changed = await client.PutAsJsonAsync($"{Path}/entries/2026-01-05", EntrySteps.Change("Best", "2026-01-05T00:02:00Z"));
        Assert.That(changed.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        var retained = await client.GetFromJsonAsync<JsonElement>($"{Path}/entries/2026-01-05");
        Assert.That(retained.GetProperty("result").GetString(), Is.EqualTo("Best"));
        using var db = Db();
        var history = await new HabitHistory(db, TimeProvider.System).ReadOwnedRange("owner", new(new(2026, 1, 5), new(2026, 1, 5)), default);
        Assert.That(history.Records.Single().Scheduled, Is.EqualTo(scheduled));
        Assert.That(history.Records.Single().Result, Is.EqualTo(EntryResult.Best));
    }

    [Test]
    public async Task A_pending_first_save_after_archive_is_retained_but_never_reincluded()
    {
        using var archived = await client.PostAsJsonAsync($"{Path}/archives", new ArchiveHabit(Guid.NewGuid(), "2026-01-04", "America/New_York", null));
        archived.EnsureSuccessStatusCode();
        using var saved = await client.PutAsJsonAsync($"{Path}/entries/2026-01-05", EntrySteps.Change());
        Assert.That(saved.StatusCode, Is.EqualTo(HttpStatusCode.Created));
        var scheduled = await client.GetFromJsonAsync<JsonElement>("/api/habits?scheduledOn=2026-01-05");
        Assert.That(scheduled.GetArrayLength(), Is.Zero);
        using var future = await client.PutAsJsonAsync($"{Path}/entries/2026-01-06", EntrySteps.Change());
        Assert.That(future.StatusCode, Is.EqualTo(HttpStatusCode.BadRequest));
    }

    [Test]
    public async Task Definition_only_edits_on_archived_habits_preserve_the_schedule_anchor_and_removal()
    {
        using var saved = await client.PutAsJsonAsync($"{Path}/entries/2026-01-05", EntrySteps.Change());
        saved.EnsureSuccessStatusCode();
        using var archived = await client.PostAsJsonAsync($"{Path}/archives", new ArchiveHabit(Guid.NewGuid(), "2026-01-05", "UTC", "Remove"));
        archived.EnsureSuccessStatusCode();
        using var edited = await client.PatchAsJsonAsync(Path, Edit());
        edited.EnsureSuccessStatusCode();
        var response = await edited.Content.ReadFromJsonAsync<JsonElement>();
        Assert.That(response.GetProperty("archived").GetBoolean(), Is.True);
        Assert.That(response.GetProperty("schedule").GetProperty("firstWeekMonday").GetString(), Is.EqualTo("2025-12-29"));
        Assert.That((await client.GetFromJsonAsync<JsonElement>("/api/habits?scheduledOn=2026-01-05")).GetArrayLength(), Is.Zero);
    }

    [Test]
    public async Task Mutation_replay_survives_midnight_and_cannot_overwrite_a_newer_edit()
    {
        var clock = new MovingClock { Now = TestApp.CreationInstant };
        var input = Edit();
        await using var db = Db();
        var history = new HabitHistory(db, clock);
        Assert.That(await history.Edit(id, "owner", input, default), Is.TypeOf<HabitMutationOutcome.Accepted>());
        Assert.That(await history.Edit(id, "owner", Edit() with { Name = "Latest" }, default), Is.TypeOf<HabitMutationOutcome.Accepted>());
        clock.Now = clock.Now.AddDays(1);
        var replay = await history.Edit(id, "owner", input, default);
        Assert.That(replay, Is.TypeOf<HabitMutationOutcome.Accepted>());
        Assert.That(((HabitMutationOutcome.Accepted)replay).Habit.Name, Is.EqualTo("Latest"));
        Assert.That(await db.HabitChanges.CountAsync(), Is.EqualTo(3));
        Assert.That(await history.Edit(id, "owner", input with { Name = "Mismatch" }, default),
            Is.EqualTo(new HabitMutationOutcome.Conflict("mutation_mismatch")));
    }

    [TestCase(false)]
    [TestCase(true)]
    public async Task Foreign_and_missing_habits_are_not_found_before_domain_validation(bool foreign)
    {
        using var requester = app.SignedIn(foreign ? "other" : "owner");
        var target = foreign ? id : Guid.NewGuid();
        using var edit = await requester.PatchAsJsonAsync($"/api/habits/{target}", new { });
        using var archive = await requester.PostAsJsonAsync($"/api/habits/{target}/archives", new { });
        Assert.That(edit.StatusCode, Is.EqualTo(HttpStatusCode.NotFound));
        Assert.That(archive.StatusCode, Is.EqualTo(HttpStatusCode.NotFound));
    }

    [Test]
    public async Task Invalid_atomic_edit_changes_neither_projection_nor_history()
    {
        using var refused = await client.PatchAsJsonAsync(Path, Edit(new([], 0)) with { Good = " " });
        Assert.That(refused.StatusCode, Is.EqualTo(HttpStatusCode.BadRequest));
        var response = await client.GetFromJsonAsync<JsonElement>(Path);
        Assert.That(response.GetProperty("good").GetString(), Is.EqualTo(HabitTests.Walking.Good));
        Assert.That(await DatabaseFixture.Count("HabitChanges"), Is.Zero);
    }

    [Test]
    public async Task Travel_to_a_date_before_creation_does_not_move_saved_calendar_dates()
    {
        using var created = await client.PostAsJsonAsync("/api/habits", HabitTests.Walking with { TimeZone = "Asia/Tokyo" });
        var otherId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        using var edited = await client.PatchAsJsonAsync($"/api/habits/{otherId}", Edit() with
        { DeviceToday = "2026-01-04", TimeZone = "America/New_York" });
        edited.EnsureSuccessStatusCode();
        var response = await edited.Content.ReadFromJsonAsync<JsonElement>();
        Assert.That(response.GetProperty("schedule").GetProperty("creationDate").GetString(), Is.EqualTo("2026-01-05"));
    }

    [Test]
    public async Task Commit_failure_rolls_back_both_the_projection_and_journal()
    {
        await DatabaseFixture.Execute("""
            CREATE FUNCTION refuse_history_commit() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'test-owned history commit failure'; END; $$;
            CREATE CONSTRAINT TRIGGER refuse_history_commit AFTER INSERT ON "HabitChanges"
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_history_commit();
            """);
        try
        {
            using var failed = await client.PatchAsJsonAsync(Path, Edit());
            Assert.That(failed.StatusCode, Is.EqualTo(HttpStatusCode.ServiceUnavailable));
            Assert.That(await DatabaseFixture.Count("HabitChanges"), Is.Zero);
            var current = await client.GetFromJsonAsync<JsonElement>(Path);
            Assert.That(current.GetProperty("name").GetString(), Is.EqualTo(HabitTests.Walking.Name));
        }
        finally { await DatabaseFixture.Execute("DROP TRIGGER refuse_history_commit ON \"HabitChanges\"; DROP FUNCTION refuse_history_commit()"); }
    }

    [TestCase(false, false)]
    [TestCase(true, false)]
    [TestCase(false, true)]
    [TestCase(true, true)]
    public async Task Habit_edit_and_first_entry_serialize_both_orders_before_snapshotting_and_today_choice(bool editFirst, bool changesSchedule)
    {
        const long gateKey = 714304;
        await using var gate = new NpgsqlConnection(DatabaseFixture.Database.GetConnectionString());
        await gate.OpenAsync();
        await using var take = new NpgsqlCommand($"SELECT pg_advisory_lock({gateKey})", gate);
        await take.ExecuteNonQueryAsync();
        var table = editFirst ? "HabitChanges" : "DailyEntries";
        await DatabaseFixture.Execute($"""
            CREATE FUNCTION block_history_order() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN PERFORM pg_advisory_xact_lock({gateKey}); RETURN NEW; END; $$;
            CREATE TRIGGER block_history_order AFTER INSERT ON "{table}"
            FOR EACH ROW WHEN (NEW."HabitId" = '{id}') EXECUTE FUNCTION block_history_order();
            """);
        await using var editDb = Db();
        await using var entryDb = Db();
        await editDb.Database.OpenConnectionAsync();
        await entryDb.Database.OpenConnectionAsync();
        var editPid = await editDb.Database.SqlQuery<int>($"SELECT pg_backend_pid() AS \"Value\"").SingleAsync();
        var entryPid = await entryDb.Database.SqlQuery<int>($"SELECT pg_backend_pid() AS \"Value\"").SingleAsync();
        var clock = new MovingClock { Now = TestApp.CreationInstant };
        var editor = new HabitHistory(editDb, clock);
        var recorder = new HabitHistory(entryDb, clock);
        var input = Edit(changesSchedule ? new Recurrence([2], 1) : null);
        Task<HabitMutationOutcome>? editing = null;
        Task<(EntrySaveOutcome Outcome, string HabitName)?>? saving = null;
        try
        {
            if (editFirst) editing = editor.Edit(id, "owner", input, default);
            else saving = recorder.SaveEntry(id, "owner", "2026-01-05", new("Good", TestApp.CreationInstant, "2026-01-05", "UTC"), default);
            await WaitBlocked(editFirst ? editPid : entryPid);
            if (editFirst) saving = recorder.SaveEntry(id, "owner", "2026-01-05", new("Good", TestApp.CreationInstant, "2026-01-05", "UTC"), default);
            else editing = editor.Edit(id, "owner", input, default);
            await WaitBlocked(editFirst ? entryPid : editPid);
            Assert.That(editing!.IsCompleted || saving!.IsCompleted, Is.False);
        }
        finally
        {
            await using var release = new NpgsqlCommand($"SELECT pg_advisory_unlock({gateKey})", gate);
            await release.ExecuteNonQueryAsync();
            try
            {
                if (editing is not null) await editing;
                if (saving is not null) await saving;
            }
            finally { await DatabaseFixture.Execute($"DROP TRIGGER block_history_order ON \"{table}\"; DROP FUNCTION block_history_order()"); }
        }
        if (!editFirst && changesSchedule)
            Assert.That(editing!.Result, Is.EqualTo(new HabitMutationOutcome.Conflict("today_choice_required")));
        else Assert.That(editing!.Result, Is.TypeOf<HabitMutationOutcome.Accepted>());
        Assert.That(saving!.Result!.Value.Outcome.Entry.OriginalLevels.Good,
            Is.EqualTo(editFirst ? " 10 minutes " : HabitTests.Walking.Good));
        var stored = await client.GetFromJsonAsync<JsonElement>($"{Path}/entries/2026-01-05");
        Assert.That(stored.GetProperty("good").GetString(), Is.EqualTo(editFirst ? " 10 minutes " : HabitTests.Walking.Good));
    }

    private static async Task WaitBlocked(int pid)
    {
        await using var connection = new NpgsqlConnection(DatabaseFixture.Database.GetConnectionString());
        await connection.OpenAsync();
        await using var query = new NpgsqlCommand("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = @pid AND wait_event_type = 'Lock')", connection);
        query.Parameters.AddWithValue("pid", pid);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (await query.ExecuteScalarAsync(deadline.Token) is not true)
            await Task.Delay(20, deadline.Token);
    }

    private static HabitsDb Db() => new(new DbContextOptionsBuilder<HabitsDb>()
        .UseNpgsql(DatabaseFixture.Database.GetConnectionString()).Options);

    private sealed class MovingClock : TimeProvider
    {
        public DateTimeOffset Now { get; set; }
        public override DateTimeOffset GetUtcNow() => Now;
    }
}
