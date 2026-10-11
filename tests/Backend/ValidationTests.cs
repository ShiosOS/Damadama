using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using NUnit.Framework;

namespace Damadama.Tests;

public class ValidationTests
{
    [TestCase("name")]
    [TestCase("good")]
    [TestCase("better")]
    [TestCase("best")]
    [TestCase("weekdays")]
    [TestCase("invalid-day")]
    [TestCase("repeat")]
    [TestCase("zone")]
    [TestCase("fractional-repeat")]
    public async Task Invalid_creation_is_a_useful_400_and_writes_no_rows(string field)
    {
        using var app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        using var client = app.SignedIn();
        await DatabaseFixture.Reset();
        var input = field switch
        {
            "name" => HabitTests.Walking with { Name = " " },
            "good" => HabitTests.Walking with { Good = null },
            "better" => HabitTests.Walking with { Better = "" },
            "best" => HabitTests.Walking with { Best = " " },
            "weekdays" => HabitTests.Walking with { Weekdays = null },
            "invalid-day" => HabitTests.Walking with { Weekdays = [8] },
            "repeat" => HabitTests.Walking with { RepeatEveryWeeks = 0 },
            "zone" => HabitTests.Walking with { TimeZone = "Not/AZone" },
            "fractional-repeat" => HabitTests.Walking,
            _ => throw new ArgumentOutOfRangeException(nameof(field))
        };
        using var response = field == "fractional-repeat"
            ? await client.PostAsync("/api/habits", new StringContent(
                JsonSerializer.Serialize(input, new JsonSerializerOptions(JsonSerializerDefaults.Web)).Replace("\"repeatEveryWeeks\":2", "\"repeatEveryWeeks\":1.5"),
                System.Text.Encoding.UTF8, "application/json"))
            : await client.PostAsJsonAsync("/api/habits", input);
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.BadRequest));
        Assert.That(response.Content.Headers.ContentType?.MediaType, Is.EqualTo("application/problem+json"));
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.That(problem.GetProperty("traceId").GetString(), Is.Not.Empty);
        Assert.That(await DatabaseFixture.Count("Habits"), Is.Zero);
        Assert.That(await DatabaseFixture.Count("InitialSchedules"), Is.Zero);
    }
}
