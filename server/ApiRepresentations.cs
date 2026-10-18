using Damadama.Entries;
using Damadama.Habits;
using System.Text.Json.Serialization;

namespace Damadama;

public sealed record ApiContractMetadata(string Category);
public sealed record SirenLink(string[] Rel, string Href);
public sealed record SirenField(string Name, string Type = "text");
public sealed record SirenAction(string Name, string Method, string Href, string Type, SirenField[] Fields);
public sealed record SirenEntity(string[] Class, object Properties, SirenLink[] Links,
    SirenAction[] Actions, SirenEntity[] Entities)
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string[]? Rel { get; init; }
}

public sealed class ApiRepresentations(LinkGenerator links)
{
    public const string MediaType = "application/vnd.siren+json";

    public string Href(string name, object? values = null) =>
        links.GetPathByName(name, values) ?? throw new InvalidOperationException($"Missing endpoint {name}.");

    private SirenLink[] Links(string self) => [new(["self"], self), new(["profile"], Href("application-profile"))];

    private SirenAction Action(string name, string method, string[] fields, object? values = null) =>
        new(name, method, Href(name, values), method == "GET" ? "application/x-www-form-urlencoded" : "application/json",
            fields.Select(name => new SirenField(name)).ToArray());

    public SirenAction CreateHabit() => Action("create-habit", "POST",
        ["name", "good", "better", "best", "weekdays", "repeatEveryWeeks", "timeZone"]);

    public SirenAction ReplaceEntry(Guid id, DateOnly date) => Action("replace-entry", "PUT",
        ["result", "editedAt", "deviceToday", "timeZone"], new { id, date = date.ToString("yyyy-MM-dd") });

    public SirenEntity Bootstrap(string? clerkPublishableKey) => new(["application"], new { clerkPublishableKey },
        [.. Links(Href("application-config")), new(["https://github.com/ShiosOS/Damadama/rels/habits"], Href("list-habits"))],
        [CreateHabit(), Action("scheduled-habits", "GET", ["date"]), Action("entries-by-date", "GET", ["date"])], []);

    public SirenEntity Profile() => new(["profile"], new
    {
        title = "Damadama application protocol",
        version = 1,
        entry = "PUT replaces the complete writable state: result and editedAt. deviceToday and timeZone are validation context. habitId, habitName, calendarDate, good, better, best are read-only; levels snapshot the initial insertion.",
        ordering = "Greatest (editedAt UTC ticks, result rank) wins. Clear=0, Rest=1, Good=2, Better=3, Best=4. Clear remains a readable resource. Identical replay is accepted without rewriting the row.",
        conflict = "409 current contains the authoritative entry representation; adopt it without fetching or retrying the rejected candidate.",
        dates = "Calendar dates use YYYY-MM-DD. Entry dates must be scheduled or retained and no later than deviceToday. timeZone is an IANA identifier; deviceToday must match the current date there.",
        forms = "GET actions encode fields in the query. POST and PUT actions encode all advertised fields as JSON. create-habit weekdays is an integer ISO weekday array; repeatEveryWeeks is a positive integer. Other fields are strings.",
        relations = "self identifies the represented resource; profile describes this protocol; https://github.com/ShiosOS/Damadama/rels/habits identifies the habit collection; item identifies an embedded collection member. scheduled-habits and entries-by-date require date. Every scheduled habit and retained entry advertises replace-entry for that date.",
        statuses = "Creation is 201 with Location, accepted replacement/replay is 200, superseded replacement is 409. Errors use RFC 9457 application/problem+json. All API responses are private, no-store."
    }, Links(Href("application-profile")), [], []);

    public SirenEntity Habit(Habit habit, DateOnly? date = null) => new(["habit"], HabitResponse.From(habit),
        Links(Href("read-habit", new { id = habit.Id })),
        date is { } day ? [ReplaceEntry(habit.Id, day)] : [], []);

    public SirenEntity Entry(Entry entry, string habitName) => new(["entry"], EntryResponse.From(entry, habitName),
        Links(Href("read-entry", new { id = entry.HabitId, date = entry.CalendarDate.ToString("yyyy-MM-dd") })),
        [ReplaceEntry(entry.HabitId, entry.CalendarDate)], []);

    public SirenEntity Collection(string kind, string endpoint, IEnumerable<SirenEntity> entities, object? values = null) =>
        new([kind], new { }, Links(Href(endpoint, values)), kind == "habits" ? [CreateHabit()] : [],
            entities.Select(entity => entity with { Rel = ["item"] }).ToArray());

    public static IResult Ok(SirenEntity entity) => Results.Json(entity, contentType: MediaType);

    public static IResult Created(SirenEntity entity, HttpResponse response)
    {
        response.Headers.Location = entity.Links.Single(link => link.Rel.Contains("self")).Href;
        return Results.Json(entity, contentType: MediaType, statusCode: 201);
    }
}
