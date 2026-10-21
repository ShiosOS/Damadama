using System.Data;
using System.Text.Json;
using Damadama.Entries;
using Microsoft.EntityFrameworkCore;

namespace Damadama.Habits;

public sealed class HabitHistory(HabitsDb db, TimeProvider clock) : IHistoryReader
{
    public Task<HabitMutationOutcome> Edit(Guid id, string owner, EditHabit input, CancellationToken ct) =>
        Mutate(id, owner, new Command.Edit(input), ct);

    public Task<HabitMutationOutcome> Archive(Guid id, string owner, ArchiveHabit input, CancellationToken ct) =>
        Mutate(id, owner, new Command.Archive(input), ct);

    private abstract record Command(Guid Id, string? Date, string? Zone, string? Choice)
    {
        public sealed record Edit(EditHabit Input) : Command(Input.MutationId, Input.DeviceToday, Input.TimeZone, Input.TodayChoice);
        public sealed record Archive(ArchiveHabit Input) : Command(Input.MutationId, Input.DeviceToday, Input.TimeZone, Input.TodayChoice);
    }

    private async Task<HabitMutationOutcome> Mutate(Guid id, string owner, Command command, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var habit = await LockOwned(id, owner, ct);
        if (habit is null) return new HabitMutationOutcome.Missing();
        if (command.Id == Guid.Empty)
            throw new ArgumentException("Include a nonempty mutation identifier.", "mutationId");
        var changes = await Changes(id, ct);
        var canonical = command switch
        {
            Command.Edit edit => new Command.Edit(edit.Input with { Schedule = edit.Input.Schedule?.Validated() }),
            Command.Archive archive => (Command)archive,
            _ => throw new System.Diagnostics.UnreachableException()
        };
        var payload = canonical switch
        {
            Command.Edit edit => "edit:" + JsonSerializer.Serialize(edit.Input),
            Command.Archive archive => "archive:" + JsonSerializer.Serialize(archive.Input),
            _ => throw new System.Diagnostics.UnreachableException()
        };
        var previous = changes.SingleOrDefault(change => change.MutationId == command.Id);
        if (previous is not null)
        {
            if (previous.Payload != payload) return new HabitMutationOutcome.Conflict("mutation_mismatch");
            return new HabitMutationOutcome.Accepted(Response(habit, changes));
        }
        var day = DeviceCalendar.Today(command.Date, command.Zone, clock);
        var choice = ParseChoice(command.Choice);
        var replacesSchedule = canonical is Command.Archive || canonical is Command.Edit { Input.Schedule: not null };
        if (!replacesSchedule && choice is not null)
            throw new ArgumentException("Choose Keep or Remove only when changing the schedule or archiving.", "todayChoice");
        if (replacesSchedule && choice is null && await db.Entries.AnyAsync(entry => entry.HabitId == id && entry.CalendarDate == day, ct))
            return new HabitMutationOutcome.Conflict("today_choice_required");
        if (choice is not null && !await db.Entries.AnyAsync(entry => entry.HabitId == id && entry.CalendarDate == day, ct))
            throw new ArgumentException("There is no saved entry to keep or remove today.", "todayChoice");

        var sequence = changes.Count == 0 ? 1 : changes[^1].Sequence + 1;
        var baseline = changes.Count == 0 ? HabitChange.Baseline(habit) : null;
        HabitChange change;
        if (canonical is Command.Edit editing)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(editing.Input.Name, "name");
            var levels = HabitLevels.Create(editing.Input.Good, editing.Input.Better, editing.Input.Best);
            change = HabitChange.Edit(habit, sequence, editing.Input, day, choice, payload, clock.GetUtcNow());
            habit.Edit(editing.Input.Name, levels);
        }
        else if (canonical is Command.Archive archiving)
            change = HabitChange.Archive(habit, sequence, archiving.Input, day, choice, payload, clock.GetUtcNow());
        else throw new System.Diagnostics.UnreachableException();

