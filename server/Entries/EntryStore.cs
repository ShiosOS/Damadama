using System.Data;
using Damadama.Habits;
using Microsoft.EntityFrameworkCore;

namespace Damadama.Entries;

public static class EntryStore
{
    public static async Task<Entry> Save(HabitsDb db, Habit habit, EntryEdit edit,
        CancellationToken cancellationToken)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
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
        await transaction.CommitAsync(cancellationToken);
        return winner;
    }
}
