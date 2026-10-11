using Damadama.Habits;
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
        ValidateIssuer = true, ValidIssuer = builder.Configuration["Clerk:Issuer"],
        ValidateAudience = false, ValidateLifetime = true, ValidateIssuerSigningKey = true,
        RequireSignedTokens = true, ValidAlgorithms = [SecurityAlgorithms.RsaSha256], ClockSkew = TimeSpan.FromSeconds(5)
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
var app = builder.Build();
app.UseExceptionHandler();
app.UseStatusCodePages(async context => await Results.Problem(statusCode: context.HttpContext.Response.StatusCode,
    title: context.HttpContext.Response.StatusCode == 400 ? "Check the request fields and their types." : "Habit not found.")
    .ExecuteAsync(context.HttpContext));
using (var scope = app.Services.CreateScope())
    await scope.ServiceProvider.GetRequiredService<HabitsDb>().Database.MigrateAsync();
app.UseAuthentication();
app.UseAuthorization();
app.MapPost("/api/habits", async (CreateHabit input, System.Security.Claims.ClaimsPrincipal user,
    HabitsDb db, TimeProvider clock, ILogger<HabitsDb> logger, CancellationToken cancellationToken) =>
{
    var habit = await db.Create(input, user.FindFirst("sub")!.Value, clock, cancellationToken);
    logger.LogInformation("Habit {HabitId} committed for account {OwnerId}", habit.Id, habit.OwnerId);
    return Results.Created($"/api/habits/{habit.Id}", HabitResponse.From(habit));
}).RequireAuthorization();
app.MapGet("/api/habits", async (System.Security.Claims.ClaimsPrincipal user, HabitsDb db, CancellationToken cancellationToken) =>
    (await db.Habits.AsNoTracking().Include(h => h.Schedule).Where(h => h.OwnerId == user.FindFirst("sub")!.Value)
        .OrderBy(h => h.CreatedAt).ThenBy(h => h.Id)
        .ToListAsync(cancellationToken)).Select(HabitResponse.From)).RequireAuthorization();
app.MapGet("/api/habits/{id:guid}", async (Guid id, System.Security.Claims.ClaimsPrincipal user, HabitsDb db, CancellationToken cancellationToken) =>
{
    var habit = await db.Habits.AsNoTracking().Include(h => h.Schedule)
        .SingleOrDefaultAsync(h => h.Id == id && h.OwnerId == user.FindFirst("sub")!.Value, cancellationToken);
    return habit is null ? Results.NotFound() : Results.Ok(HabitResponse.From(habit));
}).RequireAuthorization();
app.Run();
public partial class Program;

public sealed record HabitResponse(Guid Id, string Name, string Good, string Better, string Best,
    DateTimeOffset CreatedAt, InitialSchedule Schedule)
{
    public static HabitResponse From(Habit habit) => new(habit.Id, habit.Name, habit.Good, habit.Better,
        habit.Best, habit.CreatedAt, habit.Schedule);
}
