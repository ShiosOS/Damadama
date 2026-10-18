namespace Damadama.Tests;

internal enum EntryWriteOperation { Insert, Update }
internal enum EntryFailureTiming { BeforeWrite, AtCommit }

internal sealed class EntryWriteFailure(Func<string, Task> execute) : IAsyncDisposable
{
    private const string Name = "reject_entry_write";

    public static async Task<EntryWriteFailure> Install(Func<string, Task> execute,
        EntryWriteOperation operation, EntryFailureTiming timing)
    {
        await execute("""
            CREATE FUNCTION reject_entry_write() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'test-owned entry failure'; END; $$;
            """);
        try
        {
            var verb = operation == EntryWriteOperation.Insert ? "INSERT" : "UPDATE";
            var trigger = timing == EntryFailureTiming.AtCommit
                ? $"CREATE CONSTRAINT TRIGGER {Name} AFTER {verb} ON \"DailyEntries\" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION {Name}()"
                : $"CREATE TRIGGER {Name} BEFORE {verb} ON \"DailyEntries\" FOR EACH ROW EXECUTE FUNCTION {Name}()";
            await execute(trigger);
            return new EntryWriteFailure(execute);
        }
        catch
        {
            await execute($"DROP FUNCTION {Name}()");
            throw;
        }
    }

    public ValueTask DisposeAsync()
    {
        return new ValueTask(execute($"DROP TRIGGER {Name} ON \"DailyEntries\"; DROP FUNCTION {Name}()"));
    }
}
