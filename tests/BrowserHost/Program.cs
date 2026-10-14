using System.Text.Json;
using Damadama.Tests;
using Testcontainers.PostgreSql;

await using var database = new PostgreSqlBuilder("postgres:17-alpine").Build();
await database.StartAsync();
using var app = new TestApp(database.GetConnectionString());
app.UseKestrel(5055);
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
    stale = app.Token("stale-account")
});
await File.WriteAllTextAsync("tests/Browser/fixture.json", fixture);
if (Directory.Exists(".audit/browser-build"))
    await File.WriteAllTextAsync(".audit/browser-build/fixture.json", fixture);
using var client = app.CreateClient();
Console.WriteLine("Browser fixture ready at http://localhost:5055. This does not test Clerk sign-in.");
var stopped = new TaskCompletionSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; stopped.TrySetResult(); };
System.Runtime.Loader.AssemblyLoadContext.Default.Unloading += _ => stopped.TrySetResult();
await stopped.Task;
