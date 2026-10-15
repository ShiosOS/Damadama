using Damadama.Habits;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace Damadama;

public sealed class DatabaseReadiness(HabitsDb db) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken)
    {
        try
        {
            if ((await db.Database.GetPendingMigrationsAsync(cancellationToken)).Any())
                return HealthCheckResult.Unhealthy("Database migrations are pending.");
            await db.Database.ExecuteSqlRawAsync("""
                SELECT 1 FROM "Habits" JOIN "InitialSchedules" ON "Habits"."Id" = "InitialSchedules"."HabitId" LIMIT 0;
                SELECT "Result", "EditedAtTicks", "CalendarDate", "Good", "Better", "Best" FROM "DailyEntries" LIMIT 0;
                """, cancellationToken);
            return HealthCheckResult.Healthy();
        }
        catch (Npgsql.NpgsqlException)
        {
            return HealthCheckResult.Unhealthy("Database or habit schema is unavailable.");
        }
    }
}
