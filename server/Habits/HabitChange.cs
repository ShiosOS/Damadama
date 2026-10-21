namespace Damadama.Habits;

public enum HabitChangeKind { Baseline, Edit, Archive }
public enum TodayChoice { Keep, Remove }

public sealed record Recurrence(int[]? Weekdays, int RepeatEveryWeeks)
{
    internal Recurrence Validated()
    {
        if (Weekdays is not { Length: > 0 } || Weekdays.Any(day => day is < 1 or > 7))
            throw new ArgumentException("Select at least one weekday from Monday to Sunday.", nameof(Weekdays));
        if (RepeatEveryWeeks <= 0)
            throw new ArgumentException("Repeat interval must be a positive number of weeks.", nameof(RepeatEveryWeeks));
        return new Recurrence(Weekdays.Distinct().Order().ToArray(), RepeatEveryWeeks);
    }
}

public sealed record EditHabit(Guid MutationId, string? DeviceToday, string? TimeZone,
    string? Name, string? Good, string? Better, string? Best, Recurrence? Schedule, string? TodayChoice);
public sealed record ArchiveHabit(Guid MutationId, string? DeviceToday, string? TimeZone, string? TodayChoice);

public sealed class HabitChange
{
    private HabitChange() { }
    public Guid HabitId { get; private set; }
    public long Sequence { get; private set; }
    public Guid MutationId { get; private set; }
    public string Payload { get; private set; } = "";
    public HabitChangeKind Kind { get; private set; }
    public DateOnly EffectiveDate { get; private set; }
    public DateTimeOffset CommittedAt { get; private set; }
    public DateOnly? AdmissionThrough { get; private set; }
    public string? Name { get; private set; }
    public string? Good { get; private set; }
    public string? Better { get; private set; }
    public string? Best { get; private set; }
    public int[]? Weekdays { get; private set; }
    public int? RepeatEveryWeeks { get; private set; }
    public DateOnly? FirstWeekMonday { get; private set; }
    public TodayChoice? Choice { get; private set; }

    internal static HabitChange Baseline(Habit habit) => new()
    {
        HabitId = habit.Id,
        Sequence = 0,
        Kind = HabitChangeKind.Baseline,
        EffectiveDate = habit.Schedule.CreationDate,
        CommittedAt = habit.CreatedAt,
        Name = habit.Name,
        Good = habit.Levels.Good,
        Better = habit.Levels.Better,
        Best = habit.Levels.Best,
        Weekdays = habit.Schedule.Weekdays,
        RepeatEveryWeeks = habit.Schedule.RepeatEveryWeeks,
        FirstWeekMonday = habit.Schedule.FirstWeekMonday
    };

    internal static HabitChange Edit(Habit habit, long sequence, EditHabit input, DateOnly date,
        TodayChoice? choice, string payload, DateTimeOffset now) => new()
        {
            HabitId = habit.Id,
            Sequence = sequence,
            MutationId = input.MutationId,
            Payload = payload,
            Kind = HabitChangeKind.Edit,
            EffectiveDate = date,
            CommittedAt = now,
            AdmissionThrough = input.Schedule is null ? null : DeviceCalendar.AdmissionCutoff(now),
            Name = input.Name,
            Good = input.Good,
            Better = input.Better,
            Best = input.Best,
            Weekdays = input.Schedule?.Weekdays,
            RepeatEveryWeeks = input.Schedule?.RepeatEveryWeeks,
            FirstWeekMonday = input.Schedule is null ? null : Monday(date),
            Choice = choice
        };

    internal static HabitChange Archive(Habit habit, long sequence, ArchiveHabit input, DateOnly date,
        TodayChoice? choice, string payload, DateTimeOffset now) => new()
        {
            HabitId = habit.Id,
            Sequence = sequence,
            MutationId = input.MutationId,
            Payload = payload,
            Kind = HabitChangeKind.Archive,
            EffectiveDate = date,
            CommittedAt = now,
            AdmissionThrough = DeviceCalendar.AdmissionCutoff(now),
            Choice = choice
        };

    private static DateOnly Monday(DateOnly date) => date.AddDays(-(((int)date.DayOfWeek + 6) % 7));
}
