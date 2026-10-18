using Damadama.Entries;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Damadama.Habits;

public sealed class HabitsDb(DbContextOptions<HabitsDb> options) : DbContext(options)
{
    public DbSet<Habit> Habits => Set<Habit>();
    public DbSet<InitialSchedule> InitialSchedules => Set<InitialSchedule>();
    public DbSet<Entry> Entries => Set<Entry>();

    protected override void OnModelCreating(ModelBuilder model)
    {
        model.Entity<Habit>(habit =>
        {
            habit.ToTable("Habits");
            habit.HasKey(h => h.Id);
            habit.HasIndex(h => new { h.OwnerId, h.CreatedAt });
            habit.ComplexProperty(h => h.Levels, levels =>
            {
                levels.Property(l => l.Good).HasColumnName("Good").IsRequired();
                levels.Property(l => l.Better).HasColumnName("Better").IsRequired();
                levels.Property(l => l.Best).HasColumnName("Best").IsRequired();
            });
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
        model.Entity<Entry>(entry =>
        {
            entry.ToTable("DailyEntries", table => table.HasCheckConstraint("EntryResult", "\"Result\" BETWEEN 0 AND 4"));
            entry.HasKey(e => new { e.HabitId, e.CalendarDate });
            entry.HasOne<Habit>().WithMany().HasForeignKey(e => e.HabitId).IsRequired();
            entry.Property(e => e.EditedAt).HasColumnName("EditedAtTicks")
                .HasConversion(instant => instant.UtcTicks, ticks => new DateTimeOffset(ticks, TimeSpan.Zero));
            entry.ComplexProperty(e => e.OriginalLevels, levels =>
            {
                levels.Property(l => l.Good).HasColumnName("Good").IsRequired();
                levels.Property(l => l.Better).HasColumnName("Better").IsRequired();
                levels.Property(l => l.Best).HasColumnName("Best").IsRequired();
            });
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
