using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Damadama.Habits;

public sealed class HabitsDb(DbContextOptions<HabitsDb> options) : DbContext(options)
{
    public DbSet<Habit> Habits => Set<Habit>();
    public DbSet<InitialSchedule> InitialSchedules => Set<InitialSchedule>();

    protected override void OnModelCreating(ModelBuilder model)
    {
        model.Entity<Habit>(habit =>
        {
            habit.ToTable("Habits");
            habit.HasKey(h => h.Id);
            habit.HasIndex(h => new { h.OwnerId, h.CreatedAt });
            habit.HasOne(h => h.Schedule).WithOne().HasForeignKey<InitialSchedule>(s => s.HabitId).IsRequired();
        });
        model.Entity<InitialSchedule>(schedule =>
        {
            schedule.ToTable("InitialSchedules", table =>
            {
                table.HasCheckConstraint("PositiveRepeat", "\"RepeatEveryWeeks\" > 0");
                table.HasCheckConstraint("SelectedWeekdays", "cardinality(\"Weekdays\") > 0 AND \"Weekdays\" <@ ARRAY[1,2,3,4,5,6,7]");
            });
            schedule.HasKey(s => s.HabitId);
        });
    }

    public async Task<Habit> Create(CreateHabit input, string owner, TimeProvider clock, CancellationToken cancellationToken)
    {
        var habit = Habit.Create(input, owner, clock.GetUtcNow());
        await using var transaction = await Database.BeginTransactionAsync(cancellationToken);
        Habits.Add(habit);
        await SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return habit;
    }
}

public sealed class HabitsDbDesignFactory : IDesignTimeDbContextFactory<HabitsDb>
{
    public HabitsDb CreateDbContext(string[] args) => new(new DbContextOptionsBuilder<HabitsDb>()
        .UseNpgsql(Environment.GetEnvironmentVariable("ConnectionStrings__habits") ?? "Host=localhost;Database=habits")
        .Options);
}
