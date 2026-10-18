using System.Text.Json;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using NUnit.Framework;

namespace Damadama.Tests;

public class RequestReceiverRouteTests
{
    [Test]
    public void Receiver_route_policy_matches_actual_registered_application_templates()
    {
        using var app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        using var client = app.CreateClient();
        var actual = app.Services.GetRequiredService<EndpointDataSource>().Endpoints.OfType<RouteEndpoint>()
            .Select(endpoint => endpoint.RoutePattern.RawText).Distinct().Order(StringComparer.Ordinal).ToArray();
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "Damadama.slnx"))) root = root.Parent;
        var policy = Path.Combine(root?.FullName ?? throw new InvalidOperationException("Run tests inside the repository."),
            "ops", "diagnostics", "receiver-routes.json");
        var allowed = JsonSerializer.Deserialize<string[]>(File.ReadAllText(policy))!;
        Assert.That(allowed, Is.Unique);
        Assert.That(allowed.Order(StringComparer.Ordinal), Is.EqualTo(actual), "Review the receiver privacy policy whenever registered routes change.");
    }
}
