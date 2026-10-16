// Local orchestration: SQL Server in a container, crm-web (migrates the database) and crm-worker.
// The SPA dev server is started separately: `cd web && npm run dev`.
var builder = DistributedApplication.CreateBuilder(args);

var sql = builder.AddSqlServer("sql")
    .WithDataVolume("vardahei-crm-aspire-sql")
    .WithLifetime(ContainerLifetime.Persistent);
var database = sql.AddDatabase("crm");

var web = builder.AddProject<Projects.Crm_Web>("crm-web")
    .WithReference(database)
    .WaitFor(database)
    .WithHttpHealthCheck("/health/ready", endpointName: "http")
    .WithExternalHttpEndpoints();

builder.AddProject<Projects.Crm_Worker>("crm-worker")
    .WithReference(database)
    .WaitFor(web);

builder.Build().Run();
