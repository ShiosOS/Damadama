using System.Diagnostics;
using Damadama.Entries;
using Damadama.Habits;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using NUnit.Framework;
using Testcontainers.PostgreSql;

namespace Damadama.Tests;

public class DailyEntryPersistenceTests
{
    private static readonly DateOnly Day = new(2026, 10, 14);
    private static readonly DateTimeOffset Instant = new(2026, 10, 15, 13, 14, 15, TimeSpan.Zero);
    private readonly PostgreSqlContainer database = new PostgreSqlBuilder("postgres:17-alpine").Build();
    private DbContextOptions<HabitsDb> options = null!;

    [OneTimeSetUp]
    public async Task Start()
    {
        await database.StartAsync();
        options = new DbContextOptionsBuilder<HabitsDb>().UseNpgsql(database.GetConnectionString()).Options;
        await using var db = new HabitsDb(options);
        await db.Database.MigrateAsync();
    }

    [OneTimeTearDown]
    public async Task Stop() => await database.DisposeAsync();

    [Test]
    public async Task Schema_contains_daily_entries_and_matches_the_model()
    {
        await using var connection = new NpgsqlConnection(database.GetConnectionString());
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'", connection);
        await using var rows = await command.ExecuteReaderAsync();
        var tables = new List<string>();
        while (await rows.ReadAsync())
            tables.Add(rows.GetString(0));
        Assert.That(tables, Does.Contain("DailyEntries"));
        await using var db = new HabitsDb(options);
        Assert.That(db.Database.HasPendingModelChanges(), Is.False);
    }

    [Test]
    public async Task Calendar_dates_and_habits_have_independent_rows()
    {
        var first = await CreateHabit();
        var second = await CreateHabit();
        await Save(first, Day, EntryResult.Good, Instant);
        await Save(first, Day.AddDays(-1), EntryResult.Rest, Instant.AddDays(1));
        await Save(second, Day, EntryResult.Best, Instant);
        var firstDay = await Read(first.Id, Day);
        var previousDay = await Read(first.Id, Day.AddDays(-1));
        var secondHabit = await Read(second.Id, Day);
        Assert.Multiple(() =>
        {
            Assert.That(firstDay!.Result, Is.EqualTo(EntryResult.Good));
            Assert.That(previousDay!.Result, Is.EqualTo(EntryResult.Rest));
            Assert.That(secondHabit!.Result, Is.EqualTo(EntryResult.Best));
        });
    }

    [TestCase(false)]
    [TestCase(true)]
    public async Task Newest_edit_wins_in_both_sequential_orders_with_one_tick_precision(bool newestFirst)
    {
        var habit = await CreateHabit();
        var newer = Instant.AddTicks(1);
        if (newestFirst)
        {
            await Save(habit, Day, EntryResult.Good, newer);
            await Save(habit, Day, EntryResult.Best, Instant);
        }
        else
        {
            await Save(habit, Day, EntryResult.Best, Instant);
            await Save(habit, Day, EntryResult.Good, newer);
        }
        var stored = await Read(habit.Id, Day);
        Assert.Multiple(() =>
        {
            Assert.That(stored!.Result, Is.EqualTo(EntryResult.Good));
            Assert.That(stored.EditedAtTicks, Is.EqualTo(newer.UtcTicks));
        });
    }

