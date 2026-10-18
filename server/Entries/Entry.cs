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

public sealed record EntryEdit(DateOnly CalendarDate, EntryResult Result, DateTimeOffset EditedAt);

public sealed class Entry
{
    private Entry() { }
    public Guid HabitId { get; private set; }
    public DateOnly CalendarDate { get; private set; }
    public EntryResult Result { get; private set; }
    public DateTimeOffset EditedAt { get; private set; }
    public HabitLevels OriginalLevels { get; private set; } = null!;
}
