using Damadama.Habits;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);
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
});
builder.Services.AddAuthorization();
var app = builder.Build();
using (var scope = app.Services.CreateScope())
    await scope.ServiceProvider.GetRequiredService<HabitsDb>().Database.MigrateAsync();
app.UseAuthentication();
app.UseAuthorization();
app.MapPost("/api/habits", async (CreateHabit input, System.Security.Claims.ClaimsPrincipal user,
    HabitsDb db, TimeProvider clock, CancellationToken cancellationToken) =>
{
    var habit = await db.Create(input, user.FindFirst("sub")!.Value, clock, cancellationToken);
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
