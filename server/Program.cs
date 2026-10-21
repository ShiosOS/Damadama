using Damadama.Telemetry;
using Damadama.Habits;
using Damadama.Entries;
using Damadama;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(options => options.IncludeScopes = false);
builder.Services.AddRequestDiagnostics();
builder.Services.AddPrivateRequestTracing();
builder.Services.AddDbContext<HabitsDb>(options => options.UseNpgsql(builder.Configuration.GetConnectionString("habits")));
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddScoped<HabitHistory>();
builder.Services.AddScoped<IHistoryReader>(services => services.GetRequiredService<HabitHistory>());
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(options =>
{
    options.Authority = builder.Configuration["Clerk:Issuer"];
    options.MapInboundClaims = false;
    options.TokenValidationParameters = new TokenValidationParameters
    {
        ValidateIssuer = true,
        ValidIssuer = builder.Configuration["Clerk:Issuer"],
        ValidateAudience = false,
        ValidateLifetime = true,
        ValidateIssuerSigningKey = true,
        RequireSignedTokens = true,
        ValidAlgorithms = [SecurityAlgorithms.RsaSha256],
        ClockSkew = TimeSpan.FromSeconds(5)
    };
    options.Events = new JwtBearerEvents
    {
        OnTokenValidated = context =>
        {
            var user = context.Principal!;
            var origins = builder.Configuration.GetSection("Clerk:AuthorizedParties").Get<string[]>() ?? [];
            var origin = user.FindFirst("azp")?.Value;
            if (string.IsNullOrWhiteSpace(user.FindFirst("sub")?.Value) ||
                origin is not null && !origins.Contains(origin, StringComparer.Ordinal) ||
                user.FindFirst("sts")?.Value == "pending")
                context.Fail("The account session is invalid.");
            return Task.CompletedTask;
        },
        OnChallenge = async context =>
        {
            context.HandleResponse();
            context.Response.Headers.WWWAuthenticate = "Bearer";
            await Results.Problem(statusCode: 401, title: "Sign in to continue.",
                detail: "A valid account session is required.").ExecuteAsync(context.HttpContext);
        }
    };
});
builder.Services.AddAuthorization();
builder.Services.AddApiContract();
builder.Services.AddHealthChecks().AddCheck<DatabaseReadiness>("database", tags: ["ready"]);
var app = builder.Build();
app.UseRouting();
app.UseApiProtocol();
app.UseExceptionHandler();
app.UseStatusCodePages(async context => await Results.Problem(statusCode: context.HttpContext.Response.StatusCode,
    title: context.HttpContext.Response.StatusCode == 400 ? "Check the request fields and their types." : "Habit not found.")
    .ExecuteAsync(context.HttpContext));
using (var scope = app.Services.CreateScope())
    await scope.ServiceProvider.GetRequiredService<HabitsDb>().Database.MigrateAsync();
app.UseAuthentication();
app.UseAuthorization();
app.MapHealthChecks("/health/live", new() { Predicate = _ => false }).WithName("health-live").ExcludeFromDescription();
app.MapHealthChecks("/health/ready", new()
{
    Predicate = check => check.Tags.Contains("ready"),
    ResponseWriter = RequestDiagnostics.WriteReadinessResponse
}).WithName("health-ready").ExcludeFromDescription();
app.MapGet("/api/config", (IConfiguration configuration) => TypedResults.Ok(new ApplicationConfig(configuration["Clerk:PublishableKey"])))
    .WithName("application-config").WithTags("Configuration").WithSummary("Read public application configuration")
    .ProducesProblem(400);
app.MapGet("/sw.js", WorkerRetirement.Respond).WithName("worker-retirement").ExcludeFromDescription();
if (app.Environment.IsDevelopment() || app.Environment.IsEnvironment("Testing"))
    app.MapOpenApi().WithName("openapi-document");
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapHabits();
app.MapEntries();
app.MapFallbackToFile("index.html").WithName("application-shell");
app.Run();
public partial class Program;
public sealed record ApplicationConfig(string? ClerkPublishableKey);

public sealed record HabitResponse(Guid Id, string Name, string Good, string Better, string Best,
    DateTimeOffset CreatedAt, InitialSchedule Schedule, bool Archived = false, long Revision = 0)
{
    public static HabitResponse From(Habit habit) => new(habit.Id, habit.Name, habit.Levels.Good, habit.Levels.Better,
        habit.Levels.Best, habit.CreatedAt, habit.Schedule);
}
