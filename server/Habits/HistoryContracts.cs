using Damadama.Entries;

namespace Damadama.Habits;

public sealed record InclusiveDateRange
{
    public InclusiveDateRange(DateOnly start, DateOnly end)
    {
        if (end < start || end.DayNumber - start.DayNumber >= 365)
            throw new ArgumentException("Choose between one and 365 inclusive calendar dates.", nameof(end));
        Start = start;
        End = end;
    }

    public DateOnly Start { get; }
    public DateOnly End { get; }
}

public sealed record HistoryDate(Guid HabitId, DateOnly Date, bool Scheduled, EntryResult? Result);
public sealed record OwnedHistoryRange(InclusiveDateRange Range, IReadOnlyList<HistoryDate> Records);

public interface IHistoryReader
{
    Task<OwnedHistoryRange> ReadOwnedRange(string ownerId, InclusiveDateRange range, CancellationToken ct);
}
