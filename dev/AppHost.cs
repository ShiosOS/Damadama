using Microsoft.Extensions.Configuration;

var builder = DistributedApplication.CreateBuilder(args);
var password = builder.AddParameter("postgresPassword", secret: true);
var database = builder.AddPostgres("postgres", password: password)
    .WithImageTag("17-alpine")
    .WithDataVolume("damadama-first-slice-postgres")
    .AddDatabase("habits");
var api = builder.AddProject<Projects.Damadama>("api")
    .WithReference(database)
    .WaitFor(database)
    .WithHttpEndpoint(port: 5050, name: "http")
    .WithHttpHealthCheck("/health/ready")
    .WithEnvironment("Clerk__Issuer", builder.Configuration["Clerk:Issuer"])
    .WithEnvironment("Clerk__PublishableKey", builder.Configuration["Clerk:PublishableKey"]);
var origins = builder.Configuration.GetSection("Clerk:AuthorizedParties").Get<string[]>() ?? [];
for (var index = 0; index < origins.Length; index++)
    api.WithEnvironment($"Clerk__AuthorizedParties__{index}", origins[index]);
builder.AddViteApp("web", "../web")
    .WithBun()
    .WithEndpoint("http", endpoint => endpoint.Port = 5173)
    .WithEnvironment("API_URL", api.GetEndpoint("http"))
    .WaitFor(api);
builder.Build().Run();
