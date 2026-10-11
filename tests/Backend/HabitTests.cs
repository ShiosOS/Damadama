using Damadama.Habits;
using NUnit.Framework;

namespace Damadama.Tests;

public class HabitTests
{
    [TestCase(null)]
    [TestCase("")]
    [TestCase("   ")]
    public void Requires_nonblank_name_and_all_definitions(string? empty)
    {
        foreach (var input in new[] { Walking with { Name = empty }, Walking with { Good = empty },
                     Walking with { Better = empty }, Walking with { Best = empty } })
            Assert.That(() => Habit.Create(input, "owner", DateTimeOffset.UtcNow), Throws.InstanceOf<ArgumentException>());
    }

    [TestCase(null)]
    [TestCase(new int[] { })]
    [TestCase(new[] { 0 })]
    [TestCase(new[] { 8 })]
    public void Requires_selected_ISO_weekdays(int[]? weekdays) =>
        Assert.That(() => Habit.Create(Walking with { Weekdays = weekdays }, "owner", DateTimeOffset.UtcNow),
            Throws.ArgumentException);

    [TestCase(0)]
    [TestCase(-1)]
    public void Requires_positive_repeat_interval(int interval) =>
        Assert.That(() => Habit.Create(Walking with { RepeatEveryWeeks = interval }, "owner", DateTimeOffset.UtcNow),
            Throws.InstanceOf<ArgumentException>());

    [TestCase(null)]
    [TestCase("")]
    [TestCase("Not/AZone")]
    [TestCase("Eastern Standard Time")]
    public void Requires_browser_IANA_timezone(string? zone) =>
        Assert.That(() => Habit.Create(Walking with { TimeZone = zone }, "owner", DateTimeOffset.UtcNow),
            Throws.InstanceOf<ArgumentException>());
    public static CreateHabit Walking => new("Walking", "5 minutes", "15 minutes", "30 minutes",
        [1, 3], 2, "America/New_York");

    [Test]
    public void Creates_named_habit_with_definitions_and_selected_weekdays()
    {
        var habit = Habit.Create(Walking, "owner", DateTimeOffset.Parse("2026-01-05T15:00:00Z"));
        Assert.Multiple(() =>
        {
            Assert.That(habit.Name, Is.EqualTo("Walking"));
            Assert.That(habit.Good, Is.EqualTo("5 minutes"));
            Assert.That(habit.Better, Is.EqualTo("15 minutes"));
            Assert.That(habit.Best, Is.EqualTo("30 minutes"));
            Assert.That(habit.Schedule.Weekdays, Is.EqualTo(new[] { 1, 3 }));
            Assert.That(habit.Schedule.RepeatEveryWeeks, Is.EqualTo(2));
        });
    }

    [TestCase("2026-01-05T02:00:00Z", "America/New_York", "2026-01-04", "2025-12-29")]
    [TestCase("2026-01-04T16:00:00Z", "Asia/Tokyo", "2026-01-05", "2026-01-05")]
    [TestCase("2026-01-01T02:00:00Z", "America/Los_Angeles", "2025-12-31", "2025-12-29")]
    public void Preserves_device_calendar_date_and_Monday_anchor(string instant, string zone, string date, string monday)
    {
        var habit = Habit.Create(Walking with { TimeZone = zone }, "owner", DateTimeOffset.Parse(instant));
        Assert.Multiple(() =>
        {
            Assert.That(habit.Schedule.CreationDate, Is.EqualTo(DateOnly.Parse(date)));
            Assert.That(habit.Schedule.FirstWeekMonday, Is.EqualTo(DateOnly.Parse(monday)));
            Assert.That(habit.Schedule.TimeZone, Is.EqualTo(zone));
        });
    }
}
