using System.Text.Json;

if (args is ["doctorprobe"])
{
    Console.WriteLine("Finite doctor plugin accepted");
    return 0;
}

if (args is not ["docker-cli-plugin-metadata"])
{
    return 2;
}

var directory = Environment.GetEnvironmentVariable("DAMADAMA_DOCKER_PLUGIN_LEDGER");
if (string.IsNullOrEmpty(directory) || !Directory.Exists(directory))
{
    return 3;
}

var invocation = Guid.NewGuid().ToString("N");
var identity = JsonSerializer.Serialize(new
{
    executable = Path.GetFileNameWithoutExtension(Environment.ProcessPath),
    pid = Environment.ProcessId
});
File.WriteAllText(Path.Combine(directory, invocation + ".invoked"), identity);
Thread.Sleep(250);
File.WriteAllText(Path.Combine(directory, invocation + ".completed"), identity);
Console.WriteLine(JsonSerializer.Serialize(new
{
    SchemaVersion = "0.1.0",
    Vendor = "Damadama",
    Version = "1.0.0",
    ShortDescription = "Finite doctor regression fixture"
}));
return 0;
