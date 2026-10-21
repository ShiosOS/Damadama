using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Damadama.Heatmap;
using NUnit.Framework;

namespace Damadama.Tests;

public class HeatmapApiTests
{
    private const string Query = "?deviceToday=2026-01-04&timeZone=America%2FNew_York";
    private TestApp app = null!;
    private HttpClient client = null!;

    [SetUp]
    public async Task Start()
    {
        app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        client = app.SignedIn();
        await DatabaseFixture.Reset();
    }

    [Test]
    public async Task Read_returns_365_dates_including_the_device_date_for_an_empty_account()
    {
        using var response = await client.GetAsync("/api/heatmap" + Query);

        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.OK));
        var heatmap = (await response.Content.ReadFromJsonAsync<HeatmapResponse>())!;
        Assert.Multiple(() =>
        {
            Assert.That(heatmap.Start, Is.EqualTo(new DateOnly(2025, 1, 5)));
            Assert.That(heatmap.End, Is.EqualTo(new DateOnly(2026, 1, 4)));
            Assert.That(heatmap.Days.Length, Is.EqualTo(365));
            Assert.That(heatmap.Days.All(day => day.ScheduledCount == 0 && day.Completion is null), Is.True);
            Assert.That(response.Headers.CacheControl?.Private, Is.True);
            Assert.That(response.Headers.CacheControl?.NoStore, Is.True);
        });
    }

    [Test]
    public async Task Owner_totals_include_Rest_and_missing_entries_without_disclosing_other_owners()
    {
        foreach (var result in new[] { "Good", "Better", "Best", "Rest", null })
        {
            var id = await Create("owner", result ?? "Missing");
            if (result is not null)
            {
                using var saved = await client.PutAsJsonAsync($"/api/habits/{id}/entries/2026-01-04", new
                { result, editedAt = "2026-01-05T00:00:00Z", deviceToday = "2026-01-04", timeZone = "America/New_York" });
                Assert.That(saved.StatusCode, Is.EqualTo(HttpStatusCode.Created));
            }
        }
        var foreign = await Create("someone-else", "Private");
        using var stranger = app.SignedIn("someone-else");
        using var privateEntry = await stranger.PutAsJsonAsync($"/api/habits/{foreign}/entries/2026-01-04", new
        { result = "Best", editedAt = "2026-01-05T00:00:00Z", deviceToday = "2026-01-04", timeZone = "America/New_York" });
        Assert.That(privateEntry.StatusCode, Is.EqualTo(HttpStatusCode.Created));

        var heatmap = (await client.GetFromJsonAsync<HeatmapResponse>("/api/heatmap" + Query))!;
        var today = heatmap.Days.Last();
        using var emptyOwner = app.SignedIn("empty-owner");
        var empty = (await emptyOwner.GetFromJsonAsync<HeatmapResponse>("/api/heatmap" + Query))!;

        Assert.Multiple(() =>
        {
            Assert.That(today.ScheduledCount, Is.EqualTo(5));
            Assert.That(today.EarnedPoints, Is.EqualTo(6));
            Assert.That(today.MaximumPoints, Is.EqualTo(15));
            Assert.That(today.Completion, Is.EqualTo(0.4));
            Assert.That(heatmap.Days.SkipLast(1).All(day => day.Completion is null), Is.True);
            Assert.That(empty.Days.All(day => day.ScheduledCount == 0), Is.True);
        });
    }

    [TestCase("")]
    [TestCase("?deviceToday=2026-01-04")]
    [TestCase("?timeZone=UTC")]
    [TestCase("?deviceToday=&timeZone=UTC")]
    [TestCase("?deviceToday=2026-1-04&timeZone=America%2FNew_York")]
    [TestCase("?deviceToday=2026-02-30&timeZone=UTC")]
    [TestCase("?deviceToday=2026-01-04T00%3A00%3A00Z&timeZone=UTC")]
    [TestCase("?deviceToday=2026-01-04&timeZone=")]
    [TestCase("?deviceToday=2026-01-04&timeZone=Unknown")]
    [TestCase("?deviceToday=2026-01-04&timeZone=Eastern%20Standard%20Time")]
    [TestCase("?deviceToday=2026-01-05&timeZone=America%2FNew_York")]
    [TestCase("?deviceToday=2026-01-04&deviceToday=2026-01-04&timeZone=America%2FNew_York")]
    [TestCase("?deviceToday=2026-01-04&timeZone=America%2FNew_York&timeZone=America%2FNew_York")]
    public async Task Invalid_or_repeated_device_anchor_fields_are_refused(string query)
    {
        using var response = await client.GetAsync("/api/heatmap" + query);

        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.BadRequest));
        Assert.That(response.Content.Headers.ContentType?.MediaType, Is.EqualTo("application/problem+json"));
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.That(problem.GetProperty("traceId").GetString(), Is.Not.Empty);
    }

    [TestCase(Query)]
    [TestCase("?deviceToday=invalid&timeZone=Unknown")]
    [TestCase("")]
    public async Task Signed_out_reads_are_refused_before_anchor_validation(string query)
    {
        using var signedOut = app.CreateClient();
        using var response = await signedOut.GetAsync("/api/heatmap" + query);

        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.Unauthorized));
    }

    [Test]
    public async Task Device_travel_moves_the_range_without_moving_saved_calendar_dates()
    {
        await Create("owner", "Sunday walk");

        var west = (await client.GetFromJsonAsync<HeatmapResponse>("/api/heatmap" + Query))!;
        var east = (await client.GetFromJsonAsync<HeatmapResponse>(
            "/api/heatmap?deviceToday=2026-01-05&timeZone=Asia%2FTokyo"))!;

        Assert.Multiple(() =>
        {
            Assert.That(west.End, Is.EqualTo(new DateOnly(2026, 1, 4)));
            Assert.That(east.End, Is.EqualTo(new DateOnly(2026, 1, 5)));
            Assert.That(west.Days.Last().ScheduledCount, Is.EqualTo(1));
            Assert.That(east.Days.Single(day => day.Date == new DateOnly(2026, 1, 4)).ScheduledCount, Is.EqualTo(1));
            Assert.That(east.Days.Last().ScheduledCount, Is.Zero);
        });
    }

    private async Task<Guid> Create(string owner, string name)
    {
        using var creator = app.SignedIn(owner);
        using var response = await creator.PostAsJsonAsync("/api/habits", HabitTests.Walking with
        { Name = name, Weekdays = [7], RepeatEveryWeeks = 1 });
        Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.Created));
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    [TearDown]
    public void Dispose()
    {
        client.Dispose();
        app.Dispose();
    }
}
