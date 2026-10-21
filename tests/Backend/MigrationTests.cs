using Damadama.Habits;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql;
using NUnit.Framework;
using Testcontainers.PostgreSql;

namespace Damadama.Tests;

public class MigrationTests
{
    [Test]
    public async Task Existing_flat_columns_survive_migration_and_fresh_materialization()
    {
        await using var database = new PostgreSqlBuilder("postgres:17-alpine").Build();
        await database.StartAsync();
        var options = new DbContextOptionsBuilder<HabitsDb>().UseNpgsql(database.GetConnectionString()).Options;
        await using (var original = new HabitsDb(options))
            await original.GetService<IMigrator>().MigrateAsync("20261011071109_InitialHabits");

        await using (var connection = new NpgsqlConnection(database.GetConnectionString()))
        {
            await connection.OpenAsync();
            await using var insert = new NpgsqlCommand("""
                INSERT INTO "Habits" ("Id", "OwnerId", "Name", "Good", "Better", "Best", "CreatedAt")
                VALUES ('c487d127-35a7-4859-a8fa-71924724c7a1', 'original-owner', ' Walking ',
                    ' 5 minutes ', ' 15 minutes ', ' 30 minutes ', '2026-01-05T00:30:00Z');
                INSERT INTO "InitialSchedules" ("HabitId", "Weekdays", "RepeatEveryWeeks", "TimeZone", "CreationDate", "FirstWeekMonday")
                VALUES ('c487d127-35a7-4859-a8fa-71924724c7a1', ARRAY[1,7], 2, 'America/New_York', '2026-01-04', '2025-12-29');
                """, connection);
            await insert.ExecuteNonQueryAsync();
        }

        await using (var migrating = new HabitsDb(options))
        {
            Assert.That(migrating.Database.HasPendingModelChanges(), Is.False);
            await migrating.Database.MigrateAsync();
        }

        await using (var connection = new NpgsqlConnection(database.GetConnectionString()))
        {
            await connection.OpenAsync();
            await using var command = new NpgsqlCommand("""
                SELECT "Good", "Better", "Best" FROM "Habits"
                WHERE "Id" = 'c487d127-35a7-4859-a8fa-71924724c7a1'
                """, connection);
            await using var row = await command.ExecuteReaderAsync();
            Assert.That(await row.ReadAsync(), Is.True);
            Assert.Multiple(() =>
            {
                Assert.That(row.GetString(0), Is.EqualTo(" 5 minutes "));
                Assert.That(row.GetString(1), Is.EqualTo(" 15 minutes "));
                Assert.That(row.GetString(2), Is.EqualTo(" 30 minutes "));
            });
        }

        await using var fresh = new HabitsDb(options);
        var habit = await fresh.Habits.AsNoTracking().Include(h => h.Schedule).SingleAsync();
        var response = HabitResponse.From(habit);
        Assert.Multiple(() =>
        {
            Assert.That(response.Id, Is.EqualTo(Guid.Parse("c487d127-35a7-4859-a8fa-71924724c7a1")));
            Assert.That(habit.OwnerId, Is.EqualTo("original-owner"));
            Assert.That(response.Name, Is.EqualTo(" Walking "));
            Assert.That(response.Good, Is.EqualTo(" 5 minutes "));
            Assert.That(response.Better, Is.EqualTo(" 15 minutes "));
            Assert.That(response.Best, Is.EqualTo(" 30 minutes "));
            Assert.That(response.CreatedAt, Is.EqualTo(DateTimeOffset.Parse("2026-01-05T00:30:00Z")));
            Assert.That(response.Schedule.Weekdays, Is.EqualTo(new[] { 1, 7 }));
            Assert.That(response.Schedule.RepeatEveryWeeks, Is.EqualTo(2));
            Assert.That(response.Schedule.TimeZone, Is.EqualTo("America/New_York"));
            Assert.That(response.Schedule.CreationDate, Is.EqualTo(new DateOnly(2026, 1, 4)));
            Assert.That(response.Schedule.FirstWeekMonday, Is.EqualTo(new DateOnly(2025, 12, 29)));
        });
        await using (var connection = new NpgsqlConnection(database.GetConnectionString()))
        {
            await connection.OpenAsync();
            await using var legacyCreate = new NpgsqlCommand("""
                INSERT INTO "Habits" ("Id", "OwnerId", "Name", "Good", "Better", "Best", "CreatedAt")
                VALUES ('9452dcec-8cbe-4d2a-b94a-8701f4114858', 'legacy-writer', 'Legacy create',
                    '5', '15', '30', '2026-01-05T00:30:00Z');
                INSERT INTO "InitialSchedules" ("HabitId", "Weekdays", "RepeatEveryWeeks", "TimeZone", "CreationDate", "FirstWeekMonday")
                VALUES ('9452dcec-8cbe-4d2a-b94a-8701f4114858', ARRAY[1,7], 1, 'UTC', '2026-01-05', '2026-01-05');
                """, connection);
            await legacyCreate.ExecuteNonQueryAsync();
        }
        var history = await new HabitHistory(fresh, TimeProvider.System).ReadOwnedRange("legacy-writer",
            new(new(2026, 1, 5), new(2026, 1, 5)), CancellationToken.None);
        Assert.That(history.Records.Count, Is.EqualTo(1));
        Assert.That(history.Records[0].Scheduled, Is.True);
        Assert.That(await fresh.HabitChanges.CountAsync(), Is.Zero);
    }
}
