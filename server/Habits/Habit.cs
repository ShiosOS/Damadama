namespace Damadama.Habits;

public sealed record CreateHabit(string? Name, string? Good, string? Better, string? Best,
    int[]? Weekdays, int RepeatEveryWeeks, string? TimeZone);

public sealed class Habit
{
    private Habit() { }
    public Guid Id { get; private set; }
    public string OwnerId { get; private set; } = "";
    public string Name { get; private set; } = "";
    public string Good { get; private set; } = "";
    public string Better { get; private set; } = "";
    public string Best { get; private set; } = "";
    public DateTimeOffset CreatedAt { get; private set; }
    public InitialSchedule Schedule { get; private set; } = null!;

    public static Habit Create(CreateHabit input, string ownerId, DateTimeOffset now)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(input.Name, nameof(input.Name));
        ArgumentException.ThrowIfNullOrWhiteSpace(input.Good, nameof(input.Good));
        ArgumentException.ThrowIfNullOrWhiteSpace(input.Better, nameof(input.Better));
        ArgumentException.ThrowIfNullOrWhiteSpace(input.Best, nameof(input.Best));
        if (input.Weekdays is not { Length: > 0 } || input.Weekdays.Any(day => day is < 1 or > 7))
            throw new ArgumentException("Select at least one weekday from Monday to Sunday.", nameof(input.Weekdays));
        if (input.RepeatEveryWeeks <= 0)
            throw new ArgumentException("Repeat interval must be a positive number of weeks.", nameof(input.RepeatEveryWeeks));
        ArgumentException.ThrowIfNullOrWhiteSpace(input.TimeZone, nameof(input.TimeZone));
        TimeZoneInfo zone;
        try
        {
            zone = TimeZoneInfo.FindSystemTimeZoneById(input.TimeZone);
        }
        catch (TimeZoneNotFoundException)
        {
            throw new ArgumentException("Use a valid IANA timezone from your device.", nameof(input.TimeZone));
        }
        if (!zone.HasIanaId && input.TimeZone != "UTC")
            throw new ArgumentException("Use an IANA timezone from your device.", nameof(input.TimeZone));
        var id = Guid.NewGuid();
        return new Habit
        {
            Id = id,
            OwnerId = ownerId,
            Name = input.Name,
            Good = input.Good,
            Better = input.Better,
            Best = input.Best,
            CreatedAt = now.ToUniversalTime(),
            Schedule = new InitialSchedule(id, input.Weekdays.Distinct().Order().ToArray(), input.RepeatEveryWeeks, zone, now)
        };
    }
}

public sealed class InitialSchedule
{
    private InitialSchedule() { }
    internal InitialSchedule(Guid habitId, int[] weekdays, int repeatEveryWeeks, TimeZoneInfo zone, DateTimeOffset now)
    {
        HabitId = habitId;
        Weekdays = weekdays;
        RepeatEveryWeeks = repeatEveryWeeks;
        TimeZone = zone.Id;
        CreationDate = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, zone).DateTime);
        FirstWeekMonday = CreationDate.AddDays(-(((int)CreationDate.DayOfWeek + 6) % 7));
    }
    public Guid HabitId { get; private set; }
    public int[] Weekdays { get; private set; } = [];
    public int RepeatEveryWeeks { get; private set; }
    public string TimeZone { get; private set; } = "";
    public DateOnly CreationDate { get; private set; }
    public DateOnly FirstWeekMonday { get; private set; }
}
