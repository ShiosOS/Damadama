using System.Globalization;
using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Damadama.Habits;

public static class HabitEndpoints
{
    public static void MapHabits(this WebApplication app)
    {
        app.MapPost("/api/habits", Create).WithName("create-habit").WithTags("Habits")
            .WithSummary("Create a habit and its initial schedule")
            .Produces<HabitResponse>(201).ProducesProblem(400).ProducesProblem(401)
            .ProducesProblem(415).ProducesProblem(503).RequireAuthorization();
        app.MapGet("/api/habits", List).WithName("list-habits").WithTags("Habits")
            .WithSummary("List habits, optionally scheduled on a calendar date")
            .Produces<HabitResponse[]>().ProducesProblem(400).ProducesProblem(401)
            .ProducesProblem(503).RequireAuthorization();
        app.MapGet("/api/habit-days/{date}", ReadDay).WithName("habit-day").WithTags("Habits")
            .WithSummary("Read scheduled habits and retained entries in one calendar-day snapshot")
            .Produces<HabitDayResponse>().ProducesProblem(400).ProducesProblem(401)
            .ProducesProblem(503).RequireAuthorization();
        app.MapGet("/api/habits/{id:guid}", Read).WithName("read-habit").WithTags("Habits")
            .WithSummary("Read an owned habit")
            .Produces<HabitResponse>().ProducesProblem(400).ProducesProblem(401)
            .ProducesProblem(404).ProducesProblem(503).RequireAuthorization();
        app.MapPatch("/api/habits/{id:guid}", Edit).WithName("edit-habit").WithTags("Habits")
            .WithSummary("Edit an owned habit while preserving its dated history")
            .Produces<HabitResponse>().Produces<HabitMutationProblem>(409, "application/problem+json")
            .ProducesProblem(400).ProducesProblem(401).ProducesProblem(404)
            .ProducesProblem(415).ProducesProblem(503).RequireAuthorization();
        app.MapPost("/api/habits/{id:guid}/archives", Archive).WithName("archive-habit").WithTags("Habits")
            .WithSummary("Stop scheduling an owned habit while retaining its entries")
            .Produces<HabitResponse>().Produces<HabitMutationProblem>(409, "application/problem+json")
            .ProducesProblem(400).ProducesProblem(401).ProducesProblem(404)
            .ProducesProblem(415).ProducesProblem(503).RequireAuthorization();
    }

    private static async Task<IResult> Create(CreateHabit input, ClaimsPrincipal user,
        HabitsDb db, TimeProvider clock, ILogger<HabitsDb> logger, CancellationToken cancellationToken)
    {
        var habit = await db.Create(input, user.FindFirst("sub")!.Value, clock, cancellationToken);
        logger.LogInformation("Habit {HabitId} committed for account {OwnerId}", habit.Id, habit.OwnerId);
        return TypedResults.Created($"/api/habits/{habit.Id}", HabitResponse.From(habit));
    }

    private static async Task<IResult> List([FromQuery] string? scheduledOn, HttpRequest request,
        ClaimsPrincipal user, HabitHistory history, CancellationToken cancellationToken)
    {
        DateOnly? filter = null;
        if (request.Query.ContainsKey("scheduledOn"))
        {
            if (request.Query["scheduledOn"].Count != 1 ||
                !DateOnly.TryParseExact(scheduledOn, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
                return Results.ValidationProblem(new Dictionary<string, string[]>
                {
                    ["scheduledOn"] = ["Use one valid calendar date in YYYY-MM-DD format."]
                }, title: "Check the requested date.");
            filter = date;
        }
        return TypedResults.Ok(await history.ReadHabits(user.FindFirst("sub")!.Value, filter, null, cancellationToken));
    }

    private static async Task<IResult> Read(Guid id, ClaimsPrincipal user, HabitHistory history, CancellationToken cancellationToken)
    {
        var habits = await history.ReadHabits(user.FindFirst("sub")!.Value, null, id, cancellationToken);
        return habits.Length == 0 ? Results.NotFound() : TypedResults.Ok(habits[0]);
    }

    private static async Task<IResult> ReadDay(string date, ClaimsPrincipal user, HabitHistory history,
        CancellationToken cancellationToken) => TypedResults.Ok(await history.ReadDay(
            user.FindFirst("sub")!.Value, DeviceCalendar.ParseDate(date, nameof(date)), cancellationToken));

    private static async Task<IResult> Edit(Guid id, EditHabit input, ClaimsPrincipal user,
        HabitHistory history, CancellationToken cancellationToken) =>
        MutationResult(await history.Edit(id, user.FindFirst("sub")!.Value, input, cancellationToken));

    private static async Task<IResult> Archive(Guid id, ArchiveHabit input, ClaimsPrincipal user,
        HabitHistory history, CancellationToken cancellationToken) =>
        MutationResult(await history.Archive(id, user.FindFirst("sub")!.Value, input, cancellationToken));

    private static IResult MutationResult(HabitMutationOutcome outcome) => outcome switch
    {
        HabitMutationOutcome.Accepted accepted => TypedResults.Ok(accepted.Habit),
        HabitMutationOutcome.Missing => Results.NotFound(),
        HabitMutationOutcome.Conflict conflict => TypedResults.Problem(new HabitMutationProblem
        {
            Status = 409,
            Title = "The habit change needs attention.",
            Code = conflict.Code,
            Detail = conflict.Code == "today_choice_required"
                ? "This habit has an entry today. Choose whether to keep or remove today from the schedule."
                : "This mutation identifier already belongs to a different change."
        }),
        _ => throw new System.Diagnostics.UnreachableException()
    };
}
