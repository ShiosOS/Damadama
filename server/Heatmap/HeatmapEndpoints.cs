using System.Security.Claims;
using Damadama.Habits;

namespace Damadama.Heatmap;

public static class HeatmapEndpoints
{
    public static void MapHeatmap(this WebApplication app)
    {
        app.MapGet("/api/heatmap", ReadHeatmap).WithName("yearly-heatmap").WithTags("Heatmap")
            .WithSummary("Read 365 days of account-owned habit activity")
            .Produces<HeatmapResponse>().ProducesProblem(400).ProducesProblem(401)
            .ProducesProblem(503).RequireAuthorization();
    }

    private static async Task<IResult> ReadHeatmap(string? deviceToday, string? timeZone, HttpRequest request,
        ClaimsPrincipal user, IHistoryReader history, TimeProvider clock, CancellationToken cancellationToken)
    {
        if (request.Query["deviceToday"].Count != 1)
            throw new ArgumentException("Include one device calendar date.", nameof(deviceToday));
        if (request.Query["timeZone"].Count != 1)
            throw new ArgumentException("Include one device timezone.", nameof(timeZone));
        var today = DeviceCalendar.Today(deviceToday, timeZone, clock);
        var range = new InclusiveDateRange(today.AddDays(-364), today);
        var owned = await history.ReadOwnedRange(user.FindFirst("sub")!.Value, range, cancellationToken);
        return TypedResults.Ok(HeatmapScoring.Calculate(owned));
    }
}
