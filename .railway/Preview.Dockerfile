FROM node:24-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd AS node
FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS web
COPY --from=node /usr/local/bin/node /usr/local/bin/node
ENV PATH=/usr/local/bin:/usr/bin:/bin
WORKDIR /src
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY web/package.json web/package.json
RUN bun install --frozen-lockfile --ignore-scripts
COPY web web
RUN bun run --cwd web build

FROM mcr.microsoft.com/dotnet/aspnet:10.0.13@sha256:d5633778c754e89a386882eddf8dbee6942447a8a4b8267c19cf1e1158d0b0ac AS publish
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.113/dotnet-sdk-10.0.113-linux-x64.tar.gz -o /tmp/sdk.tar.gz \
    && echo "1f2746d3684ef782c4308e056e709e9361802e082e401aff3760868125009a8aee2803ff3eeb87587dc60c766e5dc4f9bfd6051c660a85602cc892c31f72256d  /tmp/sdk.tar.gz" | sha512sum -c - \
    && tar -xzf /tmp/sdk.tar.gz -C /usr/share/dotnet && rm /tmp/sdk.tar.gz
WORKDIR /src
COPY global.json Directory.Build.props dotnet-tools.json ./
COPY server server
COPY --from=web /src/server/wwwroot server/wwwroot
RUN dotnet restore server/Damadama.csproj --locked-mode \
    && dotnet publish server/Damadama.csproj --no-restore -c Release -o /out \
    && dotnet tool restore \
    && dotnet ef migrations script --idempotent --project server --output /out/migrations.sql

FROM mcr.microsoft.com/dotnet/aspnet:10.0.13@sha256:d5633778c754e89a386882eddf8dbee6942447a8a4b8267c19cf1e1158d0b0ac
WORKDIR /app
COPY --from=publish /out .
ENV ASPNETCORE_HTTP_PORTS=8080 ASPNETCORE_ENVIRONMENT=Production
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "Damadama.dll"]
