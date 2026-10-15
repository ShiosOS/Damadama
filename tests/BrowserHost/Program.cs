using System.Text.Json;
using Damadama.Tests;
using Testcontainers.PostgreSql;

await using var database = new PostgreSqlBuilder("postgres:17-alpine").Build();
await database.StartAsync();
using var app = new TestApp(database.GetConnectionString());
var apiPort = int.Parse(Environment.GetEnvironmentVariable("DAMADAMA_API_PORT") ?? "5055");
app.UseKestrel(apiPort);
var fixture = JsonSerializer.Serialize(new
{
    owner = app.Token(),
    other = app.Token("other-account"),
    reload = app.Token("reload-account"),
    list = app.Token("list-account"),
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
    todayUnmount = app.Token("today-unmount-account")
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
