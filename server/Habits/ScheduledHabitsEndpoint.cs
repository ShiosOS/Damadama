using System.Globalization;
using System.Security.Claims;
using Microsoft.EntityFrameworkCore;

namespace Damadama.Habits;

public static class ScheduledHabitsEndpoint
{
    public static void MapScheduledHabits(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapMethods("/api/habits/scheduled", ["GET", "HEAD"], async (HttpRequest request, ClaimsPrincipal user,
            HabitsDb db, ApiRepresentations representations, CancellationToken cancellationToken) =>
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
            return ApiRepresentations.Ok(representations.Collection("scheduled-habits", "scheduled-habits", habits.Where(habit => ScheduleEligibility.IsScheduled(habit.Schedule, date))
                .Select(habit => representations.Habit(habit, date)), new { date = date.ToString("yyyy-MM-dd") }));
        }).WithName("scheduled-habits").WithMetadata(new ApiContractMetadata("resource")).RequireAuthorization();
    }
}
