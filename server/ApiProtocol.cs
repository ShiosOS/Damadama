using Microsoft.AspNetCore.Http.Features;

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
                return Task.CompletedTask;
            });
            if (context.GetEndpoint()?.Metadata.GetMetadata<IEndpointNameMetadata>()?.EndpointName == "application-shell")
            {
                await Results.Problem(statusCode: 404, title: "API route not found.").ExecuteAsync(context);
                return;
            }
            if (HttpMethods.IsGet(context.Request.Method) &&
                context.Features.Get<IHttpRequestBodyDetectionFeature>()?.CanHaveBody == true)
            {
                await Results.Problem(statusCode: 400, title: "GET requests must not contain a body.").ExecuteAsync(context);
                return;
            }
            await next(context);
        });
    }
}
