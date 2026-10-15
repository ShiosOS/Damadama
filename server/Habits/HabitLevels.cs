namespace Damadama.Habits;

public sealed record HabitLevels
{
    private HabitLevels() { }
    public string Good { get; private set; } = "";
    public string Better { get; private set; } = "";
    public string Best { get; private set; } = "";

    public static HabitLevels Create(string? good, string? better, string? best)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(good, nameof(Good));
        ArgumentException.ThrowIfNullOrWhiteSpace(better, nameof(Better));
        ArgumentException.ThrowIfNullOrWhiteSpace(best, nameof(Best));
        return new HabitLevels { Good = good, Better = better, Best = best };
    }
}
