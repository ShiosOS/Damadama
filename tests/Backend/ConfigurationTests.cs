using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using NUnit.Framework;

namespace Damadama.Tests;

public class ConfigurationTests
{
    [Test]
    public async Task Public_runtime_configuration_contains_only_the_publishable_key()
    {
        using var app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        using var client = app.CreateClient();
        using var response = await client.GetAsync("/api/config");
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        var configuration = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.That(configuration.EnumerateObject().Select(property => property.Name), Is.EqualTo(new[] { "clerkPublishableKey" }));
        Assert.That(configuration.GetProperty("clerkPublishableKey").GetString(), Is.EqualTo("pk_test_fixture"));
        Assert.That(await response.Content.ReadAsStringAsync(), Does.Not.Contain(DatabaseFixture.Database.GetConnectionString()));
    }
}
