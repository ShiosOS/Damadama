using Damadama.Tests;
using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Routing;
using NUnit.Framework;

namespace Damadama.Protocol;

internal enum ResourceKind { Collection, Member, Configuration }
internal sealed record ApiScenario(string Method, string Path, string Name, ResourceKind Kind, Func<ContractRun, Task> Exercise)
{
    internal string Key => $"{Method} {Path}";
    internal bool Authorized => Kind != ResourceKind.Configuration;
}
internal sealed record ApiObservation(string Path, string Method, int Status, string MediaType,
    Dictionary<string, string> Headers, JsonElement Body);

internal static class ApiContractAssertions
{
    internal static List<string> Inventory(IEnumerable<Endpoint> endpoints, JsonElement document, IReadOnlyList<ApiScenario> scenarios)
    {
        var failures = new List<string>();
        var actual = new HashSet<string>(StringComparer.Ordinal);
        var documented = new HashSet<string>(StringComparer.Ordinal);
        foreach (var endpoint in endpoints.OfType<RouteEndpoint>())
        {
            if (Operational(endpoint)) continue;
            var raw = endpoint.RoutePattern.RawText ?? "";
            var path = raw.Replace("{id:guid}", "{id}");
            var methods = endpoint.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? [];
            var name = endpoint.Metadata.GetMetadata<IEndpointNameMetadata>()?.EndpointName;
            var authorized = endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>().Count > 0 &&
                endpoint.Metadata.GetMetadata<IAllowAnonymous>() is null;
            if (endpoint.Metadata.GetMetadata<IExcludeFromDescriptionMetadata>()?.ExcludeFromDescription == true)
                failures.Add($"endpoint.hidden:{raw}");
            if (methods.Count == 0) failures.Add($"endpoint.methods:{raw}");
            foreach (var method in methods)
            {
                var key = $"{method} {path}";
                if (!actual.Add(key)) failures.Add($"endpoint.duplicate:{key}");
                var scenario = scenarios.SingleOrDefault(scenario => scenario.Key == key);
                if (scenario is null) { failures.Add($"endpoint.unclassified:{key}"); continue; }
                if (name != scenario.Name) failures.Add($"endpoint.name:{key}");
                if (authorized != scenario.Authorized) failures.Add($"endpoint.auth:{key}");
                if (scenario.Path.Contains("{id}") && !raw.Contains("{id:guid}")) failures.Add($"endpoint.key:{key}");
                var allowed = scenario.Kind switch
                {
                    ResourceKind.Collection => method is "GET" or "POST",
                    ResourceKind.Member => method is "GET" or "PUT",
                    ResourceKind.Configuration => method == "GET" && path == "/api/config",
                    _ => false
                };
                if (!allowed) failures.Add($"endpoint.resource-method:{key}");
                if (document.GetProperty("paths").TryGetProperty(path, out var pathItem) &&
                    pathItem.TryGetProperty(method.ToLowerInvariant(), out var operation))
                    Metadata(endpoint, operation, key, failures);
            }
        }
        foreach (var path in document.GetProperty("paths").EnumerateObject())
            foreach (var operation in path.Value.EnumerateObject())
            {
                if (operation.Name is "parameters" or "summary" or "description" || operation.Name.StartsWith("x-")) continue;
                var key = $"{operation.Name.ToUpperInvariant()} {path.Name}";
                documented.Add(key);
                var scenario = scenarios.SingleOrDefault(scenario => scenario.Key == key);
                if (scenario is null) { failures.Add($"document.unclassified:{key}"); continue; }
                if (operation.Value.GetProperty("operationId").GetString() != scenario.Name) failures.Add($"document.name:{key}");
                var secured = operation.Value.TryGetProperty("security", out var security) &&
                    security.GetArrayLength() == 1 && security[0].EnumerateObject().Count() == 1 &&
                    security[0].TryGetProperty("Bearer", out var scopes) && scopes.GetArrayLength() == 0;
                if (secured != scenario.Authorized) failures.Add($"document.auth:{key}");
                if (operation.Name == "get" && operation.Value.TryGetProperty("requestBody", out _)) failures.Add($"document.get-body:{key}");
            }
        foreach (var key in actual.Except(documented)) failures.Add($"document.missing:{key}");
        foreach (var key in documented.Except(actual)) failures.Add($"document.orphan:{key}");
        foreach (var scenario in scenarios)
            if (!actual.Contains(scenario.Key)) failures.Add($"scenario.orphan:{scenario.Key}");
        return failures;
    }

