using Damadama.Entries;
using Damadama.Habits;
using Damadama.Heatmap;
using NUnit.Framework;

namespace Damadama.Tests;

public class HeatmapTests
{
    private static readonly DateOnly Today = new(2026, 10, 21);

    [Test]
    public void Good_Better_Best_and_Rest_earn_six_of_twelve_points()
    {
        var history = History(
            Record(EntryResult.Good), Record(EntryResult.Better),
            Record(EntryResult.Best), Record(EntryResult.Rest));

        var day = HeatmapScoring.Calculate(history).Days.Single();

        Assert.Multiple(() =>
        {
            Assert.That(day.ScheduledCount, Is.EqualTo(4));
            Assert.That(day.EarnedPoints, Is.EqualTo(6));
            Assert.That(day.MaximumPoints, Is.EqualTo(12));
            Assert.That(day.Completion, Is.EqualTo(0.5));
        });
    }

    [TestCase(EntryResult.Good, 1)]
    [TestCase(EntryResult.Better, 2)]
    [TestCase(EntryResult.Best, 3)]
    [TestCase(EntryResult.Rest, 0)]
    [TestCase(EntryResult.Clear, 0)]
    [TestCase(null, 0)]
    public void Every_scheduled_habit_counts_toward_the_maximum(EntryResult? result, int points)
    {
        var day = HeatmapScoring.Calculate(History(Record(result))).Days.Single();

        Assert.Multiple(() =>
        {
            Assert.That(day.ScheduledCount, Is.EqualTo(1));
            Assert.That(day.EarnedPoints, Is.EqualTo(points));
            Assert.That(day.MaximumPoints, Is.EqualTo(3));
            Assert.That(day.Completion, Is.EqualTo((double)points / 3));
        });
    }

    [Test]
    public void Excluded_retained_entries_add_neither_points_nor_maximum()
    {
        var excluded = Record(EntryResult.Best) with { Scheduled = false };
        var day = HeatmapScoring.Calculate(History(Record(EntryResult.Good), excluded)).Days.Single();

        Assert.Multiple(() =>
        {
            Assert.That(day.ScheduledCount, Is.EqualTo(1));
            Assert.That(day.EarnedPoints, Is.EqualTo(1));
            Assert.That(day.MaximumPoints, Is.EqualTo(3));
        });
    }

    [Test]
    public void Dates_with_no_scheduled_habits_have_no_completion_percentage()
    {
        var day = HeatmapScoring.Calculate(History(Record(EntryResult.Best) with { Scheduled = false }))
            .Days.Single();

        Assert.Multiple(() =>
        {
            Assert.That(day.EarnedPoints, Is.Zero);
            Assert.That(day.MaximumPoints, Is.Zero);
            Assert.That(day.ScheduledCount, Is.Zero);
            Assert.That(day.Completion, Is.Null);
        });
    }

    [TestCase("2024-03-01", "2023-03-03")]
    [TestCase("2026-01-01", "2025-01-02")]
    [TestCase("2026-10-21", "2025-10-22")]
    public void A_year_is_365_ascending_calendar_dates_including_today(string endText, string startText)
    {
        var end = DateOnly.ParseExact(endText, "yyyy-MM-dd");
        var start = DateOnly.ParseExact(startText, "yyyy-MM-dd");
        var history = new OwnedHistoryRange(new InclusiveDateRange(start, end), []);

        var response = HeatmapScoring.Calculate(history);

        Assert.Multiple(() =>
        {
            Assert.That(response.Start, Is.EqualTo(start));
            Assert.That(response.End, Is.EqualTo(end));
            Assert.That(response.Days.Select(day => day.Date),
                Is.EqualTo(Enumerable.Range(0, 365).Select(start.AddDays)));
            Assert.That(response.Days.All(day => day.Completion is null), Is.True);
        });
    }

    [Test]
    public void Results_stay_on_their_saved_date_and_outside_records_do_not_leak_into_the_range()
    {
        var yesterday = Today.AddDays(-1);
        var history = new OwnedHistoryRange(new InclusiveDateRange(yesterday, Today),
            [Record(EntryResult.Best) with { Date = yesterday }, Record(EntryResult.Better),
                Record(EntryResult.Best) with { Date = Today.AddDays(-2) }]);

        var days = HeatmapScoring.Calculate(history).Days;

        Assert.That(days.Select(day => day.EarnedPoints), Is.EqualTo(new[] { 3, 2 }));
        Assert.That(days.Select(day => day.MaximumPoints), Is.EqualTo(new[] { 3, 3 }));
    }

    private static HistoryDate Record(EntryResult? result) => new(Guid.NewGuid(), Today, true, result);
    private static OwnedHistoryRange History(params HistoryDate[] records) =>
        new(new InclusiveDateRange(Today, Today), records);
}
