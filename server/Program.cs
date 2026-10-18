using Damadama.Habits;
using Damadama.Entries;
using Damadama;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(options => options.IncludeScopes = true);
builder.Services.AddProblemDetails(options => options.CustomizeProblemDetails = context =>
    context.ProblemDetails.Extensions["traceId"] = context.HttpContext.TraceIdentifier);
builder.Services.AddExceptionHandler<ApiErrors>();
builder.Services.AddDbContext<HabitsDb>(options => options.UseNpgsql(builder.Configuration.GetConnectionString("habits")));
builder.Services.AddSingleton(TimeProvider.System);
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
builder.Services.AddSingleton<ApiRepresentations>();
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
app.UseApiNegotiation();
app.MapHealthChecks("/health/live", new() { Predicate = _ => false }).WithName("health-live").WithMetadata(new ApiContractMetadata("control-plane"));
app.MapHealthChecks("/health/ready", new() { Predicate = check => check.Tags.Contains("ready") }).WithName("health-ready").WithMetadata(new ApiContractMetadata("control-plane"));
app.MapMethods("/api/config", ["GET", "HEAD"], (IConfiguration configuration, ApiRepresentations representations) =>
    ApiRepresentations.Ok(representations.Bootstrap(configuration["Clerk:PublishableKey"])))
    .WithName("application-config").WithMetadata(new ApiContractMetadata("bootstrap"));
app.MapMethods("/api/profile", ["GET", "HEAD"], (ApiRepresentations representations) => ApiRepresentations.Ok(representations.Profile()))
    .WithName("application-profile").WithMetadata(new ApiContractMetadata("profile"));
app.MapGet("/sw.js", WorkerRetirement.Respond);
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapPost("/api/habits", async (CreateHabit input, System.Security.Claims.ClaimsPrincipal user,
    HabitsDb db, TimeProvider clock, ILogger<HabitsDb> logger, ApiRepresentations representations, HttpResponse response, CancellationToken cancellationToken) =>
{
    var habit = await db.Create(input, user.FindFirst("sub")!.Value, clock, cancellationToken);
    logger.LogInformation("Habit {HabitId} committed for account {OwnerId}", habit.Id, habit.OwnerId);
    return ApiRepresentations.Created(representations.Habit(habit), response);
}).WithName("create-habit").WithMetadata(new ApiContractMetadata("resource")).RequireAuthorization();
app.MapMethods("/api/habits", ["GET", "HEAD"], async (System.Security.Claims.ClaimsPrincipal user, HabitsDb db, ApiRepresentations representations, CancellationToken cancellationToken) =>
    ApiRepresentations.Ok(representations.Collection("habits", "list-habits", (await db.Habits.AsNoTracking().Include(h => h.Schedule).Where(h => h.OwnerId == user.FindFirst("sub")!.Value)
        .OrderBy(h => h.CreatedAt).ThenBy(h => h.Id)
        .ToListAsync(cancellationToken)).Select(habit => representations.Habit(habit)))))
    .WithName("list-habits").WithMetadata(new ApiContractMetadata("resource")).RequireAuthorization();
app.MapMethods("/api/habits/{id:guid}", ["GET", "HEAD"], async (Guid id, System.Security.Claims.ClaimsPrincipal user, HabitsDb db, ApiRepresentations representations, CancellationToken cancellationToken) =>
{
    var habit = await db.Habits.AsNoTracking().Include(h => h.Schedule)
        .SingleOrDefaultAsync(h => h.Id == id && h.OwnerId == user.FindFirst("sub")!.Value, cancellationToken);
    return habit is null ? Results.NotFound() : ApiRepresentations.Ok(representations.Habit(habit));
}).WithName("read-habit").WithMetadata(new ApiContractMetadata("resource")).RequireAuthorization();
app.MapScheduledHabits();
app.MapEntries();
app.MapApiOptions("/api/config", "options-application-config", ["GET", "HEAD", "OPTIONS"], false);
app.MapApiOptions("/api/profile", "options-application-profile", ["GET", "HEAD", "OPTIONS"], false);
app.MapApiOptions("/api/habits", "options-list-habits", ["GET", "HEAD", "POST", "OPTIONS"], true);
app.MapApiOptions("/api/habits/{id:guid}", "options-read-habit", ["GET", "HEAD", "OPTIONS"], true);
app.MapApiOptions("/api/habits/scheduled", "options-scheduled-habits", ["GET", "HEAD", "OPTIONS"], true);
app.MapApiOptions("/api/entries", "options-entries-by-date", ["GET", "HEAD", "OPTIONS"], true);
app.MapApiOptions("/api/habits/{id:guid}/entries/{date}", "options-read-entry", ["GET", "HEAD", "PUT", "OPTIONS"], true);
app.MapFallbackToFile("index.html").WithName("application-shell");
app.Run();
public partial class Program;

public sealed record HabitResponse(Guid Id, string Name, string Good, string Better, string Best,
    DateTimeOffset CreatedAt, InitialSchedule Schedule)
{
    public static HabitResponse From(Habit habit) => new(habit.Id, habit.Name, habit.Levels.Good, habit.Levels.Better,
        habit.Levels.Best, habit.CreatedAt, habit.Schedule);
}