    private static void Metadata(RouteEndpoint endpoint, JsonElement operation, string key, List<string> failures)
    {
        var declared = endpoint.Metadata.GetOrderedMetadata<IProducesResponseTypeMetadata>()
            .GroupBy(metadata => metadata.StatusCode).ToDictionary(group => group.Key.ToString(), group => group.Last());
        var responses = operation.GetProperty("responses");
        if (!declared.Keys.ToHashSet().SetEquals(responses.EnumerateObject().Select(response => response.Name)))
            failures.Add($"metadata.statuses:{key}");
        foreach (var (status, metadata) in declared)
        {
            if (!responses.TryGetProperty(status, out var response) || !response.TryGetProperty("content", out var content))
            {
                failures.Add($"metadata.response:{key}:{status}");
                continue;
            }
            if (!metadata.ContentTypes.ToHashSet().SetEquals(content.EnumerateObject().Select(media => media.Name)))
                failures.Add($"metadata.media:{key}:{status}");
            foreach (var media in content.EnumerateObject())
                if (metadata.Type is { } type && type != typeof(void) &&
                    (!media.Value.TryGetProperty("schema", out var schema) || !References(schema, type)))
                    failures.Add($"metadata.schema:{key}:{status}");
        }
        var accepts = endpoint.Metadata.GetMetadata<IAcceptsMetadata>();
        var hasBody = operation.TryGetProperty("requestBody", out var requestBody);
        if ((accepts?.RequestType is not null) != hasBody) failures.Add($"metadata.request:{key}");
        if (hasBody && accepts?.RequestType is { } requestType)
        {
            var content = requestBody.GetProperty("content");
            if (!accepts.ContentTypes.ToHashSet().SetEquals(content.EnumerateObject().Select(media => media.Name)))
                failures.Add($"metadata.request-media:{key}");
            foreach (var media in content.EnumerateObject())
                if (!References(media.Value.GetProperty("schema"), requestType)) failures.Add($"metadata.request-schema:{key}");
        }
    }

    private static bool References(JsonElement schema, Type type)
    {
        if (type.IsArray)
        {
            if (!schema.TryGetProperty("items", out var items)) return false;
            return References(items, type.GetElementType()!);
        }
        return schema.TryGetProperty("$ref", out var reference) && reference.GetString() == $"#/components/schemas/{type.Name}";
    }

    private static bool Operational(RouteEndpoint endpoint)
    {
        var path = endpoint.RoutePattern.RawText;
        var name = endpoint.Metadata.GetMetadata<IEndpointNameMetadata>()?.EndpointName;
        var methods = endpoint.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods;
        if (endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>().Count != 0) return false;
        var excluded = endpoint.Metadata.GetMetadata<IExcludeFromDescriptionMetadata>()?.ExcludeFromDescription == true;
        if (endpoint.Order == 0 && excluded && methods is null &&
            ((path == "/health/live" && name == "health-live") || (path == "/health/ready" && name == "health-ready"))) return true;
        if (endpoint.Order == 0 && excluded && name == "worker-retirement" && path == "/sw.js" &&
            methods?.SequenceEqual(["GET"]) == true) return true;
        if (endpoint.Order == 0 && excluded && name == "openapi-document" && path == "/openapi/{documentName}.json" &&
            methods?.SequenceEqual(["GET"]) == true) return true;
        return endpoint.Order == int.MaxValue && name == "application-shell" && path == "{*path:nonfile}" &&
            methods?.Order().SequenceEqual(["GET", "HEAD"]) == true;
    }

    internal static async Task<ApiObservation> Read(HttpResponseMessage response, string path, string method)
    {
        var body = await response.Content.ReadAsStringAsync();
        using var document = JsonDocument.Parse(body);
        return new(path, method.ToLowerInvariant(), (int)response.StatusCode, response.Content.Headers.ContentType?.MediaType ?? "",
            response.Headers.Concat(response.Content.Headers).ToDictionary(header => header.Key.ToLowerInvariant(), header => string.Join(", ", header.Value)),
            document.RootElement.Clone());
    }

    internal static List<string> Response(ApiObservation observed, int expectedStatus, string? location = null)
    {
        var failures = new List<string>();
        if (observed.Status != expectedStatus) failures.Add("response.status");
        if (observed.MediaType != (expectedStatus >= 400 ? "application/problem+json" : "application/json")) failures.Add("response.media");
        if (!observed.Headers.TryGetValue("cache-control", out var cache) ||
            !cache.Split(',').Select(value => value.Trim()).ToHashSet().IsSupersetOf(["private", "no-store"])) failures.Add("response.cache");
        if (expectedStatus == 201 && (!observed.Headers.TryGetValue("location", out var actual) || actual != location)) failures.Add("response.location");
        if (expectedStatus >= 400 && (!observed.Body.TryGetProperty("status", out var status) || status.GetInt32() != expectedStatus)) failures.Add("response.problem-status");
        if (expectedStatus == 401 && observed.Headers.GetValueOrDefault("www-authenticate") != "Bearer") failures.Add("response.challenge");
        return failures;
    }

    internal static void Unchanged(string before, string after) => Assert.That(after, Is.EqualTo(before), "get.persisted-state");
}