    [TestCase(EntryResult.Clear, EntryResult.Clear, EntryResult.Clear)]
    [TestCase(EntryResult.Clear, EntryResult.Rest, EntryResult.Rest)]
    [TestCase(EntryResult.Clear, EntryResult.Good, EntryResult.Good)]
    [TestCase(EntryResult.Clear, EntryResult.Better, EntryResult.Better)]
    [TestCase(EntryResult.Clear, EntryResult.Best, EntryResult.Best)]
    [TestCase(EntryResult.Rest, EntryResult.Clear, EntryResult.Rest)]
    [TestCase(EntryResult.Rest, EntryResult.Rest, EntryResult.Rest)]
    [TestCase(EntryResult.Rest, EntryResult.Good, EntryResult.Good)]
    [TestCase(EntryResult.Rest, EntryResult.Better, EntryResult.Better)]
    [TestCase(EntryResult.Rest, EntryResult.Best, EntryResult.Best)]
    [TestCase(EntryResult.Good, EntryResult.Clear, EntryResult.Good)]
    [TestCase(EntryResult.Good, EntryResult.Rest, EntryResult.Good)]
    [TestCase(EntryResult.Good, EntryResult.Good, EntryResult.Good)]
    [TestCase(EntryResult.Good, EntryResult.Better, EntryResult.Better)]
    [TestCase(EntryResult.Good, EntryResult.Best, EntryResult.Best)]
    [TestCase(EntryResult.Better, EntryResult.Clear, EntryResult.Better)]
    [TestCase(EntryResult.Better, EntryResult.Rest, EntryResult.Better)]
    [TestCase(EntryResult.Better, EntryResult.Good, EntryResult.Better)]
    [TestCase(EntryResult.Better, EntryResult.Better, EntryResult.Better)]
    [TestCase(EntryResult.Better, EntryResult.Best, EntryResult.Best)]
    [TestCase(EntryResult.Best, EntryResult.Clear, EntryResult.Best)]
    [TestCase(EntryResult.Best, EntryResult.Rest, EntryResult.Best)]
    [TestCase(EntryResult.Best, EntryResult.Good, EntryResult.Best)]
    [TestCase(EntryResult.Best, EntryResult.Better, EntryResult.Best)]
    [TestCase(EntryResult.Best, EntryResult.Best, EntryResult.Best)]
    public async Task Exact_timestamp_ties_use_the_fixed_result_priority(EntryResult first, EntryResult second, EntryResult expected)
    {
        var habit = await CreateHabit();
        await Save(habit, Day, first, Instant);
        var original = await Read(habit.Id, Day);
        var winner = await Save(habit, Day, second, Instant);
        Assert.Multiple(() =>
        {
            Assert.That(winner.Result, Is.EqualTo(expected));
            Assert.That(winner.EditedAt, Is.EqualTo(Instant));
            Assert.That(winner.OriginalLevels.Good, Is.EqualTo(" 5 minutes "));
        });
        var stored = await Read(habit.Id, Day);
        Assert.That(stored!.Result, Is.EqualTo(expected));
        if (expected == first)
            Assert.That(stored.Xmin, Is.EqualTo(original!.Xmin));
    }

    [Test]
    public async Task Identical_retries_and_older_edits_leave_the_row_version_unchanged()
    {
        var habit = await CreateHabit();
        await Save(habit, Day, EntryResult.Better, Instant);
        var original = await Read(habit.Id, Day);
        var identical = await Save(habit, Day, EntryResult.Better, Instant.ToOffset(TimeSpan.FromHours(-4)));
        Assert.That(await Read(habit.Id, Day), Is.EqualTo(original));
        var older = await Save(habit, Day, EntryResult.Best, Instant.AddTicks(-1));
        Assert.That(await Read(habit.Id, Day), Is.EqualTo(original));
        Assert.Multiple(() =>
        {
            Assert.That(identical.Result, Is.EqualTo(EntryResult.Better));
            Assert.That(identical.EditedAt.Offset, Is.EqualTo(TimeSpan.Zero));
            Assert.That(older.Result, Is.EqualTo(EntryResult.Better));
            Assert.That(older.EditedAt, Is.EqualTo(Instant));
        });
    }

    [Test]
    public async Task Clear_keeps_its_timestamp_and_rejects_an_older_retry()
    {
        var habit = await CreateHabit();
        await Save(habit, Day, EntryResult.Best, Instant);
        await Save(habit, Day, EntryResult.Clear, Instant.AddTicks(1));
        var cleared = await Read(habit.Id, Day);
        var winner = await Save(habit, Day, EntryResult.Best, Instant);
        Assert.Multiple(() =>
        {
            Assert.That(winner.Result, Is.EqualTo(EntryResult.Clear));
            Assert.That(winner.EditedAt, Is.EqualTo(Instant.AddTicks(1)));
            Assert.That(cleared!.Result, Is.EqualTo(EntryResult.Clear));
            Assert.That(cleared.EditedAtTicks, Is.EqualTo(Instant.UtcTicks + 1));
        });
        Assert.That(await Read(habit.Id, Day), Is.EqualTo(cleared));
    }

    [Test]
    public async Task Recorded_level_definitions_survive_later_habit_definition_changes()
    {
        var habit = await CreateHabit();
        await Save(habit, Day, EntryResult.Good, Instant);
        await Execute($"""
            UPDATE "Habits" SET "Good" = 'new good', "Better" = 'new better', "Best" = 'new best'
            WHERE "Id" = '{habit.Id}'
            """);
        await using var db = new HabitsDb(options);
        var changed = await db.Habits.AsNoTracking().SingleAsync(h => h.Id == habit.Id);
        var winner = await Save(changed, Day, EntryResult.Better, Instant.AddTicks(1));
        var stored = await Read(habit.Id, Day);
        Assert.Multiple(() =>
        {
            Assert.That(changed.Levels.Good, Is.EqualTo("new good"));
            Assert.That(winner.OriginalLevels.Good, Is.EqualTo(" 5 minutes "));
            Assert.That(winner.OriginalLevels.Better, Is.EqualTo(" 15 minutes "));
            Assert.That(winner.OriginalLevels.Best, Is.EqualTo(" 30 minutes "));
            Assert.That(stored!.Good, Is.EqualTo(" 5 minutes "));
            Assert.That(stored.Better, Is.EqualTo(" 15 minutes "));
            Assert.That(stored.Best, Is.EqualTo(" 30 minutes "));
        });
    }

