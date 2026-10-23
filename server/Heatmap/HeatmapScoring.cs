using Damadama.Entries;
using Damadama.Habits;

namespace Damadama.Heatmap;

public sealed record HeatmapDate(DateOnly Date, int ScheduledCount, int EarnedPoints,
    int MaximumPoints, double? Completion);
public sealed record HeatmapResponse(DateOnly Start, DateOnly End, HeatmapDate[] Days);

public static class HeatmapScoring
{
    public static HeatmapResponse Calculate(OwnedHistoryRange history)
    {
        var scheduled = history.Records.Where(record => record.Scheduled).ToLookup(record => record.Date);
        var days = Enumerable.Range(0, history.Range.End.DayNumber - history.Range.Start.DayNumber + 1)
            .Select(offset =>
            {
                var date = history.Range.Start.AddDays(offset);
                var records = scheduled[date].ToArray();
                var earned = records.Sum(record => Points(record.Result));
                var maximum = records.Length * 3;
                return new HeatmapDate(date, records.Length, earned, maximum,
                    maximum == 0 ? null : (double)earned / maximum);
            }).ToArray();
        return new HeatmapResponse(history.Range.Start, history.Range.End, days);
    }

    private static int Points(EntryResult? result) => result switch
    {
        EntryResult.Good => 1,
        EntryResult.Better => 2,
        EntryResult.Best => 3,
        EntryResult.Rest or EntryResult.Clear or null => 0,
        _ => throw new ArgumentOutOfRangeException(nameof(result))
    };
}
