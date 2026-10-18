namespace Damadama.Entries;

public sealed record WriteEntry(string? Result, DateTimeOffset? EditedAt, string? DeviceToday, string? TimeZone);

public sealed record EntryResponse(Guid HabitId, string HabitName, DateOnly CalendarDate, string Result, DateTimeOffset EditedAt,
    string Good, string Better, string Best)
{
    public static EntryResponse From(Entry entry, string habitName) => new(entry.HabitId, habitName, entry.CalendarDate,
        entry.Result.ToString(), entry.EditedAt, entry.OriginalLevels.Good, entry.OriginalLevels.Better,
        entry.OriginalLevels.Best);
}

public sealed class EntryConflictProblem : Microsoft.AspNetCore.Mvc.ProblemDetails
{
    public required EntryResponse Current { get; init; }
}
