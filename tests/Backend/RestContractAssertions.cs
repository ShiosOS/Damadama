using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using NUnit.Framework;

namespace Damadama.Protocol;

internal sealed record RestObservation(int Status, string? MediaType, string CacheControl, string[] Vary,
    string? Location, string[] Allow, JsonElement Body, string Content);

internal static class RestContractAssertions
{
    internal const string Siren = "application/vnd.siren+json";

    internal static async Task<RestObservation> Read(HttpResponseMessage response)
    {
        var content = await response.Content.ReadAsStringAsync();
        JsonElement body = default;
        try
        {
            if (content.Length > 0)
            {
                using var document = JsonDocument.Parse(content);
                body = document.RootElement.Clone();
            }
        }
        catch (JsonException) { }
        var allow = response.Content.Headers.Allow.Concat(
            response.Headers.TryGetValues("Allow", out var values) ? values.SelectMany(value => value.Split(',')) : [])
            .Select(value => value.Trim()).Distinct(StringComparer.Ordinal).Order().ToArray();
        return new((int)response.StatusCode, response.Content.Headers.ContentType?.MediaType,
            response.Headers.CacheControl?.ToString() ?? "", response.Headers.Vary.ToArray(),
            response.Headers.Location?.ToString(), allow, body, content);
    }

    internal static List<string> Resource(RestObservation response, int status, string? self = null,
        bool created = false, string? expectedClass = null)
    {
        var failures = CachePolicy(response);
        if (response.Status != status) failures.Add("status.resource");
        if (response.MediaType != Siren) failures.Add("media.resource");
        Entity(response.Body, failures, expectedClass);
        if (self is not null && Link(response.Body, "self") != self) failures.Add("link.canonical");
        if (created && (string.IsNullOrEmpty(response.Location) || response.Location != Link(response.Body, "self")))
            failures.Add("location.created");
        return failures;
    }

    internal static List<string> Problem(RestObservation response, int status)
    {
        var failures = CachePolicy(response);
        if (response.Status != status) failures.Add("status.problem");
        if (response.MediaType != "application/problem+json") failures.Add("media.problem");
        if (response.Body.ValueKind != JsonValueKind.Object)
        {
            failures.Add("body.problem");
            return failures;
        }
        if (!response.Body.TryGetProperty("status", out var value) || value.ValueKind != JsonValueKind.Number ||
            !value.TryGetInt32(out var actual) || actual != status)
            failures.Add("body.problem-status");
        foreach (var name in new[] { "type", "title", "traceId" })
            if (!response.Body.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.String ||
                string.IsNullOrWhiteSpace(property.GetString())) failures.Add($"body.problem-{name}");
        return failures;
    }

    internal static List<string> Conflict(RestObservation response)
    {
        var failures = Problem(response, 409);
        if (response.Body.ValueKind != JsonValueKind.Object || !response.Body.TryGetProperty("current", out var current))
            failures.Add("body.conflict-current");
        else Entity(current, failures, "entry");
        return failures;
    }

    internal static List<string> MethodNotAllowed(RestObservation response, params string[] methods)
    {
        var failures = Problem(response, 405);
        if (!response.Allow.Order().SequenceEqual(methods.Order())) failures.Add("allow.methods");
        return failures;
    }

