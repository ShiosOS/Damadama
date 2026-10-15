using Damadama.Habits;
using NUnit.Framework;
using Reqnroll;

namespace Damadama.Tests;

[Binding]
public sealed class ScheduleEligibilitySteps
{
    private InitialSchedule schedule = null!;
    private bool scheduled;

    [Given("a habit created on {string} with ISO weekdays {string} every {int} weeks")]
    public void CreateSchedule(string creationDate, string weekdays, int repeat)
    {
        var input = HabitTests.Walking with
        {
            Weekdays = weekdays.Split(',').Select(int.Parse).ToArray(),
            RepeatEveryWeeks = repeat
        };
        schedule = Habit.Create(input, "owner", DateTimeOffset.Parse($"{creationDate}T12:00:00Z")).Schedule;
        Assert.That(schedule.CreationDate, Is.EqualTo(DateOnly.Parse(creationDate)));
        Assert.That(schedule.FirstWeekMonday, Is.EqualTo(new DateOnly(2026, 10, 12)));
    }

    [When("eligibility is requested for {string}")]
    public void RequestDate(string date) => scheduled = ScheduleEligibility.IsScheduled(schedule, DateOnly.Parse(date));

    [Then("the scheduled result is {word}")]
    public void AssertScheduled(string expected) => Assert.That(scheduled, Is.EqualTo(bool.Parse(expected)));
}
