using System.Net;
using NUnit.Framework;

namespace Damadama.Tests;

public class WorkerRetirementTests
{
    [TestCase("/SW.js")]
    [TestCase("/sw.js/")]
    [TestCase("/nested/sw.js")]
    public async Task Other_paths_do_not_serve_JavaScript(string path)
    {
        using var app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        using var client = app.CreateClient();
        using var response = await client.GetAsync($"https://staging.damadama.app{path}");
        Assert.That(response.Content.Headers.ContentType?.MediaType, Is.Not.EqualTo("application/javascript"));
    }

    [TestCase("staging.damadama.app")]
    [TestCase("STAGING.DAMADAMA.APP")]
    [TestCase("staging.damadama.app:443")]
    public async Task Staging_serves_uncached_JavaScript(string authority)
    {
        using var app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        using var client = app.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://staging.damadama.app/sw.js");
        request.Headers.Host = authority;
        using var response = await client.SendAsync(request);
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        Assert.That(response.Content.Headers.ContentType?.MediaType, Is.EqualTo("application/javascript"));
        Assert.That(response.Headers.CacheControl?.NoStore, Is.True);
        Assert.That(await response.Content.ReadAsStringAsync(), Is.Not.Empty);
    }

    [TestCase("damadama.app")]
    [TestCase("www.damadama.app")]
    [TestCase("staging.damadama.app.evil.invalid")]
    [TestCase("other.staging.damadama.app")]
    [TestCase("staging.damadama.app.")]
    [TestCase("staging.damadama.app:8443")]
    [TestCase("staging.damadama.app:80")]
    [TestCase("localhost")]
    public async Task Other_authorities_cannot_serve_the_retirement_worker(string authority)
    {
        using var app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        using var client = app.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "https://staging.damadama.app/sw.js");
        request.Headers.Host = authority;
        request.Headers.Add("X-Forwarded-Host", "staging.damadama.app");
        using var response = await client.SendAsync(request);
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.NotFound));
    }
}
