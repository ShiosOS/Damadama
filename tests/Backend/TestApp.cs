using System.Security.Claims;
using System.Security.Cryptography;
using Damadama.Habits;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace Damadama.Tests;

public sealed class TestApp(string connectionString) : WebApplicationFactory<Program>
{
    public const string Issuer = "https://clerk-test.invalid";
    public const string Origin = "http://127.0.0.1:5174";
    private readonly RSA rsa = RSA.Create(2048);
    public static readonly DateTimeOffset CreationInstant = DateTimeOffset.Parse("2026-01-05T00:30:00Z");

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "Damadama.slnx"))) root = root.Parent;
        builder.UseContentRoot(Path.Combine((root ?? throw new InvalidOperationException("Run tests inside the repository.")).FullName, "server"));
        builder.UseEnvironment("Testing");
        builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:habits"] = connectionString,
            ["Clerk:Issuer"] = Issuer,
            ["Clerk:PublishableKey"] = "pk_test_fixture",
            ["Clerk:AuthorizedParties:0"] = Origin
        }));
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<TimeProvider>();
            services.AddSingleton<TimeProvider>(new FixedTime());
            services.PostConfigure<JwtBearerOptions>(JwtBearerDefaults.AuthenticationScheme, options =>
            {
                options.Authority = null;
                options.MetadataAddress = "";
                options.ConfigurationManager = new Microsoft.IdentityModel.Protocols.StaticConfigurationManager<Microsoft.IdentityModel.Protocols.OpenIdConnect.OpenIdConnectConfiguration>(
                    new() { Issuer = Issuer });
                options.TokenValidationParameters.IssuerSigningKey = new RsaSecurityKey(rsa);
            });
        });
    }

    public string Token(string? subject = "owner", string issuer = Issuer, string origin = Origin,
        bool expired = false, bool future = false, bool pending = false)
    {
        var claims = new List<Claim> { new("azp", origin), new("sts", pending ? "pending" : "active") };
        if (subject is not null) claims.Add(new Claim("sub", subject));
        return new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = issuer,
            Subject = new ClaimsIdentity(claims),
            NotBefore = DateTime.UtcNow.AddMinutes(expired ? -10 : future ? 5 : -1),
            Expires = DateTime.UtcNow.AddMinutes(expired ? -5 : 30),
            SigningCredentials = new SigningCredentials(new RsaSecurityKey(rsa), SecurityAlgorithms.RsaSha256)
        });
    }

    public HttpClient SignedIn(string subject = "owner")
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", Token(subject));
        return client;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing) rsa.Dispose();
    }

    private sealed class FixedTime : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => CreationInstant;
    }
}
