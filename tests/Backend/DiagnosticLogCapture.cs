using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using NUnit.Framework;

namespace Damadama.Testing;

internal sealed record CapturedLog(string Category, LogLevel Level, string Message,
    IReadOnlyList<KeyValuePair<string, object?>> State, Exception? Exception, IReadOnlyList<object?> Scopes)
{
    public object? Field(string name) => State.Single(pair => pair.Key == name).Value;
}

[ProviderAlias("DiagnosticCapture")]
internal sealed class DiagnosticLogCapture : ILoggerProvider, ISupportExternalScope
{
    private readonly ConcurrentQueue<CapturedLog> entries = new();
    private IExternalScopeProvider scopes = new LoggerExternalScopeProvider();
    public IReadOnlyList<CapturedLog> Entries => entries.ToArray();

    public ILogger CreateLogger(string categoryName) => new CaptureLogger(this, categoryName);
    public void SetScopeProvider(IExternalScopeProvider scopeProvider) => scopes = scopeProvider;
    public void Dispose() { }

    public void AssertPrivate(params string[] sentinels)
    {
        foreach (var entry in Entries)
        {
            Assert.That(entry.Category == typeof(RequestDiagnostics).FullName, Is.True, "An unapproved log category was enabled.");
            Assert.That(entry.Level, Is.EqualTo(LogLevel.Error));
            Assert.That(entry.Exception is null, Is.True, "The diagnostic stream included an exception argument.");
            Assert.That(entry.Scopes.Count, Is.Zero, "The diagnostic stream included a scope.");
            Assert.That(entry.State.Count, Is.EqualTo(7), "The diagnostic stream included unapproved state fields.");
            Assert.That(entry.State.Select(pair => pair.Key).ToHashSet().SetEquals(new[]
            { "Revision", "Environment", "Route", "Status", "TraceId", "Classification", "{OriginalFormat}" }), Is.True,
                "The diagnostic stream included unapproved state fields.");
            var complete = JsonSerializer.Serialize(new { entry.Message, entry.State, entry.Scopes });
            foreach (var sentinel in sentinels)
                Assert.That(complete.Contains(sentinel, StringComparison.Ordinal), Is.False, "The diagnostic stream included private data.");
        }
    }

    private sealed class CaptureLogger(DiagnosticLogCapture provider, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => provider.scopes.Push(state);
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            var capturedScopes = new List<object?>();
            provider.scopes.ForEachScope((scope, values) => values.Add(scope), capturedScopes);
            var fields = state is IEnumerable<KeyValuePair<string, object?>> structured
                ? structured.ToArray() : [new KeyValuePair<string, object?>("state", state)];
            provider.entries.Enqueue(new CapturedLog(category, logLevel, formatter(state, exception), fields,
                exception, capturedScopes));
        }
    }
}
