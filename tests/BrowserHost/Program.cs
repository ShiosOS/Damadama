using System.Text.Json;
using Damadama.Tests;
using Testcontainers.PostgreSql;

await using var database = new PostgreSqlBuilder("postgres:17-alpine").Build();
await database.StartAsync();
using var app = new TestApp(database.GetConnectionString());
app.UseKestrel(5055);
await File.WriteAllTextAsync("tests/Browser/fixture.json", JsonSerializer.Serialize(new
{
    owner = app.Token(),
    other = app.Token("other-account"),
    reload = app.Token("reload-account"),
    list = app.Token("list-account"),
    expired = app.Token("expired-account", expired: true),
    errors = app.Token("errors-account"),
    cleanup = app.Token("cleanup-account"),
    stale = app.Token("stale-account")
}));
using var client = app.CreateClient();
Console.WriteLine("Browser fixture ready at http://localhost:5055. This does not test Clerk sign-in.");
var stopped = new TaskCompletionSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; stopped.TrySetResult(); };
System.Runtime.Loader.AssemblyLoadContext.Default.Unloading += _ => stopped.TrySetResult();
await stopped.Task;
