using Damadama.Entries;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Damadama.Habits;

public sealed class HabitsDb(DbContextOptions<HabitsDb> options) : DbContext(options)
{
    public DbSet<Habit> Habits => Set<Habit>();
    public DbSet<InitialSchedule> InitialSchedules => Set<InitialSchedule>();
    public DbSet<Entry> Entries => Set<Entry>();
    public DbSet<HabitChange> HabitChanges => Set<HabitChange>();

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
        model.Entity<HabitChange>(change =>
        {
            change.ToTable("HabitChanges", table =>
            {
                table.HasCheckConstraint("ChangeSequence", "\"Sequence\" >= 0 AND ((\"Kind\" = 0 AND \"Sequence\" = 0) OR (\"Kind\" IN (1,2) AND \"Sequence\" > 0))");
                table.HasCheckConstraint("ChangeDefinitions", "(\"Kind\" IN (0,1) AND num_nonnulls(\"Name\",\"Good\",\"Better\",\"Best\") = 4 AND length(trim(\"Name\")) > 0 AND length(trim(\"Good\")) > 0 AND length(trim(\"Better\")) > 0 AND length(trim(\"Best\")) > 0) OR (\"Kind\" = 2 AND \"Name\" IS NULL AND \"Good\" IS NULL AND \"Better\" IS NULL AND \"Best\" IS NULL)");
                table.HasCheckConstraint("ChangeRecurrence", "(\"Weekdays\" IS NULL AND \"RepeatEveryWeeks\" IS NULL AND \"FirstWeekMonday\" IS NULL AND \"Kind\" <> 0) OR (\"Weekdays\" IS NOT NULL AND cardinality(\"Weekdays\") > 0 AND \"Weekdays\" <@ ARRAY[1,2,3,4,5,6,7] AND \"RepeatEveryWeeks\" IS NOT NULL AND \"RepeatEveryWeeks\" > 0 AND \"FirstWeekMonday\" IS NOT NULL AND \"Kind\" <> 2)");
                table.HasCheckConstraint("ChangeChoice", "\"Choice\" IS NULL OR (\"Choice\" IN (0,1) AND (\"Kind\" = 2 OR (\"Kind\" = 1 AND \"Weekdays\" IS NOT NULL)))");
                table.HasCheckConstraint("ChangeAdmission", "(\"AdmissionThrough\" IS NULL AND (\"Kind\" = 0 OR (\"Kind\" = 1 AND \"Weekdays\" IS NULL))) OR (\"AdmissionThrough\" IS NOT NULL AND (\"Kind\" = 2 OR (\"Kind\" = 1 AND \"Weekdays\" IS NOT NULL)))");
            });
            change.HasKey(c => new { c.HabitId, c.Sequence });
            change.HasIndex(c => new { c.HabitId, c.MutationId }).IsUnique();
            change.HasOne<Habit>().WithMany().HasForeignKey(c => c.HabitId).IsRequired();
        });
    }

    public async Task<Habit> Create(CreateHabit input, string owner, TimeProvider clock, CancellationToken cancellationToken)
    {
        var habit = Habit.Create(input, owner, clock.GetUtcNow());
        await using var transaction = await Database.BeginTransactionAsync(cancellationToken);
        Habits.Add(habit);
        await SaveChangesAsync(cancellationToken);
        await Entry(habit).ReloadAsync(cancellationToken);
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