        if (baseline is not null) db.HabitChanges.Add(baseline);
        db.HabitChanges.Add(change);
        if (canonical is Command.Edit)
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                UPDATE "Habits" SET "Name" = {habit.Name}, "Good" = {habit.Levels.Good},
                    "Better" = {habit.Levels.Better}, "Best" = {habit.Levels.Best} WHERE "Id" = {id}
                """, ct);
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        changes.Add(change);
        return new HabitMutationOutcome.Accepted(Response(habit, changes));
    }

    public async Task<(EntrySaveOutcome Outcome, string HabitName)?> SaveEntry(Guid id, string owner, string date,
        WriteEntry input, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        var habit = await LockOwned(id, owner, ct);
        if (habit is null) return null;
        var edit = EntryEdit.Parse(date, input, clock);
        var retained = await db.Entries.AnyAsync(entry => entry.HabitId == id && entry.CalendarDate == edit.CalendarDate, ct);
        if (!retained && !new HabitTimeline(habit, await Changes(id, ct)).CanStartEntry(edit.CalendarDate))
            throw new ArgumentException("This habit was not scheduled on that date.", nameof(date));
        var outcome = await EntryStore.SaveLocked(db, habit, edit, ct);
        await transaction.CommitAsync(ct);
        return (outcome, habit.Name);
    }

    public async Task<HabitResponse[]> ReadHabits(string owner, DateOnly? scheduledOn, Guid? id, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        var habits = await db.Habits.AsNoTracking().Include(habit => habit.Schedule)
            .Where(habit => habit.OwnerId == owner && (id == null || habit.Id == id))
            .OrderBy(habit => habit.CreatedAt).ThenBy(habit => habit.Id).ToListAsync(ct);
        var ids = habits.Select(habit => habit.Id).ToArray();
        var changes = await db.HabitChanges.AsNoTracking().Where(change => ids.Contains(change.HabitId))
            .OrderBy(change => change.Sequence).ToListAsync(ct);
        var groups = changes.ToLookup(change => change.HabitId);
        var result = habits.Where(habit => scheduledOn is null || new HabitTimeline(habit, groups[habit.Id].ToArray()).IsScheduled(scheduledOn.Value))
            .Select(habit => Response(habit, groups[habit.Id].ToArray())).ToArray();
        await transaction.CommitAsync(ct);
        return result;
    }

    public async Task<OwnedHistoryRange> ReadOwnedRange(string ownerId, InclusiveDateRange range, CancellationToken ct)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.RepeatableRead, ct);
        var habits = await db.Habits.AsNoTracking().Include(habit => habit.Schedule)
            .Where(habit => habit.OwnerId == ownerId).ToListAsync(ct);
        var ids = habits.Select(habit => habit.Id).ToArray();
        var changes = await db.HabitChanges.AsNoTracking().Where(change => ids.Contains(change.HabitId))
            .OrderBy(change => change.Sequence).ToListAsync(ct);
        var entries = await db.Entries.AsNoTracking().Where(entry => ids.Contains(entry.HabitId) &&
            entry.CalendarDate >= range.Start && entry.CalendarDate <= range.End).ToListAsync(ct);
        var groups = changes.ToLookup(change => change.HabitId);
        var byDate = entries.ToDictionary(entry => (entry.HabitId, entry.CalendarDate));
        var result = new List<HistoryDate>();
        foreach (var habit in habits)
        {
            var timeline = new HabitTimeline(habit, groups[habit.Id].ToArray());
            for (var day = range.Start; ; day = day.AddDays(1))
            {
                var scheduled = timeline.IsScheduled(day);
                var entry = byDate.GetValueOrDefault((habit.Id, day));
                if (scheduled || entry is not null) result.Add(new(habit.Id, day, scheduled, entry?.Result));
                if (day == range.End) break;
            }
        }
        await transaction.CommitAsync(ct);
        return new(range, result);
    }

    private async Task<Habit?> LockOwned(Guid id, string owner, CancellationToken ct)
    {
        var locked = await db.Database.SqlQuery<Guid>($"""
            SELECT "Id" AS "Value" FROM "Habits" WHERE "Id" = {id} AND "OwnerId" = {owner} FOR UPDATE
            """).ToArrayAsync(ct);
        if (locked.Length == 0) return null;
        return await db.Habits.AsNoTracking().Include(habit => habit.Schedule).SingleAsync(habit => habit.Id == id, ct);
    }

    private Task<List<HabitChange>> Changes(Guid id, CancellationToken ct) =>
        db.HabitChanges.AsNoTracking().Where(change => change.HabitId == id).OrderBy(change => change.Sequence).ToListAsync(ct);

    private static HabitResponse Response(Habit habit, IReadOnlyList<HabitChange> changes)
    {
        var timeline = new HabitTimeline(habit, changes);
        return HabitResponse.From(habit) with { Schedule = timeline.CurrentSchedule, Archived = timeline.Archived, Revision = timeline.Revision };
    }

    private static TodayChoice? ParseChoice(string? value)
    {
        if (value is null) return null;
        if (value == "Keep") return TodayChoice.Keep;
        if (value == "Remove") return TodayChoice.Remove;
        throw new ArgumentException("Choose Keep or Remove.", "todayChoice");
    }
}

public abstract record HabitMutationOutcome
{
    public sealed record Accepted(HabitResponse Habit) : HabitMutationOutcome;
    public sealed record Missing : HabitMutationOutcome;
    public sealed record Conflict(string Code) : HabitMutationOutcome;
}

public sealed class HabitMutationProblem : Microsoft.AspNetCore.Mvc.ProblemDetails
{
    public required string Code { get; init; }
}