    internal static List<string> Inventory(IEnumerable<Endpoint> endpoints, IReadOnlySet<string> scenarios)
    {
        var failures = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var endpoint in endpoints.OfType<RouteEndpoint>())
        {
            var path = endpoint.RoutePattern.RawText ?? "<missing route pattern>";
            var name = endpoint.Metadata.GetMetadata<IEndpointNameMetadata>()?.EndpointName;
            var category = endpoint.Metadata.GetMetadata<Damadama.ApiContractMetadata>()?.Category;
            var methods = endpoint.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods;
            var authorized = endpoint.Metadata.GetOrderedMetadata<IAuthorizeData>().Count > 0;
            if (category == "control-plane" && !authorized && methods is null &&
                ((name == "health-live" && path == "/health/live") || (name == "health-ready" && path == "/health/ready"))) continue;
            if (category == "control-plane" && name == "worker-retirement" && path == "/sw.js" &&
                !authorized && methods is not null && methods.SequenceEqual(new[] { "GET" })) continue;
            if (name == "application-shell" && category is null && !authorized && path == "{*path:nonfile}" &&
                endpoint.Order == int.MaxValue && methods is not null && methods.Order().SequenceEqual(new[] { "GET", "HEAD" })) continue;
            if (name is null || !scenarios.Contains(name)) failures.Add($"endpoint.uncovered:{path}");
            if (name is not null && !seen.Add(name)) failures.Add($"endpoint.duplicate:{name}");
            if (category is not
                ("resource" or "bootstrap" or "profile" or "options" or "fallback"))
                failures.Add($"endpoint.category:{path}");
        }
        foreach (var scenario in scenarios.Except(seen)) failures.Add($"scenario.orphan:{scenario}");
        return failures;
    }

    internal static string? Link(JsonElement entity, string relation)
    {
        if (entity.ValueKind != JsonValueKind.Object || !entity.TryGetProperty("links", out var links) ||
            links.ValueKind != JsonValueKind.Array) return null;
        foreach (var link in links.EnumerateArray())
        {
            if (link.ValueKind != JsonValueKind.Object || !link.TryGetProperty("rel", out var relations) ||
                relations.ValueKind != JsonValueKind.Array || !relations.EnumerateArray().Any(value =>
                    value.ValueKind == JsonValueKind.String && value.GetString() == relation)) continue;
            if (link.TryGetProperty("href", out var href) && href.ValueKind == JsonValueKind.String) return href.GetString();
        }
        return null;
    }

    internal static List<string> CachePolicy(RestObservation response)
    {
        var failures = new List<string>();
        var policy = response.CacheControl.Split(',').Select(value => value.Trim()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (!policy.Contains("private") || !policy.Contains("no-store")) failures.Add("cache.private-no-store");
        if (!response.Vary.Contains("Accept", StringComparer.OrdinalIgnoreCase)) failures.Add("vary.accept");
        return failures;
    }

    private static void Entity(JsonElement entity, List<string> failures, string? expectedClass = null)
    {
        if (entity.ValueKind != JsonValueKind.Object)
        {
            failures.Add("body.entity");
            return;
        }
        if (!entity.TryGetProperty("class", out var classes) || classes.ValueKind != JsonValueKind.Array ||
            classes.GetArrayLength() == 0 || classes.EnumerateArray().Any(value => value.ValueKind != JsonValueKind.String))
            failures.Add("body.class");
        var kinds = classes.ValueKind == JsonValueKind.Array
            ? classes.EnumerateArray().Where(value => value.ValueKind == JsonValueKind.String).Select(value => value.GetString()).ToArray()
            : [];
        if (expectedClass is not null && !kinds.Contains(expectedClass)) failures.Add($"class.expected:{expectedClass}");
        Properties(entity, expectedClass, failures);
        foreach (var relation in new[] { "self", "profile" })
            if (string.IsNullOrWhiteSpace(Link(entity, relation))) failures.Add($"link.{relation}");
        if (!entity.TryGetProperty("actions", out var actions) || actions.ValueKind != JsonValueKind.Array)
            failures.Add("body.actions");
        else
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var action in actions.EnumerateArray())
            {
                if (action.ValueKind != JsonValueKind.Object || !action.TryGetProperty("name", out var name) ||
                    name.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(name.GetString()) || !names.Add(name.GetString()!))
                {
                    failures.Add("action.name");
                    continue;
                }
                if (!action.TryGetProperty("method", out var method) || method.ValueKind != JsonValueKind.String ||
                    method.GetString() is not ("GET" or "POST" or "PUT" or "DELETE" or "PATCH")) failures.Add("action.method");
                if (!action.TryGetProperty("href", out var href) || href.ValueKind != JsonValueKind.String ||
                    string.IsNullOrWhiteSpace(href.GetString())) failures.Add("action.href");
                if (!action.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String ||
                    type.GetString() is not ("application/json" or "application/x-www-form-urlencoded")) failures.Add("action.encoding");
                if (!action.TryGetProperty("fields", out var fields) || fields.ValueKind != JsonValueKind.Array ||
                    fields.GetArrayLength() == 0) failures.Add("action.fields");
                else
                {
                    var fieldNames = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var field in fields.EnumerateArray())
                        if (field.ValueKind != JsonValueKind.Object || !field.TryGetProperty("name", out var fieldName) ||
                            fieldName.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(fieldName.GetString()) ||
                            !fieldNames.Add(fieldName.GetString()!)) failures.Add("action.field-name");
                }
            }
            var kind = expectedClass ?? kinds.FirstOrDefault();
            var required = kind == "application" ? new[] { "create-habit", "scheduled-habits", "entries-by-date" }
                : kind == "entry" ? ["replace-entry"] : kind == "habits" ? ["create-habit"] : [];
            foreach (var name in required)
                if (!names.Contains(name)) failures.Add($"action.required:{name}");
        }
        if (entity.TryGetProperty("entities", out var entities) && entities.ValueKind == JsonValueKind.Array)
            foreach (var item in entities.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object)
                {
                    failures.Add("body.entity");
                    continue;
                }
                if (!item.TryGetProperty("rel", out var relations) || relations.ValueKind != JsonValueKind.Array ||
                    !relations.EnumerateArray().Any(value => value.ValueKind == JsonValueKind.String && value.GetString() == "item"))
                    failures.Add("entity.item-relation");
                var itemClass = expectedClass switch
                {
                    "habits" or "scheduled-habits" => "habit",
                    "entries" => "entry",
                    _ => null
                };
                Entity(item, failures, itemClass);
            }
    }

    private static void Properties(JsonElement entity, string? expectedClass, List<string> failures)
    {
        if (!entity.TryGetProperty("properties", out var properties) || properties.ValueKind != JsonValueKind.Object)
        {
            failures.Add("body.properties");
            return;
        }
        var stringFields = expectedClass switch
        {
            "habit" => new[] { "id", "name", "good", "better", "best", "createdAt" },
            "entry" => ["habitId", "habitName", "calendarDate", "result", "editedAt", "good", "better", "best"],
            "profile" => ["title"],
            _ => []
        };
        foreach (var field in stringFields)
            if (!properties.TryGetProperty(field, out var value) || value.ValueKind != JsonValueKind.String)
                failures.Add($"property.string:{field}");
        if (expectedClass == "application" && (!properties.TryGetProperty("clerkPublishableKey", out var key) ||
            key.ValueKind is not (JsonValueKind.String or JsonValueKind.Null))) failures.Add("property.clerkPublishableKey");
        if (expectedClass == "habit" && (!properties.TryGetProperty("schedule", out var schedule) ||
            schedule.ValueKind != JsonValueKind.Object)) failures.Add("property.schedule");
    }
}

