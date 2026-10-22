using System.Globalization;

namespace Damadama.Habits;

public static class DeviceCalendar
{
    public static DateOnly ParseDate(string? value, string field)
    {
        if (!DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
            throw new ArgumentException("Use a calendar date in YYYY-MM-DD format.", field);
        return date;
    }

    public static DateOnly Today(string? deviceToday, string? timeZone, TimeProvider clock)
    {
        if (string.IsNullOrWhiteSpace(timeZone) ||
            !TimeZoneInfo.TryFindSystemTimeZoneById(timeZone, out var zone) ||
            !zone.HasIanaId && timeZone != "UTC")
            throw new ArgumentException("Use a valid IANA timezone from your device.", nameof(timeZone));
        var submitted = ParseDate(deviceToday, nameof(deviceToday));
        var current = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(clock.GetUtcNow(), zone).DateTime);
        if (submitted != current)
            throw new ArgumentException("Your device date has changed. Refresh and try again.", nameof(deviceToday));
        return submitted;
    }

    internal static DateOnly AdmissionCutoff(DateTimeOffset instant) =>
        DateOnly.FromDateTime(instant.ToOffset(TimeSpan.FromHours(14)).DateTime);
}
