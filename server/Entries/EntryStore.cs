using Damadama.Habits;
using Microsoft.EntityFrameworkCore;

namespace Damadama.Entries;

internal static class EntryStore
{
    internal static async Task<EntrySaveOutcome> SaveLocked(HabitsDb db, Habit habit, EntryEdit edit,
        CancellationToken cancellationToken)
    {
        var inserted = await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO "DailyEntries" ("HabitId", "CalendarDate", "Result", "EditedAtTicks", "Good", "Better", "Best")
            VALUES ({habit.Id}, {edit.CalendarDate}, {(int)edit.Result}, {edit.EditedAt.UtcTicks},
                {habit.Levels.Good}, {habit.Levels.Better}, {habit.Levels.Best})
            ON CONFLICT ("HabitId", "CalendarDate") DO NOTHING
            """, cancellationToken);
        if (inserted == 0)
            await db.Database.ExecuteSqlInterpolatedAsync($"""
            INSERT INTO "DailyEntries" ("HabitId", "CalendarDate", "Result", "EditedAtTicks", "Good", "Better", "Best")
            VALUES ({habit.Id}, {edit.CalendarDate}, {(int)edit.Result}, {edit.EditedAt.UtcTicks},
                {habit.Levels.Good}, {habit.Levels.Better}, {habit.Levels.Best})
            ON CONFLICT ("HabitId", "CalendarDate") DO UPDATE
            SET "Result" = EXCLUDED."Result", "EditedAtTicks" = EXCLUDED."EditedAtTicks"
            WHERE (EXCLUDED."EditedAtTicks", EXCLUDED."Result") > ("DailyEntries"."EditedAtTicks", "DailyEntries"."Result")
            """, cancellationToken);
        // A separate Read Committed statement sees a conflicting insert after its transaction commits.
        var winner = await db.Entries.AsNoTracking()
            .SingleAsync(entry => entry.HabitId == habit.Id && entry.CalendarDate == edit.CalendarDate, cancellationToken);
        if (inserted == 1) return new EntrySaveOutcome.Created(winner);
        return winner.EditedAt.UtcTicks == edit.EditedAt.UtcTicks && winner.Result == edit.Result
            ? new EntrySaveOutcome.Accepted(winner)
            : new EntrySaveOutcome.Superseded(winner);
    }
}

public abstract record EntrySaveOutcome(Entry Entry)
{
    public sealed record Created(Entry Value) : EntrySaveOutcome(Value);
    public sealed record Accepted(Entry Value) : EntrySaveOutcome(Value);
    public sealed record Superseded(Entry Value) : EntrySaveOutcome(Value);
}
