using Damadama.Habits;
using NUnit.Framework;

namespace Damadama.Tests;

public class ScheduleEligibilityTests
{
    [TestCase("2026-10-12", false)]
    [TestCase("2026-10-14", true)]
    [TestCase("2026-10-15", false)]
    [TestCase("2026-10-18", true)]
    [TestCase("2026-10-19", false)]
    [TestCase("2026-10-25", false)]
    [TestCase("2026-10-26", true)]
    public void Uses_selected_ISO_weekdays_and_Monday_weeks_from_creation(string date, bool scheduled)
    {
        var habit = Habit.Create(HabitTests.Walking with { Weekdays = [1, 3, 7] }, "owner",
            DateTimeOffset.Parse("2026-10-14T12:00:00Z"));

        Assert.That(ScheduleEligibility.IsScheduled(habit.Schedule, DateOnly.Parse(date)), Is.EqualTo(scheduled));
    }

    [TestCase(1, "2026-10-12", "2026-10-13")]
    [TestCase(2, "2026-10-13", "2026-10-14")]
    [TestCase(3, "2026-10-14", "2026-10-15")]
    [TestCase(4, "2026-10-15", "2026-10-16")]
    [TestCase(5, "2026-10-16", "2026-10-17")]
    [TestCase(6, "2026-10-17", "2026-10-18")]
    [TestCase(7, "2026-10-18", "2026-10-19")]
    public void Recognizes_each_ISO_weekday_only_on_the_selected_day(int weekday, string selected, string unselected)
    {
        var habit = Habit.Create(HabitTests.Walking with { Weekdays = [weekday], RepeatEveryWeeks = 1 }, "owner",
            DateTimeOffset.Parse("2026-10-12T12:00:00Z"));

        Assert.Multiple(() =>
        {
            Assert.That(ScheduleEligibility.IsScheduled(habit.Schedule, DateOnly.Parse(selected)), Is.True);
            Assert.That(ScheduleEligibility.IsScheduled(habit.Schedule, DateOnly.Parse(unselected)), Is.False);
        });
    }

    [TestCase(1, "2026-10-19", true)]
    [TestCase(1, "2026-10-26", true)]
    [TestCase(3, "2026-10-19", false)]
    [TestCase(3, "2026-10-26", false)]
    [TestCase(3, "2026-11-02", true)]
    [TestCase(3, "2026-11-09", false)]
    public void Repeats_every_positive_number_of_Monday_weeks(int repeat, string date, bool scheduled)
    {
        var habit = Habit.Create(HabitTests.Walking with { Weekdays = [1], RepeatEveryWeeks = repeat }, "owner",
            DateTimeOffset.Parse("2026-10-12T12:00:00Z"));

        Assert.That(ScheduleEligibility.IsScheduled(habit.Schedule, DateOnly.Parse(date)), Is.EqualTo(scheduled));
    }

    [TestCase("2026-12-30T12:00:00Z", 2, "2027-01-03", true)]
    [TestCase("2026-12-30T12:00:00Z", 2, "2027-01-04", false)]
    [TestCase("2026-12-30T12:00:00Z", 2, "2027-01-11", true)]
    [TestCase("2028-02-23T12:00:00Z", 1, "2028-02-29", true)]
    [TestCase("2028-02-23T12:00:00Z", 3, "2028-02-29", false)]
    [TestCase("2028-02-23T12:00:00Z", 3, "2028-03-13", true)]
    public void Counts_calendar_weeks_across_year_and_leap_boundaries(string creationInstant, int repeat,
        string date, bool scheduled)
    {
        var habit = Habit.Create(HabitTests.Walking with { Weekdays = [1, 2, 3, 7], RepeatEveryWeeks = repeat }, "owner",
            DateTimeOffset.Parse(creationInstant));

        Assert.That(ScheduleEligibility.IsScheduled(habit.Schedule, DateOnly.Parse(date)), Is.EqualTo(scheduled));
    }

    [Test]
    public void Missed_dates_do_not_carry_forward_or_change_the_initial_schedule()
    {
        var habit = Habit.Create(HabitTests.Walking with { Weekdays = [1, 3, 7] }, "owner",
            DateTimeOffset.Parse("2026-10-14T12:00:00Z"));

        Assert.Multiple(() =>
        {
            Assert.That(ScheduleEligibility.IsScheduled(habit.Schedule, new DateOnly(2026, 10, 15)), Is.False);
            Assert.That(ScheduleEligibility.IsScheduled(habit.Schedule, new DateOnly(2026, 10, 14)), Is.True);
            Assert.That(ScheduleEligibility.IsScheduled(habit.Schedule, new DateOnly(2026, 10, 19)), Is.False);
            Assert.That(ScheduleEligibility.IsScheduled(habit.Schedule, new DateOnly(2026, 10, 26)), Is.True);
            Assert.That(habit.Schedule.CreationDate, Is.EqualTo(new DateOnly(2026, 10, 14)));
            Assert.That(habit.Schedule.FirstWeekMonday, Is.EqualTo(new DateOnly(2026, 10, 12)));
        });
    }
}
