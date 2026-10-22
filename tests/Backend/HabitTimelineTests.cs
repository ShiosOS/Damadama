using Damadama.Habits;
using NUnit.Framework;

namespace Damadama.Tests;

public class HabitTimelineTests
{
    private static readonly DateTimeOffset Instant = DateTimeOffset.Parse("2026-10-14T12:00:00Z");
    private static Habit Create() => Habit.Create(new("Walking", "5 minutes", "15 minutes", "30 minutes",
        [1, 3, 7], 2, "UTC"), "owner", Instant);

    [TestCase("2026-10-12", false)]
    [TestCase("2026-10-14", true)]
    [TestCase("2026-10-18", true)]
    [TestCase("2026-10-19", false)]
    [TestCase("2026-10-26", true)]
    public void Unchanged_history_uses_creation_and_Monday_anchor(string day, bool scheduled)
    {
        var timeline = new HabitTimeline(Create(), []);
        Assert.That(timeline.IsScheduled(DateOnly.Parse(day)), Is.EqualTo(scheduled));
    }

    [Test]
    public void Schedule_edit_preserves_past_and_restarts_repeat_weeks()
    {
        var habit = Create();
        var edit = Edit(habit, 1, "2026-10-19", [1, 7], 2);
        var timeline = new HabitTimeline(habit, [HabitChange.Baseline(habit), edit]);
        Assert.Multiple(() =>
        {
            Assert.That(timeline.IsScheduled(new(2026, 10, 18)), Is.True);
            Assert.That(timeline.IsScheduled(new(2026, 10, 19)), Is.True);
            Assert.That(timeline.IsScheduled(new(2026, 10, 25)), Is.True);
            Assert.That(timeline.IsScheduled(new(2026, 10, 26)), Is.False);
            Assert.That(timeline.CurrentSchedule.FirstWeekMonday, Is.EqualTo(new DateOnly(2026, 10, 19)));
            Assert.That(habit.Schedule.FirstWeekMonday, Is.EqualTo(new DateOnly(2026, 10, 12)));
        });
    }

    [Test]
    public void Later_commit_from_an_earlier_travel_date_supersedes_later_calendar_rules()
    {
        var habit = Create();
        var timeline = new HabitTimeline(habit, [HabitChange.Baseline(habit),
            Edit(habit, 1, "2026-10-20", [2], 1), Edit(habit, 2, "2026-10-19", [3], 1)]);
        Assert.Multiple(() =>
        {
            Assert.That(timeline.IsScheduled(new(2026, 10, 18)), Is.True);
            Assert.That(timeline.IsScheduled(new(2026, 10, 20)), Is.False);
            Assert.That(timeline.IsScheduled(new(2026, 10, 21)), Is.True);
        });
    }

    [TestCase(TodayChoice.Keep, true)]
    [TestCase(TodayChoice.Remove, false)]
    public void Archive_choice_changes_only_today_and_retains_finite_pending_eligibility(TodayChoice choice, bool included)
    {
        var habit = Create();
        var input = new ArchiveHabit(Guid.NewGuid(), "2026-10-14", "UTC", choice.ToString());
        var archive = HabitChange.Archive(habit, 1, input, new(2026, 10, 14), choice, "payload", Instant);
        var timeline = new HabitTimeline(habit, [HabitChange.Baseline(habit), archive]);
        Assert.Multiple(() =>
        {
            Assert.That(timeline.Archived, Is.True);
            Assert.That(timeline.IsScheduled(new(2026, 10, 14)), Is.EqualTo(included));
            Assert.That(timeline.IsScheduled(new(2026, 10, 18)), Is.False);
            Assert.That(timeline.CanStartEntry(new(2026, 10, 14)), Is.True);
            Assert.That(timeline.CanStartEntry(new(2026, 10, 18)), Is.False);
            Assert.That(timeline.CanStartEntry(new(2026, 10, 13)), Is.False);
        });
    }

    [Test]
    public void Pending_entry_from_a_device_ahead_of_the_archive_day_remains_eligible()
    {
        var now = DateTimeOffset.Parse("2026-10-18T23:30:00Z");
        var habit = Habit.Create(new("Walking", "5", "15", "30", [1, 7], 1, "UTC"), "owner", Instant);
        var archive = HabitChange.Archive(habit, 1, new(Guid.NewGuid(), "2026-10-18", "UTC", null),
            new(2026, 10, 18), null, "payload", now);
        var timeline = new HabitTimeline(habit, [HabitChange.Baseline(habit), archive]);
        Assert.Multiple(() =>
        {
            Assert.That(timeline.CanStartEntry(new(2026, 10, 19)), Is.True);
            Assert.That(timeline.IsScheduled(new(2026, 10, 19)), Is.False);
            Assert.That(timeline.CanStartEntry(new(2026, 10, 25)), Is.False);
        });
    }

    [Test]
    public void Definition_only_edits_and_repeated_archives_do_not_restore_membership()
    {
        var habit = Create();
        var day = new DateOnly(2026, 10, 14);
        var archive = HabitChange.Archive(habit, 1, new(Guid.NewGuid(), "2026-10-14", "UTC", "Remove"), day,
            TodayChoice.Remove, "first", Instant);
        var details = HabitChange.Edit(habit, 2, new(Guid.NewGuid(), "2026-10-14", "UTC", "New", "10", "20", "30", null, null),
            day, null, "second", Instant);
        var repeated = HabitChange.Archive(habit, 3, new(Guid.NewGuid(), "2026-10-18", "UTC", null),
            new(2026, 10, 18), null, "third", Instant.AddDays(4));
        var timeline = new HabitTimeline(habit, [HabitChange.Baseline(habit), archive, details, repeated]);
        Assert.That(timeline.IsScheduled(day), Is.False);
        Assert.That(timeline.IsScheduled(new(2026, 10, 26)), Is.False);
    }

    [TestCase(TodayChoice.Remove, false)]
    [TestCase(TodayChoice.Keep, true)]
    public void Explicit_date_choice_survives_a_later_recurrence_edit_from_an_earlier_travel_date(TodayChoice choice, bool scheduled)
    {
        var now = DateTimeOffset.Parse("2026-10-21T00:30:00Z");
        var habit = Create();
        var tokyo = HabitChange.Edit(habit, 1,
            new(Guid.NewGuid(), "2026-10-21", "Asia/Tokyo", "Walking", "5", "15", "30", new([2], 1), choice.ToString()),
            new(2026, 10, 21), choice, "tokyo", now);
        int[] nextDays = choice == TodayChoice.Remove ? [1, 2, 3, 4, 5, 6, 7] : [2];
        var losAngeles = HabitChange.Edit(habit, 2,
            new(Guid.NewGuid(), "2026-10-20", "America/Los_Angeles", "Walking", "5", "15", "30", new(nextDays, 1), null),
            new(2026, 10, 20), null, "los-angeles", now);
        var timeline = new HabitTimeline(habit, [HabitChange.Baseline(habit), tokyo, losAngeles]);
        Assert.That(timeline.IsScheduled(new(2026, 10, 21)), Is.EqualTo(scheduled));
    }

    private static HabitChange Edit(Habit habit, long sequence, string date, int[] days, int weeks) =>
        HabitChange.Edit(habit, sequence, new(Guid.NewGuid(), date, "UTC", "Walking", "5", "15", "30",
            new(days, weeks), null), DateOnly.Parse(date), null, "payload", DateTimeOffset.Parse(date + "T12:00:00Z"));
}
