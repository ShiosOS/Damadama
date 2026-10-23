using System.Text.Json.Nodes;
using Damadama.Entries;
using Damadama.Habits;
using Damadama.Heatmap;
using Microsoft.AspNetCore.Authorization;
using Microsoft.OpenApi;

namespace Damadama;

public static class ApiContract
{
    public static IServiceCollection AddApiContract(this IServiceCollection services)
    {
        services.ConfigureHttpJsonOptions(options => options.SerializerOptions.NumberHandling = System.Text.Json.Serialization.JsonNumberHandling.Strict);
        services.AddOpenApi(options =>
        {
            options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1;
            options.AddDocumentTransformer((document, context, cancellationToken) =>
            {
                document.Info = new() { Title = "Damadama API", Version = "v1", Description = "Account-owned habits and dated entries." };
                document.Servers = [new() { Url = "/" }];
                document.Components ??= new();
                document.Components.SecuritySchemes = new Dictionary<string, IOpenApiSecurityScheme>
                {
                    ["Bearer"] = new OpenApiSecurityScheme { Type = SecuritySchemeType.Http, Scheme = "bearer", BearerFormat = "JWT" }
                };
                foreach (var path in document.Paths.Values)
                    foreach (var operation in path.Operations?.Values.AsEnumerable() ?? [])
                        if (operation.Responses?.ContainsKey("401") == true)
                            operation.Security = [new() { [new OpenApiSecuritySchemeReference("Bearer", document)] = [] }];
                        else operation.Security = [];
                return Task.CompletedTask;
            });
            options.AddOperationTransformer((operation, context, cancellationToken) =>
            {
                foreach (var parameter in operation.Parameters ?? [])
                    if (parameter.Name is "date" or "scheduledOn" or "deviceToday" && parameter.Schema is OpenApiSchema schema)
                    {
                        schema.Type = JsonSchemaType.String;
                        schema.Format = "date";
                        schema.Pattern = "^\\d{4}-\\d{2}-\\d{2}$";
                    }
                foreach (var (status, declaredResponse) in operation.Responses ?? [])
                {
                    if (declaredResponse is not OpenApiResponse response) continue;
                    response.Headers ??= new Dictionary<string, IOpenApiHeader>();
                    response.Headers["Cache-Control"] = new OpenApiHeader
                    {
                        Required = true,
                        Description = "Must include private and no-store directives. Directive order is insignificant.",
                        Schema = new OpenApiSchema { Type = JsonSchemaType.String, MinLength = 1 }
                    };
                    if (status == "201") response.Headers["Location"] = new OpenApiHeader
                    {
                        Required = true,
                        Description = "Canonical resource URI, readable with GET.",
                        Schema = new OpenApiSchema { Type = JsonSchemaType.String, Format = "uri-reference" }
                    };
                    if (status == "401") response.Headers["WWW-Authenticate"] = new OpenApiHeader
                    {
                        Required = true,
                        Description = "The required authentication scheme.",
                        Schema = new OpenApiSchema { Type = JsonSchemaType.String, Const = "Bearer" }
                    };
                }
                if (context.Description.ActionDescriptor.EndpointMetadata.OfType<IAuthorizeData>().Any() &&
                    operation.Responses?.ContainsKey("401") != true)
                    throw new InvalidOperationException("Private API operations must declare their 401 response.");
                return Task.CompletedTask;
            });
            options.AddSchemaTransformer((schema, context, cancellationToken) =>
            {
                var type = context.JsonTypeInfo.Type;
                if (type == typeof(CreateHabit) || type == typeof(WriteEntry) || type == typeof(HabitResponse) ||
                    type == typeof(EntryResponse) || type == typeof(InitialSchedule) || type == typeof(ApplicationConfig) ||
                    type == typeof(EditHabit) || type == typeof(ArchiveHabit) || type == typeof(Recurrence) ||
                    type == typeof(HeatmapResponse) || type == typeof(HeatmapDate) || type == typeof(HabitDayResponse))
                {
                    schema.Required = schema.Properties?.Keys.ToHashSet() ?? [];
                    if (type == typeof(EditHabit)) schema.Required.ExceptWith(["schedule", "todayChoice"]);
                    if (type == typeof(ArchiveHabit)) schema.Required.Remove("todayChoice");
                    foreach (var (name, property) in schema.Properties?.AsEnumerable() ?? [])
                    {
                        if (property is not OpenApiSchema value) continue;
                        if (type != typeof(ApplicationConfig) && name is not ("schedule" or "todayChoice" or "completion")) value.Type &= ~JsonSchemaType.Null;
                        if (type == typeof(HeatmapDate) && name == "completion")
                        {
                            value.Minimum = "0";
                            value.Maximum = "1";
                        }
                        if (type == typeof(HeatmapDate) && name is "scheduledCount" or "earnedPoints" or "maximumPoints")
                            value.Minimum = "0";
                        if (type == typeof(HeatmapResponse) && name == "days")
                        {
                            value.MinItems = 365;
                            value.MaxItems = 365;
                        }
                        if (name == "todayChoice") value.Pattern = "^(Keep|Remove)$";
                        if (name is "name" or "good" or "better" or "best" or "timeZone")
                        {
                            value.MinLength = 1;
                            value.Pattern = "\\S";
                        }
                        if (name is "deviceToday")
                        {
                            value.Format = "date";
                            value.Pattern = "^\\d{4}-\\d{2}-\\d{2}$";
                        }
                        if (name == "result") value.Enum = [.. Enum.GetNames<EntryResult>().Select(result => JsonValue.Create(result))];
                        if (name == "repeatEveryWeeks") value.Minimum = "1";
                        if (name == "weekdays")
                        {
                            value.MinItems = 1;
                            if (value.Items is OpenApiSchema item) { item.Minimum = "1"; item.Maximum = "7"; }
                        }
                    }
                }
                if (type == typeof(Microsoft.AspNetCore.Mvc.ProblemDetails) || type == typeof(EntryConflictProblem) || type == typeof(HabitMutationProblem))
                {
                    schema.Required = new HashSet<string> { "status", "title", "type" };
                    if (type == typeof(EntryConflictProblem)) schema.Required.Add("current");
                    if (type == typeof(HabitMutationProblem)) schema.Required.Add("code");
                }
                return Task.CompletedTask;
            });
        });
        return services;
    }
}
