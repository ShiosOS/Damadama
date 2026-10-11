using Npgsql;
using NUnit.Framework;
using Testcontainers.PostgreSql;

namespace Damadama.Tests;

[SetUpFixture]
public class DatabaseFixture
{
    public static PostgreSqlContainer Database { get; } = new PostgreSqlBuilder("postgres:17-alpine").Build();
    [OneTimeSetUp] public Task Start() => Database.StartAsync();
    [OneTimeTearDown] public async Task Stop() => await Database.DisposeAsync();

    public static async Task Execute(string sql)
    {
        await using var connection = new NpgsqlConnection(Database.GetConnectionString());
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand(sql, connection);
        await command.ExecuteNonQueryAsync();
    }

    public static Task Reset() => Execute("TRUNCATE \"Habits\" CASCADE");

    public static async Task<long> Count(string table)
    {
        await using var connection = new NpgsqlConnection(Database.GetConnectionString());
        await connection.OpenAsync();
        await using var command = new NpgsqlCommand($"SELECT count(*) FROM \"{table}\"", connection);
        return Convert.ToInt64(await command.ExecuteScalarAsync());
    }
}