    [TestCase(false, false)]
    [TestCase(false, true)]
    [TestCase(true, false)]
    [TestCase(true, true)]
    public async Task Insert_update_and_commit_failures_roll_back_without_acknowledging(bool existing, bool atCommit)
    {
        var habit = await CreateHabit();
        if (existing)
            await Save(habit, Day, EntryResult.Rest, Instant);
        var before = await Read(habit.Id, Day);
        await Execute("""
            CREATE FUNCTION reject_entry_write() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'test-owned entry failure'; END; $$;
            """);
        var operation = existing ? "UPDATE" : "INSERT";
        await Execute(atCommit
            ? $"CREATE CONSTRAINT TRIGGER reject_entry_write AFTER {operation} ON \"DailyEntries\" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_entry_write()"
            : $"CREATE TRIGGER reject_entry_write BEFORE {operation} ON \"DailyEntries\" FOR EACH ROW EXECUTE FUNCTION reject_entry_write()");
        try
        {
            var failure = Assert.ThrowsAsync<PostgresException>(async () =>
                await Save(habit, Day, EntryResult.Best, Instant.AddTicks(1)));
            Assert.That(failure!.MessageText, Is.EqualTo("test-owned entry failure"));
            Assert.That(await Read(habit.Id, Day), Is.EqualTo(before));
        }
        finally
        {
            await Execute("DROP TRIGGER reject_entry_write ON \"DailyEntries\"; DROP FUNCTION reject_entry_write()");
        }
    }

    [TestCase(false, false, false)]
    [TestCase(false, false, true)]
    [TestCase(false, true, false)]
    [TestCase(false, true, true)]
    [TestCase(true, false, false)]
    [TestCase(true, false, true)]
    [TestCase(true, true, false)]
    [TestCase(true, true, true)]
    public async Task Overlapping_transactions_resolve_both_arrival_orders_and_return_the_committed_winner(
        bool existing, bool winnerFirst, bool exactTie)
    {
        var habit = await CreateHabit();
        if (existing)
            await Save(habit, Day, EntryResult.Clear, Instant.AddTicks(-1));
        var winnerTime = exactTie ? Instant : Instant.AddTicks(1);
        var winnerResult = exactTie ? EntryResult.Best : EntryResult.Good;
        var loserResult = exactTie ? EntryResult.Good : EntryResult.Best;
        const long gateKey = 714302;
        await using var gate = new NpgsqlConnection(database.GetConnectionString());
        await gate.OpenAsync();
        await using var takeGate = new NpgsqlCommand($"SELECT pg_advisory_lock({gateKey})", gate);
        await takeGate.ExecuteNonQueryAsync();
        await using var gatePidCommand = new NpgsqlCommand("SELECT pg_backend_pid()", gate);
        var gatePid = Convert.ToInt32(await gatePidCommand.ExecuteScalarAsync());
        await Execute($"""
            CREATE FUNCTION block_entry_write() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN PERFORM pg_advisory_xact_lock({gateKey}); RETURN NEW; END; $$;
            CREATE TRIGGER block_entry_write AFTER INSERT OR UPDATE ON "DailyEntries"
            FOR EACH ROW WHEN (NEW."HabitId" = '{habit.Id}') EXECUTE FUNCTION block_entry_write();
            """);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        await using var firstDb = new HabitsDb(options);
        await using var secondDb = new HabitsDb(options);
        await firstDb.Database.OpenConnectionAsync(timeout.Token);
        await secondDb.Database.OpenConnectionAsync(timeout.Token);
        var firstPid = await firstDb.Database.SqlQuery<int>($"SELECT pg_backend_pid() AS \"Value\"").SingleAsync(timeout.Token);
        var secondPid = await secondDb.Database.SqlQuery<int>($"SELECT pg_backend_pid() AS \"Value\"").SingleAsync(timeout.Token);
        Task<DailyEntry>? first = null;
        Task<DailyEntry>? second = null;
        try
        {
            first = DailyEntryStore.Save(firstDb, habit, Day, winnerFirst ? winnerResult : loserResult,
                winnerFirst ? winnerTime : Instant, timeout.Token);
            await AssertBlockedBy(firstPid, gatePid);
            second = DailyEntryStore.Save(secondDb, habit, Day, winnerFirst ? loserResult : winnerResult,
                winnerFirst ? Instant : winnerTime, timeout.Token);
            await AssertBlockedBy(secondPid, firstPid);
            Assert.Multiple(() =>
            {
                Assert.That(first.IsCompleted, Is.False);
                Assert.That(second.IsCompleted, Is.False);
            });
        }
        finally
        {
            await using var releaseGate = new NpgsqlCommand($"SELECT pg_advisory_unlock({gateKey})", gate);
            await releaseGate.ExecuteNonQueryAsync();
            try
            {
                if (first is not null)
                    await first;
                if (second is not null)
                    await second;
            }
            finally
            {
                await Execute("DROP TRIGGER block_entry_write ON \"DailyEntries\"; DROP FUNCTION block_entry_write()");
            }
        }
        Assert.Multiple(() =>
        {
            Assert.That(first!.Result.Result, Is.EqualTo(winnerFirst ? winnerResult : loserResult));
            Assert.That(second!.Result.Result, Is.EqualTo(winnerResult));
            Assert.That(second.Result.EditedAt, Is.EqualTo(winnerTime));
        });
        var persisted = await Read(habit.Id, Day);
        Assert.Multiple(() =>
        {
            Assert.That(persisted!.Result, Is.EqualTo(winnerResult));
            Assert.That(persisted.EditedAtTicks, Is.EqualTo(winnerTime.UtcTicks));
        });
    }

