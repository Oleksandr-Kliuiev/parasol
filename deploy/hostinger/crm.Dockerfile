FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS ui
WORKDIR /src/web
COPY apps/crm/web/package*.json ./
RUN npm ci
COPY apps/crm/web/ ./
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:10.0.402-noble@sha256:0d99ebf1ccad15037b5c98c9fe8979d6b8dbac23812feae2277a0b277b5c5ffa AS build
WORKDIR /src
COPY apps/crm/ ./
RUN dotnet publish src/Hosts/Crm.Web/Crm.Web.csproj -c Release -o /out/web \
    && dotnet publish src/Hosts/Crm.Worker/Crm.Worker.csproj -c Release -o /out/worker
COPY --from=ui /src/src/Hosts/Crm.Web/wwwroot/ /out/web/wwwroot/

FROM mcr.microsoft.com/dotnet/aspnet:10.0.10-noble@sha256:f1126d438ccc359f51cc6d4701a8deae513856cf10f5fe645d29ea6403dcac6b AS web
WORKDIR /app
COPY --from=build /out/web/ ./
USER 1654:1654
EXPOSE 8080
ENTRYPOINT ["dotnet", "Crm.Web.dll"]

FROM mcr.microsoft.com/dotnet/aspnet:10.0.10-noble@sha256:f1126d438ccc359f51cc6d4701a8deae513856cf10f5fe645d29ea6403dcac6b AS worker
WORKDIR /app
COPY --from=build /out/worker/ ./
USER 1654:1654
EXPOSE 8080
ENTRYPOINT ["dotnet", "Crm.Worker.dll"]