[TestFixture]
public class RestContractGuardTests
{
    private static RestObservation Created() => new(201, RestContractAssertions.Siren, "private, no-store", ["Accept"],
        "/entries/one", [], JsonSerializer.SerializeToElement(new
        {
            @class = new[] { "entry" },
            properties = new { habitId = "one", habitName = "Walking", calendarDate = "2026-01-04", result = "Good", editedAt = "2026-01-05T00:00:00Z", good = "5 minutes", better = "15 minutes", best = "30 minutes" },
            links = new[] { new { rel = new[] { "self" }, href = "/entries/one" }, new { rel = new[] { "profile" }, href = "/profile" } },
            actions = new[] { new { name = "replace-entry", method = "PUT", href = "/entries/one", type = "application/json", fields = new[] { new { name = "result", type = "text" } } } },
            entities = Array.Empty<object>()
        }), "");

    [Test]
    public void Creation_checks_reject_the_specific_protocol_regressions_they_claim_to_detect()
    {
        var valid = Created();
        Assert.That(RestContractAssertions.Resource(valid, 201, created: true), Is.Empty);
        Assert.That(RestContractAssertions.Resource(valid with { Status = 200 }, 201, created: true), Does.Contain("status.resource"));
        Assert.That(RestContractAssertions.Resource(valid with { Location = null }, 201, created: true), Does.Contain("location.created"));
        Assert.That(RestContractAssertions.Resource(valid with { CacheControl = "public" }, 201), Does.Contain("cache.private-no-store"));
        Assert.That(RestContractAssertions.Resource(valid with { Vary = [] }, 201), Does.Contain("vary.accept"));
        Assert.That(RestContractAssertions.Resource(valid with { MediaType = "application/json" }, 201), Does.Contain("media.resource"));
        var missingLinks = JsonSerializer.SerializeToElement(new { @class = new[] { "entry" }, actions = Array.Empty<object>() });
        Assert.That(RestContractAssertions.Resource(valid with { Body = missingLinks }, 201), Does.Contain("link.self"));
        Assert.That(RestContractAssertions.Resource(valid with { Body = JsonSerializer.SerializeToElement(new { }) }, 201), Does.Contain("body.actions"));
        var withoutEditor = JsonSerializer.SerializeToElement(new
        {
            @class = new[] { "entry" },
            links = valid.Body.GetProperty("links"),
            actions = Array.Empty<object>()
        });
        Assert.That(RestContractAssertions.Resource(valid with { Body = withoutEditor }, 201), Does.Contain("action.required:replace-entry"));
        Assert.That(RestContractAssertions.Resource(valid, 201, expectedClass: "habit"), Does.Contain("class.expected:habit"));
        Assert.That(RestContractAssertions.Resource(valid, 201, expectedClass: "application"), Does.Contain("property.clerkPublishableKey"));
    }

