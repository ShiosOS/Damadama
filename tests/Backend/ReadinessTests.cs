using System.Net;
using NUnit.Framework;

namespace Damadama.Tests;

public class ReadinessTests
{
    [Test]
    public async Task Ready_requires_the_migrated_database()
    {
        using var app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        using var client = app.CreateClient();
        using var live = await client.GetAsync("/health/live");
        Assert.That(live.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        using var ready = await client.GetAsync("/health/ready");
        Assert.That(ready.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        await DatabaseFixture.Execute("ALTER TABLE \"InitialSchedules\" RENAME TO \"MissingSchedules\"");
        try
        {
            using var unavailable = await client.GetAsync("/health/ready");
            Assert.That(unavailable.StatusCode, Is.EqualTo(HttpStatusCode.ServiceUnavailable));
            using var stillLive = await client.GetAsync("/health/live");
            Assert.That(stillLive.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        }
        finally
        {
            await DatabaseFixture.Execute("ALTER TABLE \"MissingSchedules\" RENAME TO \"InitialSchedules\"");
        }
    }
}
