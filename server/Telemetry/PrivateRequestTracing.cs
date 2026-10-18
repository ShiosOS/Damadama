using System.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using OpenTelemetry;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace Damadama.Telemetry;

public static class PrivateRequestTracing
{
    public static IServiceCollection AddPrivateRequestTracing(this IServiceCollection services)
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT")))
            return services;

        services.AddOpenTelemetry()
            .ConfigureResource(resource => resource.Clear().AddService(
                Environment.GetEnvironmentVariable("OTEL_SERVICE_NAME") ?? "damadama",
                serviceVersion: Environment.GetEnvironmentVariable("OTEL_SERVICE_VERSION")))
            .WithTracing(tracing => tracing
                .AddAspNetCoreInstrumentation(options => options.RecordException = false)
                .AddHttpClientInstrumentation(options => options.RecordException = false)
                .AddSource("Npgsql")
                .AddProcessor(new PrivateSpanProcessor())
                .AddOtlpExporter(exporter =>
                {
                    exporter.TimeoutMilliseconds = Math.Min(exporter.TimeoutMilliseconds, 1000);
                    exporter.BatchExportProcessorOptions = new()
                    {
                        MaxQueueSize = 256,
                        MaxExportBatchSize = 64,
                        ScheduledDelayMilliseconds = 200,
                        ExporterTimeoutMilliseconds = 1500
                    };
                }));
        return services;
    }

    private sealed class PrivateSpanProcessor : BaseProcessor<Activity>
    {
        private static readonly HashSet<string> Methods = new(StringComparer.Ordinal)
        {
            "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"
        };

        public override void OnEnd(Activity activity)
        {
            // Activity cannot remove events or links. The SDK batch processor rejects unrecorded spans.
            var privateEvents = activity.Events.Any(item => activity.Source.Name != "Npgsql" ||
                item.Name != "received-first-response" || item.Tags.Any());
            if (privateEvents || activity.Links.Any())
            {
                activity.ActivityTraceFlags &= ~ActivityTraceFlags.Recorded;
                return;
            }

            var method = activity.GetTagItem("http.request.method") as string;
            var status = activity.GetTagItem("http.response.status_code");
            foreach (var tag in activity.TagObjects.ToArray())
                activity.SetTag(tag.Key, null);

            activity.TraceStateString = string.Empty;
            activity.SetStatus(activity.Status);
            if (activity.Source.Name == "Npgsql")
            {
                activity.DisplayName = "PostgreSQL";
                activity.SetTag("db.system.name", "postgresql");
                return;
            }

            activity.DisplayName = "HTTP request";
            if (method is not null && Methods.Contains(method))
                activity.SetTag("http.request.method", method);
            if (status is int code && code is >= 100 and <= 599)
                activity.SetTag("http.response.status_code", code);
            else if (status is long longCode && longCode is >= 100 and <= 599)
                activity.SetTag("http.response.status_code", longCode);
        }
    }
}
