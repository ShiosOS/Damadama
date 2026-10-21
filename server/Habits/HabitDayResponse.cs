using Damadama.Entries;

namespace Damadama.Habits;

public sealed record HabitDayResponse(DateOnly Date, HabitResponse[] Habits, EntryResponse[] Entries);
