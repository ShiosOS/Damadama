using Microsoft.AspNetCore.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Damadama;

public sealed class ApiErrors(ILogger<ApiErrors> logger) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext context, Exception exception, CancellationToken cancellationToken)
    {
        if (exception is ArgumentException invalid)
        {
            var field = System.Text.Json.JsonNamingPolicy.CamelCase.ConvertName(invalid.ParamName ?? "habit");
            await Results.ValidationProblem(new Dictionary<string, string[]> { [field] = [invalid.Message] },
                title: "Check the habit fields.").ExecuteAsync(context);
            return true;
        }
        if (exception is not (DbUpdateException or NpgsqlException)) return false;
        logger.LogError("Database request failed. TraceId {TraceId}, ErrorType {ErrorType}",
            context.TraceIdentifier, exception.GetType().Name);
        await Results.Problem(statusCode: 503, title: "The habit could not be saved or loaded.",
            detail: "Storage is unavailable. Try again when the service is ready.").ExecuteAsync(context);
        return true;
    }
}
