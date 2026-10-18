using System.Net.Http.Json;
using System.Text.Json;
using NUnit.Framework;

namespace Damadama.Tests;

internal static class SirenRead
{
    public static async Task<JsonElement> ReadSirenProperties(this HttpContent content, string kind)
    {
        var entity = await Read(content, kind);
        return entity.GetProperty("properties");
    }

    public static async Task<JsonElement> ReadSirenItems(this HttpContent content, string kind, string itemKind)
    {
        var collection = await Read(content, kind);
        var entities = collection.GetProperty("entities").EnumerateArray().ToArray();
        foreach (var entity in entities) AssertClass(entity, itemKind);
        return JsonSerializer.SerializeToElement(entities.Select(entity => entity.GetProperty("properties")));
    }

    private static async Task<JsonElement> Read(HttpContent content, string kind)
    {
        Assert.That(content.Headers.ContentType?.MediaType, Is.EqualTo("application/vnd.siren+json"));
        var entity = await content.ReadFromJsonAsync<JsonElement>();
        AssertClass(entity, kind);
        return entity;
    }

    private static void AssertClass(JsonElement entity, string kind) =>
        Assert.That(entity.GetProperty("class").EnumerateArray().Select(value => value.GetString()), Does.Contain(kind));
}
