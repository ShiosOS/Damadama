using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.Net.Http.Headers;

namespace Damadama;

public static class ApiProtocol
{
    public static void UseApiProtocol(this WebApplication app)
    {
        app.Use(async (context, next) =>
        {
            if (!context.Request.Path.StartsWithSegments("/api"))
            {
                await next(context);
                return;
            }
            context.Response.OnStarting(() =>
            {
                context.Response.Headers.CacheControl = "private, no-store";
                context.Response.Headers.Vary = "Accept";
                return Task.CompletedTask;
            });
            var output = context.Response.Body;
            if (HttpMethods.IsHead(context.Request.Method)) context.Response.Body = Stream.Null;
            try { await next(context); }
            finally { context.Response.Body = output; }
        });
    }

    public static void UseApiNegotiation(this WebApplication app)
    {
        app.Use(async (context, next) =>
        {
            if (!context.Request.Path.StartsWithSegments("/api"))
            {
                await next(context);
                return;
            }
            if (context.GetEndpoint()?.Metadata.GetMetadata<ApiContractMetadata>() is null)
            {
                var routes = context.RequestServices.GetRequiredService<EndpointDataSource>().Endpoints
                    .OfType<RouteEndpoint>()
                    .Where(endpoint => endpoint.Metadata.GetMetadata<ApiContractMetadata>() is not null &&
                        endpoint.Metadata.GetMetadata<IEndpointNameMetadata>() is { } name &&
                        context.RequestServices.GetRequiredService<LinkParser>()
                            .ParsePathByEndpointName(name.EndpointName, context.Request.Path) is not null)
                    .ToArray();
                if (routes.Any(endpoint => endpoint.Metadata.GetMetadata<IAuthorizeData>() is not null) &&
                    context.User.Identity?.IsAuthenticated != true)
                {
                    await context.ChallengeAsync();
                    return;
                }
                var allowed = routes.SelectMany(endpoint => endpoint.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? [])
                    .Distinct().Order().ToArray();
                if (allowed.Length > 0) context.Response.Headers.Allow = string.Join(", ", allowed);
                await Results.Problem(statusCode: allowed.Length > 0 ? 405 : 404,
                    title: allowed.Length > 0 ? "Method not allowed." : "API route not found.").ExecuteAsync(context);
                return;
            }
            if (!AcceptsSiren(context.Request))
            {
                await Results.Problem(statusCode: 406, title: "Request application/vnd.siren+json.").ExecuteAsync(context);
                return;
            }
            if ((HttpMethods.IsPost(context.Request.Method) || HttpMethods.IsPut(context.Request.Method)) &&
                (!MediaTypeHeaderValue.TryParse(context.Request.ContentType, out var contentType) ||
                 !contentType.MediaType.Equals("application/json", StringComparison.OrdinalIgnoreCase)))
            {
                await Results.Problem(statusCode: 415, title: "Send application/json.").ExecuteAsync(context);
                return;
            }
            await next(context);
        });
    }

    private static bool AcceptsSiren(HttpRequest request)
    {
        if (!request.Headers.ContainsKey("Accept")) return true;
        if (!MediaTypeHeaderValue.TryParseList(request.Headers.Accept.Select(value => value ?? "").ToArray(), out var ranges)) return false;
        var matches = ranges.Select(range => new
        {
            Range = range,
            Specificity = range.MediaType.Value?.ToLowerInvariant() switch
            {
                ApiRepresentations.MediaType => 2,
                "application/*" => 1,
                "*/*" => 0,
                _ => -1
            }
        }).Where(match => match.Specificity >= 0).OrderByDescending(match => match.Specificity)
            .ThenByDescending(match => match.Range.Quality ?? 1).FirstOrDefault();
        return matches is not null && (matches.Range.Quality ?? 1) > 0;
    }

    public static void MapApiOptions(this WebApplication app, string path, string name, string[] methods, bool authorized)
    {
        var endpoint = app.MapMethods(path, ["OPTIONS"], (HttpResponse response) =>
        {
            response.Headers.Allow = string.Join(", ", methods);
            return Results.NoContent();
        }).WithName(name).WithMetadata(new ApiContractMetadata("options"));
        if (authorized) endpoint.RequireAuthorization();
    }
}
