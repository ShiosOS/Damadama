using System.Globalization;
using System.Security.Claims;
using Damadama.Habits;
using Microsoft.EntityFrameworkCore;

namespace Damadama.Entries;

public static class EntryEndpoints
{
    public static void MapEntries(this WebApplication app)
    {
        app.MapPut("/api/habits/{id:guid}/entries/{date}", SaveEntry).WithName("replace-entry").WithTags("Entries")
            .WithSummary("Create or replace a dated entry with conflict resolution")
            .Produces<EntryResponse>().Produces<EntryResponse>(201)
            .Produces<EntryConflictProblem>(409, "application/problem+json")
            .ProducesProblem(400).ProducesProblem(401).ProducesProblem(404)
            .ProducesProblem(415).ProducesProblem(503).RequireAuthorization();
        app.MapGet("/api/habits/{id:guid}/entries/{date}", ReadEntry).WithName("read-entry").WithTags("Entries")
            .WithSummary("Read the retained entry, including a cleared entry")
            .Produces<EntryResponse>().ProducesProblem(400).ProducesProblem(401)
            .ProducesProblem(404).ProducesProblem(503).RequireAuthorization();
        app.MapGet("/api/entries", ReadEntries).WithName("entries-by-date").WithTags("Entries")
            .WithSummary("List retained entries on a calendar date")
            .Produces<EntryResponse[]>().ProducesProblem(400).ProducesProblem(401)
            .ProducesProblem(503).RequireAuthorization();
    }
    private static async Task<IResult> SaveEntry(Guid id, string date, WriteEntry input,
        ClaimsPrincipal user, HabitHistory history, CancellationToken cancellationToken)
    {
        var owner = user.FindFirst("sub")!.Value;
        var result = await history.SaveEntry(id, owner, date, input, cancellationToken);
        if (result is null) return Results.NotFound();
        var saved = result.Value.Outcome;
        var representation = EntryResponse.From(saved.Entry, result.Value.HabitName);
        return saved switch
        {
            EntrySaveOutcome.Created => TypedResults.Created($"/api/habits/{id}/entries/{date}", representation),
            EntrySaveOutcome.Accepted => TypedResults.Ok(representation),
            EntrySaveOutcome.Superseded => TypedResults.Problem(new EntryConflictProblem { Status = 409, Title = "A newer entry is saved.", Detail = "Adopt the current entry; this edit was superseded.", Current = representation }),
            _ => throw new System.Diagnostics.UnreachableException()
        };
    }

    private static async Task<IResult> ReadEntries(string date, ClaimsPrincipal user, HabitsDb db,
        CancellationToken cancellationToken)
    {
        var calendarDate = ParseDate(date, nameof(date));
        var owner = user.FindFirst("sub")!.Value;
        var entries = await (from entry in db.Entries.AsNoTracking()
                             join habit in db.Habits on entry.HabitId equals habit.Id
                             where habit.OwnerId == owner && entry.CalendarDate == calendarDate
                             orderby entry.HabitId
                             select new { Entry = entry, HabitName = habit.Name }).ToListAsync(cancellationToken);
        return TypedResults.Ok(entries.Select(row => EntryResponse.From(row.Entry, row.HabitName)).ToArray());
    }

    private static async Task<IResult> ReadEntry(Guid id, string date, ClaimsPrincipal user, HabitsDb db,
        CancellationToken cancellationToken)
    {
        var habit = await db.Habits.AsNoTracking().SingleOrDefaultAsync(
            habit => habit.Id == id && habit.OwnerId == user.FindFirst("sub")!.Value, cancellationToken);
        if (habit is null) return Results.NotFound();
        var calendarDate = ParseDate(date, nameof(date));
        var entry = await db.Entries.AsNoTracking().SingleOrDefaultAsync(
            entry => entry.HabitId == id && entry.CalendarDate == calendarDate, cancellationToken);
        return entry is null ? Results.NotFound() : TypedResults.Ok(EntryResponse.From(entry, habit.Name));
    }

    private static DateOnly ParseDate(string? value, string field)
    {
        if (!DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
            throw new ArgumentException("Use a calendar date in YYYY-MM-DD format.", field);
        return date;
    }

    internal static EntryEdit ReadEdit(string date, WriteEntry input, TimeProvider clock)
    {
        var calendarDate = ParseDate(date, nameof(date));
        var today = DeviceCalendar.Today(input.DeviceToday, input.TimeZone, clock);
        if (calendarDate > today)
            throw new ArgumentException("Choose today or a past scheduled date.", nameof(date));
        if (!Enum.TryParse<EntryResult>(input.Result, out var result) || !Enum.IsDefined(result) ||
            input.Result != result.ToString())
            throw new ArgumentException("Choose Good, Better, Best, Rest, or Clear.", nameof(input.Result));
        if (input.EditedAt is not { } editedAt)
            throw new ArgumentException("Include the edit timestamp.", nameof(input.EditedAt));
        return new EntryEdit(calendarDate, result, editedAt);
    }

}
