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
        app.MapGet("/api/habits/{id:guid}", Read).WithName("read-habit").WithTags("Habits")
            .WithSummary("Read an owned habit")
            .Produces<HabitResponse>().ProducesProblem(400).ProducesProblem(401)
            .ProducesProblem(404).ProducesProblem(503).RequireAuthorization();
    }

    private static async Task<IResult> Create(CreateHabit input, ClaimsPrincipal user,
        HabitsDb db, TimeProvider clock, ILogger<HabitsDb> logger, CancellationToken cancellationToken)
    {
        var habit = await db.Create(input, user.FindFirst("sub")!.Value, clock, cancellationToken);
        logger.LogInformation("Habit {HabitId} committed for account {OwnerId}", habit.Id, habit.OwnerId);
        return TypedResults.Created($"/api/habits/{habit.Id}", HabitResponse.From(habit));
    }

    private static async Task<IResult> List([FromQuery] string? scheduledOn, HttpRequest request,
        ClaimsPrincipal user, HabitsDb db, CancellationToken cancellationToken)
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
        var habits = await db.Habits.AsNoTracking().Include(habit => habit.Schedule)
            .Where(habit => habit.OwnerId == user.FindFirst("sub")!.Value)
            .OrderBy(habit => habit.CreatedAt).ThenBy(habit => habit.Id).ToListAsync(cancellationToken);
        return TypedResults.Ok(habits.Where(habit => filter is null || ScheduleEligibility.IsScheduled(habit.Schedule, filter.Value))
            .Select(HabitResponse.From).ToArray());
    }

    private static async Task<IResult> Read(Guid id, ClaimsPrincipal user, HabitsDb db, CancellationToken cancellationToken)
    {
        var habit = await db.Habits.AsNoTracking().Include(habit => habit.Schedule)
            .SingleOrDefaultAsync(habit => habit.Id == id && habit.OwnerId == user.FindFirst("sub")!.Value, cancellationToken);
        return habit is null ? Results.NotFound() : TypedResults.Ok(HabitResponse.From(habit));
    }
}
