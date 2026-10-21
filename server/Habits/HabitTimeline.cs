namespace Damadama.Habits;

public sealed class HabitTimeline(Habit habit, IReadOnlyList<HabitChange> changes)
{
    public bool Archived => changes.Any(change => change.Kind == HabitChangeKind.Archive);
    public long Revision => changes.Count == 0 ? 0 : changes[^1].Sequence;

    public InitialSchedule CurrentSchedule
    {
        get
        {
            var latest = changes.LastOrDefault(change => change.Weekdays is not null);
            if (latest is null) return habit.Schedule;
            return habit.Schedule.WithRecurrence(latest.Weekdays!, latest.RepeatEveryWeeks!.Value,
                latest.FirstWeekMonday!.Value);
        }
    }

    public bool IsScheduled(DateOnly date) => IsScheduled(date, changes.Count);

    public bool CanStartEntry(DateOnly date)
    {
        if (IsScheduled(date)) return true;
        for (var index = 0; index < changes.Count; index++)
        {
            var change = changes[index];
            if (change.AdmissionThrough is { } cutoff && date >= change.EffectiveDate && date <= cutoff &&
                IsScheduled(date, index))
                return true;
        }
        return false;
    }

    private bool IsScheduled(DateOnly date, int count)
    {
        if (date < habit.Schedule.CreationDate) return false;
        var schedule = habit.Schedule;
        var archived = false;
        TodayChoice? choice = null;
        for (var index = 0; index < count; index++)
        {
            var change = changes[index];
            if (change.EffectiveDate > date) continue;
            if (change.Weekdays is not null)
                schedule = habit.Schedule.WithRecurrence(change.Weekdays, change.RepeatEveryWeeks!.Value,
                    change.FirstWeekMonday!.Value);
            if (change.Kind == HabitChangeKind.Archive) archived = true;
            if (change.EffectiveDate == date && change.Choice is not null)
                choice = change.Choice;
        }
        if (choice is not null) return choice == TodayChoice.Keep;
        return !archived && ScheduleEligibility.IsScheduled(schedule, date);
    }
}
