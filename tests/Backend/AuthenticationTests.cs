using System.Net;
using NUnit.Framework;

namespace Damadama.Tests;

public class AuthenticationTests
{
    [TestCase("expired")]
    [TestCase("tampered")]
    [TestCase("issuer")]
    [TestCase("origin")]
    [TestCase("subject")]
    [TestCase("empty-subject")]
    [TestCase("future")]
    [TestCase("pending")]
    public async Task Refuses_invalid_session_token(string flaw)
    {
        using var app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        using var client = app.CreateClient();
        var token = flaw switch
        {
            "expired" => app.Token(expired: true),
            "tampered" => app.Token()[..^20] + new string('a', 20),
            "issuer" => app.Token(issuer: "https://another-instance.invalid"),
            "origin" => app.Token(origin: "https://untrusted.invalid"),
            "subject" => app.Token(subject: null),
            "empty-subject" => app.Token(subject: " "),
            "future" => app.Token(future: true),
            "pending" => app.Token(pending: true),
            _ => throw new ArgumentOutOfRangeException(nameof(flaw))
        };
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        using var response = await client.GetAsync("/api/habits");
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.Unauthorized));
    }
}
