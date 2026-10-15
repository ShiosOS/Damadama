namespace Damadama.Habits;

public static class ScheduleEligibility
{
    public static bool IsScheduled(InitialSchedule schedule, DateOnly date)
    {
        if (date < schedule.CreationDate) return false;

        var weekday = date.DayOfWeek == DayOfWeek.Sunday ? (int)IsoWeekday.Sunday : (int)date.DayOfWeek;
        if (!schedule.Weekdays.Contains(weekday)) return false;

        var weeksSinceFirstMonday = (date.DayNumber - schedule.FirstWeekMonday.DayNumber) / 7;
        return weeksSinceFirstMonday % schedule.RepeatEveryWeeks == 0;
    }
}
