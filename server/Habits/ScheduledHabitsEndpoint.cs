using System.Globalization;
using System.Security.Claims;
using Microsoft.EntityFrameworkCore;

namespace Damadama.Habits;

public static class ScheduledHabitsEndpoint
{
    public static void MapScheduledHabits(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/habits/scheduled", async (HttpRequest request, ClaimsPrincipal user,
            HabitsDb db, CancellationToken cancellationToken) =>
        {
            if (!request.Query.TryGetValue("date", out var values) || values.Count != 1 ||
                !DateOnly.TryParseExact(values[0], "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
                return Results.ValidationProblem(new Dictionary<string, string[]>
                {
                    ["date"] = ["Use one valid calendar date in YYYY-MM-DD format."]
                }, title: "Check the requested date.");

            var habits = await db.Habits.AsNoTracking().Include(habit => habit.Schedule)
                .Where(habit => habit.OwnerId == user.FindFirst("sub")!.Value)
                .OrderBy(habit => habit.CreatedAt).ThenBy(habit => habit.Id)
                .ToListAsync(cancellationToken);
            return Results.Ok(habits.Where(habit => ScheduleEligibility.IsScheduled(habit.Schedule, date))
                .Select(HabitResponse.From));
        }).RequireAuthorization();
    }
}
