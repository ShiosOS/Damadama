namespace Damadama;

public static class WorkerRetirement
{
    public static IResult Respond(HttpContext context)
    {
        var authority = context.Request.Host.Value;
        if (!string.Equals(context.Request.Path.Value, "/sw.js", StringComparison.Ordinal) ||
            !string.Equals(authority, "staging.damadama.app", StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(authority, "staging.damadama.app:443", StringComparison.OrdinalIgnoreCase))
            return Results.NotFound();

        context.Response.Headers.CacheControl = "no-store";
        return Results.Text("""
            self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
            self.addEventListener("activate", event => event.waitUntil(self.registration.unregister()));
            """, "application/javascript");
    }
}