    [Test]
    public void Conflict_and_method_checks_do_not_accept_success_or_missing_required_metadata()
    {
        var problem = Created() with
        {
            Status = 409,
            MediaType = "application/problem+json",
            Body = JsonSerializer.SerializeToElement(new { type = "about:blank", title = "Superseded", status = 409, traceId = "test", current = Created().Body })
        };
        Assert.That(RestContractAssertions.Conflict(problem), Is.Empty);
        Assert.That(RestContractAssertions.Conflict(problem with { Status = 200 }), Does.Contain("status.problem"));
        var method = problem with
        {
            Status = 405,
            Allow = ["GET", "HEAD", "OPTIONS"],
            Body = JsonSerializer.SerializeToElement(new { type = "about:blank", title = "Method not allowed", status = 405, traceId = "test" })
        };
        Assert.That(RestContractAssertions.MethodNotAllowed(method, "GET", "HEAD", "OPTIONS"), Is.Empty);
        Assert.That(RestContractAssertions.MethodNotAllowed(method with { Allow = [] }, "GET", "HEAD", "OPTIONS"), Does.Contain("allow.methods"));
    }

    [Test]
    public void An_unclassified_runtime_endpoint_cannot_escape_contract_coverage()
    {
        var endpoint = new RouteEndpointBuilder(_ => Task.CompletedTask, RoutePatternFactory.Parse("/api/unclassified"), 0).Build();
        Assert.That(RestContractAssertions.Inventory([endpoint], new HashSet<string>()),
            Is.EquivalentTo(new[] { "endpoint.uncovered:/api/unclassified", "endpoint.category:/api/unclassified" }));
        var outsideApi = new RouteEndpointBuilder(_ => Task.CompletedTask, RoutePatternFactory.Parse("/unexpected-command"), 0).Build();
        Assert.That(RestContractAssertions.Inventory([outsideApi], new HashSet<string>()),
            Does.Contain("endpoint.uncovered:/unexpected-command"));
        var imitationFallback = new RouteEndpointBuilder(_ => Task.CompletedTask, RoutePatternFactory.Parse("{*path:nonfile}"), int.MaxValue);
        imitationFallback.Metadata.Add(new HttpMethodMetadata(["GET", "HEAD"]));
        Assert.That(RestContractAssertions.Inventory([imitationFallback.Build()], new HashSet<string>()),
            Does.Contain("endpoint.uncovered:{*path:nonfile}"));
        var retirement = new RouteEndpointBuilder(_ => Task.CompletedTask, RoutePatternFactory.Parse("/sw.js"), 0);
        retirement.Metadata.Add(new EndpointNameMetadata("worker-retirement"));
        retirement.Metadata.Add(new Damadama.ApiContractMetadata("control-plane"));
        retirement.Metadata.Add(new HttpMethodMetadata(["GET"]));
        Assert.That(RestContractAssertions.Inventory([retirement.Build()], new HashSet<string>()), Is.Empty);
        retirement.Metadata.Add(new HttpMethodMetadata(["GET", "POST"]));
        Assert.That(RestContractAssertions.Inventory([retirement.Build()], new HashSet<string>()),
            Does.Contain("endpoint.uncovered:/sw.js"));
        retirement.Metadata.Add(new HttpMethodMetadata(["GET"]));
        retirement.RoutePattern = RoutePatternFactory.Parse("/unexpected-worker.js");
        Assert.That(RestContractAssertions.Inventory([retirement.Build()], new HashSet<string>()),
            Does.Contain("endpoint.uncovered:/unexpected-worker.js"));
        retirement.RoutePattern = RoutePatternFactory.Parse("/sw.js");
        retirement.Metadata.Add(new AuthorizeAttribute());
        Assert.That(RestContractAssertions.Inventory([retirement.Build()], new HashSet<string>()),
            Does.Contain("endpoint.uncovered:/sw.js"));
    }
}
