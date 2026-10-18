using System.Globalization;
using System.Security.Claims;
using Damadama.Habits;
using Microsoft.EntityFrameworkCore;

namespace Damadama.Entries;

public static class EntryEndpoints
{
    public static void MapEntries(this WebApplication app)
    {
        app.MapPut("/api/habits/{id:guid}/entries/{date}", SaveEntry).WithName("replace-entry")
            .WithMetadata(new ApiContractMetadata("resource")).RequireAuthorization();
        app.MapMethods("/api/habits/{id:guid}/entries/{date}", ["GET", "HEAD"], ReadEntry).WithName("read-entry")
            .WithMetadata(new ApiContractMetadata("resource")).RequireAuthorization();
        app.MapMethods("/api/entries", ["GET", "HEAD"], ReadEntries).WithName("entries-by-date")
            .WithMetadata(new ApiContractMetadata("resource")).RequireAuthorization();
    }

    private static async Task<IResult> SaveEntry(Guid id, string date, WriteEntry input,
        ClaimsPrincipal user, HabitsDb db, TimeProvider clock, ApiRepresentations representations, HttpResponse response, CancellationToken cancellationToken)
    {
        var owner = user.FindFirst("sub")!.Value;
        var habit = await db.Habits.AsNoTracking().Include(h => h.Schedule)
            .SingleOrDefaultAsync(h => h.Id == id && h.OwnerId == owner, cancellationToken);
        if (habit is null) return Results.NotFound();

        var edit = ReadEdit(date, input, clock);

        var retained = await db.Entries.AnyAsync(e => e.HabitId == id && e.CalendarDate == edit.CalendarDate,
            cancellationToken);
        if (!retained && !ScheduleEligibility.IsScheduled(habit.Schedule, edit.CalendarDate))
            throw new ArgumentException("This habit was not scheduled on that date.", nameof(date));

        var saved = await EntryStore.Save(db, habit, edit, cancellationToken);
        var representation = representations.Entry(saved.Entry, habit.Name);
        return saved switch
        {
            EntrySaveOutcome.Created => ApiRepresentations.Created(representation, response),
            EntrySaveOutcome.Accepted => ApiRepresentations.Ok(representation),
            EntrySaveOutcome.Superseded => Results.Problem(statusCode: 409, title: "A newer entry is saved.",
                detail: "Adopt the current entry; this edit was superseded.", extensions: new Dictionary<string, object?> { ["current"] = representation }),
            _ => throw new System.Diagnostics.UnreachableException()
        };
    }

    private static async Task<IResult> ReadEntries(string date, ClaimsPrincipal user, HabitsDb db, ApiRepresentations representations,
        CancellationToken cancellationToken)
    {
        var calendarDate = ParseDate(date, nameof(date));
        var owner = user.FindFirst("sub")!.Value;
        var entries = await (from entry in db.Entries.AsNoTracking()
                             join habit in db.Habits on entry.HabitId equals habit.Id
                             where habit.OwnerId == owner && entry.CalendarDate == calendarDate
                             orderby entry.HabitId
                             select new { Entry = entry, HabitName = habit.Name }).ToListAsync(cancellationToken);
        return ApiRepresentations.Ok(representations.Collection("entries", "entries-by-date",
            entries.Select(row => representations.Entry(row.Entry, row.HabitName)), new { date }));
    }

    private static async Task<IResult> ReadEntry(Guid id, string date, ClaimsPrincipal user, HabitsDb db,
        ApiRepresentations representations, CancellationToken cancellationToken)
    {
        var habit = await db.Habits.AsNoTracking().SingleOrDefaultAsync(
            habit => habit.Id == id && habit.OwnerId == user.FindFirst("sub")!.Value, cancellationToken);
        if (habit is null) return Results.NotFound();
        var calendarDate = ParseDate(date, nameof(date));
        var entry = await db.Entries.AsNoTracking().SingleOrDefaultAsync(
            entry => entry.HabitId == id && entry.CalendarDate == calendarDate, cancellationToken);
        return entry is null ? Results.NotFound() : ApiRepresentations.Ok(representations.Entry(entry, habit.Name));
    }

    private static DateOnly ParseDate(string? value, string field)
    {
        if (!DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
            throw new ArgumentException("Use a calendar date in YYYY-MM-DD format.", field);
        return date;
    }

    private static EntryEdit ReadEdit(string date, WriteEntry input, TimeProvider clock)
    {
        var calendarDate = ParseDate(date, nameof(date));
        var today = DeviceToday(input, clock);
        if (calendarDate > today)
            throw new ArgumentException("Choose today or a past scheduled date.", nameof(date));
        if (!Enum.TryParse<EntryResult>(input.Result, out var result) || !Enum.IsDefined(result) ||
            input.Result != result.ToString())
            throw new ArgumentException("Choose Good, Better, Best, Rest, or Clear.", nameof(input.Result));
        if (input.EditedAt is not { } editedAt)
            throw new ArgumentException("Include the edit timestamp.", nameof(input.EditedAt));
        return new EntryEdit(calendarDate, result, editedAt);
    }

    private static DateOnly DeviceToday(WriteEntry input, TimeProvider clock)
    {
        if (string.IsNullOrWhiteSpace(input.TimeZone) ||
            !TimeZoneInfo.TryFindSystemTimeZoneById(input.TimeZone, out var zone) ||
            !zone.HasIanaId && input.TimeZone != "UTC")
            throw new ArgumentException("Use a valid IANA timezone from your device.", nameof(input.TimeZone));
        var deviceToday = ParseDate(input.DeviceToday, nameof(input.DeviceToday));
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(clock.GetUtcNow(), zone).DateTime);
        if (deviceToday != today)
            throw new ArgumentException("Your device date has changed. Refresh and try again.", nameof(input.DeviceToday));
        return today;
    }
}
