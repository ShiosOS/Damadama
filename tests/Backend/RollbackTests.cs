using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using NUnit.Framework;

namespace Damadama.Tests;

public class RollbackTests
{
    [TestCase(false)]
    [TestCase(true)]
    public async Task Schedule_failure_at_insert_or_commit_rolls_back_the_whole_habit(bool atCommit)
    {
        using var app = new TestApp(DatabaseFixture.Database.GetConnectionString());
        using var client = app.SignedIn();
        await DatabaseFixture.Reset();
        await DatabaseFixture.Execute("""
            CREATE FUNCTION reject_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'test-owned schedule failure'; END; $$;
            """);
        await DatabaseFixture.Execute(atCommit
            ? "CREATE CONSTRAINT TRIGGER reject_schedule AFTER INSERT ON \"InitialSchedules\" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_schedule()"
            : "CREATE TRIGGER reject_schedule BEFORE INSERT ON \"InitialSchedules\" FOR EACH ROW EXECUTE FUNCTION reject_schedule()");
        try
        {
            using var response = await client.PostAsJsonAsync("/api/habits", HabitTests.Walking);
            Assert.That(response.StatusCode, Is.EqualTo(HttpStatusCode.ServiceUnavailable));
            var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.That(problem.GetProperty("title").GetString(), Is.EqualTo("The habit could not be saved or loaded."));
            Assert.That(problem.GetProperty("traceId").GetString(), Is.Not.Empty);
            Assert.That(await DatabaseFixture.Count("Habits"), Is.Zero);
            Assert.That(await DatabaseFixture.Count("InitialSchedules"), Is.Zero);
        }
        finally
        {
            await DatabaseFixture.Execute("DROP TRIGGER reject_schedule ON \"InitialSchedules\"; DROP FUNCTION reject_schedule()");
        }
    }
}