    private async Task AssertBlockedBy(int waitingPid, int blockerPid)
    {
        var watch = Stopwatch.StartNew();
        await using var connection = new NpgsqlConnection(database.GetConnectionString());
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand("""
            SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE pid = @waiting AND wait_event_type = 'Lock' AND @blocker = ANY(pg_blocking_pids(pid)))
            """, connection);
        command.Parameters.AddWithValue("waiting", waitingPid);
        command.Parameters.AddWithValue("blocker", blockerPid);
        while (watch.Elapsed < TimeSpan.FromSeconds(10))
        {
            if (await command.ExecuteScalarAsync() is true)
            {
                TestContext.Out.WriteLine($"PostgreSQL backend {waitingPid} waits on a lock held by {blockerPid}.");
                return;
            }
            await Task.Delay(20);
        }
        Assert.Fail($"PostgreSQL backend {waitingPid} did not wait on backend {blockerPid}.");
    }

    private async Task<Habit> CreateHabit()
    {
        await using var db = new HabitsDb(options);
        var habit = Habit.Create(new CreateHabit("Walking", " 5 minutes ", " 15 minutes ", " 30 minutes ",
            [1, 2, 3, 4, 5, 6, 7], 1, "UTC"), Guid.NewGuid().ToString(), Instant.AddDays(-5));
        db.Habits.Add(habit);
        await db.SaveChangesAsync();
        return habit;
    }

    private async Task<DailyEntry> Save(Habit habit, DateOnly date, EntryResult result, DateTimeOffset editedAt)
    {
        await using var db = new HabitsDb(options);
        return await DailyEntryStore.Save(db, habit, date, result, editedAt, CancellationToken.None);
    }

    private async Task Execute(string sql)
    {
        await using var connection = new NpgsqlConnection(database.GetConnectionString());
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand(sql, connection);
        await command.ExecuteNonQueryAsync();
    }

    private sealed record StoredEntry(EntryResult Result, long EditedAtTicks, string Good, string Better, string Best, long Xmin);

    private async Task<StoredEntry?> Read(Guid habitId, DateOnly date)
    {
        await using var connection = new NpgsqlConnection(database.GetConnectionString());
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand("""
            SELECT "Result", "EditedAtTicks", "Good", "Better", "Best", xmin::text::bigint
            FROM "DailyEntries" WHERE "HabitId" = @habit AND "CalendarDate" = @date
            """, connection);
        command.Parameters.AddWithValue("habit", habitId);
        command.Parameters.AddWithValue("date", date);
        await using var row = await command.ExecuteReaderAsync();
        if (!await row.ReadAsync())
            return null;
        return new StoredEntry((EntryResult)row.GetInt32(0), row.GetInt64(1), row.GetString(2), row.GetString(3), row.GetString(4), row.GetInt64(5));
    }
}
