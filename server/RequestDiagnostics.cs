using System.Text.Json;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Logging.Console;

namespace Damadama;

public enum RequestFailure { Storage, Unexpected, Readiness }

public sealed class RequestDiagnostics
{
    private const string Unavailable = "unavailable";
    private static readonly Func<HttpContext, HealthReport, Task> DefaultHealthWriter = new HealthCheckOptions().ResponseWriter;
    private readonly ILogger<RequestDiagnostics> logger;
    private readonly string revision;
    private readonly string environment;

    public RequestDiagnostics(IWebHostEnvironment host, ILogger<RequestDiagnostics> logger)
    {
        this.logger = logger;
        revision = ReadRevision(host);
        environment = System.Environment.GetEnvironmentVariable("RAILWAY_ENVIRONMENT_NAME") switch
        {
            "staging" => "staging",
            "production" => "production",
            _ => Unavailable
        };
    }

    public int Record(HttpContext context, RequestFailure failure)
    {
        var (status, classification) = failure switch
        {
            RequestFailure.Storage => (StatusCodes.Status503ServiceUnavailable, "storage-unavailable"),
            RequestFailure.Unexpected => (StatusCodes.Status500InternalServerError, "unexpected"),
            RequestFailure.Readiness => (StatusCodes.Status503ServiceUnavailable, "readiness-unavailable"),
            _ => throw new ArgumentOutOfRangeException(nameof(failure))
        };
        var endpoint = context.Features.Get<IExceptionHandlerFeature>()?.Endpoint ?? context.GetEndpoint();
        var route = (endpoint as RouteEndpoint)?.RoutePattern.RawText ?? Unavailable;
        logger.LogError("Request failure. Revision {Revision}, Environment {Environment}, Route {Route}, Status {Status}, TraceId {TraceId}, Classification {Classification}",
            revision, environment, route, status, TraceId(context), classification);
        return status;
    }

    public static string TraceId(HttpContext context)
    {
        var trace = context.TraceIdentifier;
        if (trace.Length is < 1 or > 128 || !trace.All(character => char.IsAsciiLetterOrDigit(character) || character is ':' or '_' or '-'))
            context.TraceIdentifier = Guid.NewGuid().ToString("N");
        return context.TraceIdentifier;
    }

    public static Task WriteReadinessResponse(HttpContext context, HealthReport report)
    {
        context.Response.Headers["X-Trace-Id"] = TraceId(context);
        if (context.Response.StatusCode == StatusCodes.Status503ServiceUnavailable)
            context.RequestServices.GetRequiredService<RequestDiagnostics>().Record(context, RequestFailure.Readiness);
        return DefaultHealthWriter(context, report);
    }

    private static string ReadRevision(IWebHostEnvironment host)
    {
        try
        {
            var file = host.WebRootFileProvider.GetFileInfo("release.json");
            if (!file.Exists) return Unavailable;
            using var stream = file.CreateReadStream();
            using var document = JsonDocument.Parse(stream);
            if (document.RootElement.ValueKind != JsonValueKind.Object ||
                !document.RootElement.TryGetProperty("source", out var source) || source.ValueKind != JsonValueKind.Object ||
                !source.TryGetProperty("commit", out var commit) || commit.ValueKind != JsonValueKind.String)
                return Unavailable;
            var value = commit.GetString()!;
            return value.Length == 40 && value.All(char.IsAsciiHexDigit) ? value.ToLowerInvariant() : Unavailable;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return Unavailable;
        }
    }
}

public static class RequestDiagnosticsServices
{
    public static void AddRequestDiagnostics(this IServiceCollection services)
    {
        services.AddSingleton<RequestDiagnostics>();
        services.AddProblemDetails(options => options.CustomizeProblemDetails = context =>
            context.ProblemDetails.Extensions["traceId"] = RequestDiagnostics.TraceId(context.HttpContext));
        services.AddExceptionHandler<ApiErrors>();
        services.PostConfigure<JsonConsoleFormatterOptions>(options => options.IncludeScopes = false);
        services.PostConfigure<LoggerFilterOptions>(options =>
        {
            options.Rules.Clear();
            options.MinLevel = LogLevel.None;
            options.CaptureScopes = false;
            options.Rules.Add(new LoggerFilterRule(null, null, null, static (_, category, level) =>
                category == typeof(RequestDiagnostics).FullName && level == LogLevel.Error));
        });
    }
}
