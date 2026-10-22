using System.Text.Json;
using Damadama.Tests;
using Damadama.Habits;
using Damadama.Entries;
using Microsoft.EntityFrameworkCore;
using Testcontainers.PostgreSql;

await using var database = new PostgreSqlBuilder("postgres:17-alpine").Build();
await database.StartAsync();
await using (var seed = new HabitsDb(new DbContextOptionsBuilder<HabitsDb>()
    .UseNpgsql(database.GetConnectionString()).Options))
{
    await seed.Database.MigrateAsync();
    var retained = Habit.Create(new CreateHabit("Retained walking", "5 minutes", "15 minutes", "30 minutes",
        [7], 1, "America/New_York"), "entries-retained-account", TestApp.CreationInstant);
    seed.Habits.Add(retained);
    await seed.SaveChangesAsync();
    await new HabitHistory(seed, new FixtureClock()).SaveEntry(retained.Id, retained.OwnerId, "2026-01-04",
        new WriteEntry("Good", TestApp.CreationInstant, "2026-01-05", "UTC"), CancellationToken.None);
    await seed.Database.ExecuteSqlInterpolatedAsync($"""
        UPDATE "InitialSchedules" SET "Weekdays" = ARRAY[3] WHERE "HabitId" = {retained.Id};
        UPDATE "Habits" SET "Good" = 'new good', "Better" = 'new better', "Best" = 'new best' WHERE "Id" = {retained.Id};
        """);
}
using var app = new TestApp(database.GetConnectionString());
var apiPort = int.Parse(Environment.GetEnvironmentVariable("DAMADAMA_API_PORT") ?? "5055");
app.UseKestrel(apiPort);
var fixture = JsonSerializer.Serialize(new
{
    owner = app.Token(),
    other = app.Token("other-account"),
    reload = app.Token("reload-account"),
    list = app.Token("list-account"),
    listRecovery = app.Token("list-recovery-account"),
    expired = app.Token("expired-account", expired: true),
    errors = app.Token("errors-account"),
    cleanup = app.Token("cleanup-account"),
    performance = app.Token("performance-account"),
    accessibility = app.Token("accessibility-account"),
    accessibilityControl = app.Token("accessibility-control-account"),
    accessibilityMobile = app.Token("accessibility-mobile-account"),
    accessibilityZoom = app.Token("accessibility-zoom-account"),
    accessibilityExpired = app.Token("accessibility-expired-account", expired: true),
    stale = app.Token("stale-account"),
    saveVisibilityIneligible = app.Token("save-visibility-ineligible-account"),
    saveVisibilityEligible = app.Token("save-visibility-eligible-account"),
    saveVisibilityHeld = app.Token("save-visibility-held-account"),
    saveVisibilityReduced = app.Token("save-visibility-reduced-account"),
    saveVisibilityPopulated = app.Token("save-visibility-populated-account"),
    saveVisibilityError = app.Token("save-visibility-error-account"),
    saveVisibilityReopen = app.Token("save-visibility-reopen-account"),
    saveVisibilityAccount = app.Token("save-visibility-account-change-account"),
    saveVisibilitySignOut = app.Token("save-visibility-sign-out-account"),
    saveVisibilityDate = app.Token("save-visibility-date-account"),
    todayScheduled = app.Token("today-scheduled-account"),
    todayLoading = app.Token("today-loading-account"),
    todayError = app.Token("today-error-account"),
    todayCreate = app.Token("today-create-account"),
    todayReload = app.Token("today-reload-account"),
    todayOwner = app.Token("today-owner-account"),
    todayStaleSuccess = app.Token("today-stale-success-account"),
    todayStaleError = app.Token("today-stale-error-account"),
    todayDateSuccess = app.Token("today-date-success-account"),
    todayDateError = app.Token("today-date-error-account"),
    todayTravel = app.Token("today-travel-account"),
    todayMidnight = app.Token("today-midnight-account"),
    todayYear = app.Token("today-year-account"),
    todayVisible = app.Token("today-visible-account"),
    todayUnmount = app.Token("today-unmount-account"),
    entriesImmediate = app.Token("entries-immediate-account"),
    entriesReload = app.Token("entries-reload-account"),
    entriesOutcomes = app.Token("entries-outcomes-account"),
    entriesHeld = app.Token("entries-held-account"),
    entriesRetry = app.Token("entries-retry-account"),
    entriesWinner = app.Token("entries-winner-account"),
    entriesSignOut = app.Token("entries-sign-out-account"),
    entriesAccount = app.Token("entries-account-change-account"),
    entriesDate = app.Token("entries-date-account"),
    entriesMobile = app.Token("entries-mobile-account"),
    entriesTravel = app.Token("entries-travel-account"),
    entriesRetained = app.Token("entries-retained-account"),
    entriesCreation = app.Token("entries-creation-account"),
    historyEdit = app.Token("history-edit-account"),
    historySchedule = app.Token("history-schedule-account"),
    historyArchive = app.Token("history-archive-account"),
    historyArchiveRemove = app.Token("history-archive-remove-account"),
    historyRetry = app.Token("history-retry-account"),
    historyAccount = app.Token("history-account-change-account"),
    historyMobile = app.Token("history-mobile-account"),
    historyRetryDraft = app.Token("history-retry-draft-account"),
    historyPending = app.Token("history-pending-account"),
    historyPendingFailure = app.Token("history-pending-failure-account"),
    historyPendingWinner = app.Token("history-pending-winner-account"),
    heatmap = app.Token("heatmap-account"),
    heatmapReload = app.Token("heatmap-reload-account"),
    heatmapLoading = app.Token("heatmap-loading-account"),
    heatmapError = app.Token("heatmap-error-account"),
    heatmapAccount = app.Token("heatmap-account-change-account"),
    heatmapDate = app.Token("heatmap-date-account"),
    heatmapTravel = app.Token("heatmap-travel-account"),
    heatmapMobile = app.Token("heatmap-mobile-account"),
    heatmapHistory = app.Token("heatmap-history-account")
});
await File.WriteAllTextAsync("tests/Browser/fixture.json", fixture);
if (Directory.Exists(".audit/browser-build"))
    await File.WriteAllTextAsync(".audit/browser-build/fixture.json", fixture);
using var client = app.CreateClient();
Console.WriteLine($"Browser fixture ready at http://localhost:{apiPort}. This does not test Clerk sign-in.");
var stopped = new TaskCompletionSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; stopped.TrySetResult(); };
System.Runtime.Loader.AssemblyLoadContext.Default.Unloading += _ => stopped.TrySetResult();
await stopped.Task;

sealed class FixtureClock : TimeProvider
{
    public override DateTimeOffset GetUtcNow() => TestApp.CreationInstant;
}
