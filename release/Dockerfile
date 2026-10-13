FROM node:24-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd AS node
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS web
COPY --from=node /usr/local/bin/node /usr/local/bin/node
ENV PATH=/usr/local/bin:/usr/bin:/bin
WORKDIR /src
COPY package.json bun.lock bunfig.toml ./
COPY web/package.json web/package.json
RUN bun install --frozen-lockfile --ignore-scripts
COPY web web
RUN bun run --cwd web build

FROM mcr.microsoft.com/dotnet/aspnet:10.0.12@sha256:222759b391a1aaf241166672c8f99b2d4ada452e7b5319f3c6e8f265a37b5ad4 AS publish
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.112/dotnet-sdk-10.0.112-linux-x64.tar.gz -o /tmp/sdk.tar.gz \
    && echo "1ac949dfd3929855e3a102a5b12f843967a784ad2d911dfcfff6abdf81a2e78bccf25ddc055547de02b36133bf792aaf97fcba8db8aa6b52ac2e018b86935d05  /tmp/sdk.tar.gz" | sha512sum -c - \
    && tar -xzf /tmp/sdk.tar.gz -C /usr/share/dotnet && rm /tmp/sdk.tar.gz
WORKDIR /src
COPY global.json Directory.Build.props dotnet-tools.json ./
COPY server server
COPY --from=web /src/server/wwwroot server/wwwroot
RUN dotnet restore server/Damadama.csproj --locked-mode \
    && dotnet publish server/Damadama.csproj --no-restore -c Release -o /out \
    && dotnet tool restore \
    && dotnet ef migrations script --idempotent --project server --output /out/migrations.sql

FROM mcr.microsoft.com/dotnet/aspnet:10.0.12@sha256:222759b391a1aaf241166672c8f99b2d4ada452e7b5319f3c6e8f265a37b5ad4
WORKDIR /app
COPY --from=publish /out .
COPY .damadama-release.json wwwroot/release.json
ENV ASPNETCORE_HTTP_PORTS=8080 ASPNETCORE_ENVIRONMENT=Production
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "Damadama.dll"]
