using Damadama.Habits;

namespace Damadama.Entries;

public enum EntryResult
{
    Clear = 0,
    Rest = 1,
    Good = 2,
    Better = 3,
    Best = 4
}

public sealed record EntryEdit(DateOnly CalendarDate, EntryResult Result, DateTimeOffset EditedAt)
{
    internal static EntryEdit Parse(string date, WriteEntry input, TimeProvider clock)
    {
        var calendarDate = DeviceCalendar.ParseDate(date, nameof(date));
        var today = DeviceCalendar.Today(input.DeviceToday, input.TimeZone, clock);
        if (calendarDate > today)
            throw new ArgumentException("Choose today or a past scheduled date.", nameof(date));
        if (!Enum.TryParse<EntryResult>(input.Result, out var result) || !Enum.IsDefined(result) ||
            input.Result != result.ToString())
            throw new ArgumentException("Choose Good, Better, Best, Rest, or Clear.", nameof(input.Result));
        if (input.EditedAt is not { } editedAt)
            throw new ArgumentException("Include the edit timestamp.", nameof(input.EditedAt));
        return new EntryEdit(calendarDate, result, editedAt);
    }
}

public sealed class Entry
{
    private Entry() { }
    public Guid HabitId { get; private set; }
    public DateOnly CalendarDate { get; private set; }
    public EntryResult Result { get; private set; }
    public DateTimeOffset EditedAt { get; private set; }
    public HabitLevels OriginalLevels { get; private set; } = null!;
}
