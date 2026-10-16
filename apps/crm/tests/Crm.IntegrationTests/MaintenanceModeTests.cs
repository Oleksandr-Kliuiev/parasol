using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Crm.Authorization;
using Crm.Customers.Contracts;
using Crm.Infrastructure.Http;
using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.SharedKernel.Documents;
using Crm.SharedKernel.Domain;
using Crm.SharedKernel.Operations;
using Hangfire;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using WireMock.RequestBuilders;
using WireMock.ResponseBuilders;

namespace Crm.IntegrationTests;

/// <summary>
/// DEV-13: read-only maintenance. Each test runs hosts of its own whose switch lives in a store of the test's own
/// (<see cref="SplitDocumentStore"/>), so the classes running beside them stay in normal operation; the database and the rest
/// of the document store are the shared ones.
/// </summary>
public partial class MaintenanceModeTests(CrmWebFactory factory)
{
    private const string Operations = "/api/v1/operations";
    private const string Reason = "DEV-13 test: rehearsing a database restore";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [GeneratedRegex(@"\{(?<name>\*{0,2}[^}:?]+)(?<constraint>:[^}?]+)?\??\}")]
    private static partial Regex RouteParameter();

    [Fact]
    public async Task AC01_every_write_path_is_refused_with_the_same_answer_while_reads_go_on()
    {
        var switchStore = new TestDocumentStore();
        try
        {
            await using var host = Host(new SplitDocumentStore(switchStore, factory.Documents), b => b.UseSetting("Hangfire:DashboardEnabled", "true"));
            var admin = QuoteDocumentsTests.Client(host, CrmRoles.Admin, "maint-admin");
            var finance = QuoteDocumentsTests.Client(host, CrmRoles.Finance, "maint-finance");
            var marker = $"M{Guid.NewGuid():N}"[..10];
            // Signed in before the maintenance: a first sign-in provisions the user, which is a write.
            var organizationId = await admin.CreateOrganizationAsync(TestData.Organization($"{marker} Vedlikehold AS"));
            (await finance.GetAsync("/bff/user", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
            var before = await admin.GetFromJsonAsync<JsonElement>($"{Operations}/maintenance", Ct);
            before.GetProperty("mode").GetString().ShouldBe("Normal");

            // Only the operator switches: with the permission, a reason and the CSRF header.
            (await finance.GetAsync($"{Operations}/maintenance", Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
            (await finance.PutAsJsonAsync($"{Operations}/maintenance", Decision("ReadOnly", null), Ct)).StatusCode.ShouldBe(HttpStatusCode.Forbidden);
            (await admin.PutAsJsonAsync($"{Operations}/maintenance", new { mode = "ReadOnly", reason = "short" }, Ct)).StatusCode.ShouldBe(HttpStatusCode.BadRequest);
            var noCsrf = host.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
            noCsrf.DefaultRequestHeaders.Add(TestAuthHandler.RolesHeader, CrmRoles.Admin);
            noCsrf.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, "maint-admin");
            var refusedCsrf = await noCsrf.PutAsJsonAsync($"{Operations}/maintenance", Decision("ReadOnly", null), Ct);
            refusedCsrf.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
            (await refusedCsrf.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("CSRF_HEADER_REQUIRED");

            var readOnly = await SwitchAsync(admin, "ReadOnly", expectedKey: null);
            readOnly.GetProperty("mode").GetString().ShouldBe("ReadOnly");
            var key = readOnly.GetProperty("key").GetString()!;
            key.ShouldStartWith("operations/maintenance/");
            readOnly.GetProperty("setBy").GetString()!.ShouldContain("maint-admin");
            readOnly.GetProperty("inFlight").EnumerateArray().Select(c => c.GetProperty("area").GetString()).ShouldContain("outbox");
            (await switchStore.ReadAsync(key, Ct)).ShouldNotBeNull();

            // Every route that changes data, in every module, answers the same — read from the running application, so a new
            // endpoint is covered without editing this test. Reads answer from the database as usual; exports are refused,
            // because each writes its audit entry.
            var endpoints = host.Services.GetRequiredService<EndpointDataSource>().Endpoints
                .OfType<RouteEndpoint>()
                .Where(e => e.RoutePattern.RawText is { } raw && (raw.StartsWith("/api/", StringComparison.Ordinal) || raw.StartsWith("/bff/", StringComparison.Ordinal)))
                .Select(e => new
                {
                    Pattern = e.RoutePattern.RawText!,
                    Methods = e.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? [],
                    Allowed = e.Metadata.GetMetadata<AllowedInMaintenanceMetadata>() is not null,
                    Exports = e.Metadata.GetMetadata<ExportsDataMetadata>() is not null,
                })
                .ToList();
            var violations = new List<string>();
            int writesRefused = 0, readsAnswered = 0, readsWithData = 0, exportsRefused = 0;
            foreach (var endpoint in endpoints)
            {
                var url = RouteParameter().Replace(endpoint.Pattern, match =>
                    match.Groups["constraint"].Value.Contains("guid", StringComparison.Ordinal) ? Guid.NewGuid().ToString()
                    : match.Groups["constraint"].Value.Contains("int", StringComparison.Ordinal) ? "1"
                    : "x");
                foreach (var method in endpoint.Methods)
                {
                    if (endpoint.Allowed || IsSignIn(endpoint.Pattern))
                    {
                        continue;
                    }

                    using var request = new HttpRequestMessage(new HttpMethod(method), url);
                    if (method is "POST" or "PUT" or "PATCH")
                    {
                        request.Content = new StringContent("{}", Encoding.UTF8, "application/json");
                    }

                    using var response = await admin.SendAsync(request, Ct);
                    var body = await response.Content.ReadAsStringAsync(Ct);
                    var refused = response.StatusCode == HttpStatusCode.ServiceUnavailable && body.Contains($"\"{MaintenanceHttp.ReadOnlyCode}\"", StringComparison.Ordinal);
                    if (method is "GET" or "HEAD" && !endpoint.Exports)
                    {
                        readsAnswered++;
                        readsWithData += response.IsSuccessStatusCode ? 1 : 0;
                        if (refused || response.StatusCode == HttpStatusCode.InternalServerError)
                        {
                            violations.Add($"read {method} {endpoint.Pattern}: {(int)response.StatusCode} {Shorten(body)}");
                        }
                    }
                    else if (!refused || response.Headers.RetryAfter is null)
                    {
                        violations.Add($"write {method} {endpoint.Pattern}: {(int)response.StatusCode} {Shorten(body)}");
                    }
                    else if (endpoint.Exports)
                    {
                        exportsRefused++;
                    }
                    else
                    {
                        writesRefused++;
                    }
                }
            }

            TestContext.Current.TestOutputHelper?.WriteLine(
                $"{writesRefused} writes and {exportsRefused} exports refused, {readsAnswered} reads answered ({readsWithData} with 2xx) on {endpoints.Count} endpoints.");
            violations.ShouldBeEmpty();
            writesRefused.ShouldBeGreaterThan(150);
            exportsRefused.ShouldBeGreaterThan(0);
            readsWithData.ShouldBeGreaterThan(40);

            // The records themselves read as before.
            var found = await admin.GetFromJsonAsync<JsonElement>($"/api/v1/customers/organizations?search={marker}", Ct);
            found.GetProperty("items").EnumerateArray().ShouldHaveSingleItem().GetProperty("id").GetGuid().ShouldBe(organizationId);
            var card = await admin.GetAsync($"/api/v1/customers/organizations/{organizationId}", Ct);
            card.StatusCode.ShouldBe(HttpStatusCode.OK);
            card.Headers.ETag.ShouldNotBeNull();

            // Signing in writes (the user, a session): during maintenance only the operators who run it sign in. Anyone else is
            // refused by provisioning — not half done — and the sign-in paths turn that into the "signing in is paused" page.
            var anonymous = host.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
            var newcomer = QuoteDocumentsTests.Client(host, CrmRoles.Sales, $"maint-new-{Guid.NewGuid():N}");
            var provisioning = await newcomer.GetAsync($"/api/v1/customers/organizations?search={marker}", Ct);
            provisioning.StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);
            (await provisioning.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe(MaintenanceHttp.ReadOnlyCode);
            var newOperator = QuoteDocumentsTests.Client(host, CrmRoles.Admin, $"maint-op-{Guid.NewGuid():N}");
            (await newOperator.GetAsync($"{Operations}/maintenance", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);

            // What everyone may know: the mode and since when; the reason only once signed in.
            var publicStatus = await anonymous.GetFromJsonAsync<JsonElement>("/bff/maintenance", Ct);
            publicStatus.GetProperty("mode").GetString().ShouldBe("ReadOnly");
            publicStatus.GetProperty("since").ValueKind.ShouldBe(JsonValueKind.String);
            publicStatus.GetProperty("reason").ValueKind.ShouldBe(JsonValueKind.Null);
            (await admin.GetFromJsonAsync<JsonElement>("/bff/maintenance", Ct)).GetProperty("reason").GetString().ShouldBe(Reason);

            // Starting a job by hand is a change too: during maintenance only the jobs the worker still runs then (the full audit
            // verification after a restore); the others answer like any change.
            host.Services.GetRequiredService<IRecurringJobManager>().AddOrUpdate<Crm.Audit.Features.AuditIntegrityJob>(
                Crm.Audit.Features.AuditIntegrityJob.FullJobId, job => job.VerifyAllAsync(CancellationToken.None), Cron.Never());
            (await admin.PostAsync($"/api/v1/integrations/jobs/{Crm.Audit.Features.AuditIntegrityJob.FullJobId}/trigger", null, Ct)).StatusCode
                .ShouldBe(HttpStatusCode.Accepted);
            var otherJob = await admin.PostAsync("/api/v1/integrations/jobs/outbound-operations/trigger", null, Ct);
            otherJob.StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);
            (await otherJob.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe(MaintenanceHttp.ReadOnlyCode);

            // The Hangfire dashboard reads, but triggers nothing.
            (await admin.GetAsync("/admin/jobs", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
            var trigger = await admin.PostAsync("/admin/jobs/recurring/trigger", new FormUrlEncodedContent([new("jobs[]", "notification-digest")]), Ct);
            trigger.StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);
            (await trigger.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe(MaintenanceHttp.ReadOnlyCode);

            // Writes that bypass the request barrier — a job, a lease, a bulk change — are refused by the database guard.
            await using (var scope = host.Services.CreateAsyncScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
                db.OutboundOperations.Add(new OutboundOperation
                {
                    Id = SequentialId.New(), System = "dev13-guard", Operation = "none", EntityType = "Probe", EntityId = Guid.NewGuid(),
                    IdempotencyKey = $"dev13-guard:{Guid.NewGuid():N}", CreatedAt = DateTimeOffset.UtcNow, NextAttemptAt = DateTimeOffset.MaxValue,
                });
                await Should.ThrowAsync<MaintenanceReadOnlyException>(() => db.SaveChangesAsync(Ct));
                db.ChangeTracker.Clear();
                var none = db.OutboundOperations.Where(o => o.Id == Guid.Empty);
                await Should.ThrowAsync<MaintenanceReadOnlyException>(() => none.ExecuteUpdateAsync(s => s.SetProperty(o => o.LastError, "dev13"), Ct));
                await Should.ThrowAsync<MaintenanceReadOnlyException>(() => none.ExecuteDeleteAsync(Ct));
                await Should.ThrowAsync<MaintenanceReadOnlyException>(() => db.Database.ExecuteSqlRawAsync("SELECT 1", Ct));
                (await db.OutboundOperations.CountAsync(o => o.System == "dev13-guard", Ct)).ShouldBe(0);
                using (MaintenanceScope.AllowWrites("dev13-test"))
                {
                    // The few writes maintenance allows open a scope for exactly that work.
                    (await none.ExecuteUpdateAsync(s => s.SetProperty(o => o.LastError, "dev13"), Ct)).ShouldBe(0);
                }
            }

            // Signing out ends a session: allowed.
            (await admin.PostAsync("/bff/logout", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);

            // The decision is the stored object; the audit entry beside it names it.
            var audit = await admin.GetFromJsonAsync<JsonElement>("/api/v1/audit?entityType=Maintenance&action=Maintenance&limit=200", Ct);
            audit.GetProperty("items").EnumerateArray().ShouldContain(e => e.GetProperty("changes").ToString().Contains(key, StringComparison.Ordinal));

            // Two operators cannot overwrite each other: a change names the decision it replaces.
            var stale = await admin.PutAsJsonAsync($"{Operations}/maintenance", Decision("Normal", "operations/maintenance/an-older-decision.json"), Ct);
            stale.StatusCode.ShouldBe(HttpStatusCode.Conflict);
            (await stale.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("MAINTENANCE_CHANGED");

            var lifted = await SwitchAsync(admin, "Normal", key);
            lifted.GetProperty("mode").GetString().ShouldBe("Normal");
            (await anonymous.GetFromJsonAsync<JsonElement>("/bff/maintenance", Ct)).GetProperty("mode").GetString().ShouldBe("Normal");
            await admin.CreateOrganizationAsync(TestData.Organization($"{marker} Etterpå AS"));
            (await newcomer.GetAsync($"/api/v1/customers/organizations?search={marker}", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
            (await switchStore.Inner.ListAsync("operations/maintenance/", Ct).CountAsync(Ct)).ShouldBe(2);
        }
        finally
        {
            DeleteStore(switchStore);
        }
    }

    [Fact]
    public async Task AC01_an_operator_signs_in_again_during_maintenance_to_lift_it_while_everyone_else_waits()
    {
        var switchStore = new TestDocumentStore();
        var keyRing = Directory.CreateTempSubdirectory("crm-keys-").FullName;
        try
        {
            var time = ManualTimeProvider.InThePast();
            await using var host = new SessionHost(
                factory, time, keyRing, crmAppId: $"maint-app-{Guid.NewGuid():N}", tenant: Guid.NewGuid().ToString(), logs: null,
                services: services => services.AddSingleton<IDocumentStore>(new SplitDocumentStore(switchStore, factory.Documents)));
            var operatorId = $"maint-op-{Guid.NewGuid():N}";
            var (signedIn, _) = await host.SignInAsync(operatorId, CrmRoles.Admin);
            var readOnly = await SwitchAsync(signedIn, "ReadOnly", expectedKey: null);

            // Five minutes on, the sign-in no longer confirms the roles for a privileged change (ADR-019): the role sync would,
            // and it keeps running during maintenance; without it, the operator signs in again.
            time.Advance(TimeSpan.FromMinutes(6));
            var stale = await signedIn.PutAsJsonAsync($"{Operations}/maintenance", Decision("Normal", readOnly.GetProperty("key").GetString()), Ct);
            stale.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
            (await stale.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("AUTH_REVERIFY_REQUIRED");

            // Everyone else waits for the end of the maintenance: the sign-in leads to the app's "signing in is paused" page.
            using (var request = new HttpRequestMessage(HttpMethod.Post, "/test/sign-in"))
            {
                request.Headers.Add("X-Test-Oid", $"maint-sales-{Guid.NewGuid():N}");
                request.Headers.Add("X-Test-Sign-In-Roles", CrmRoles.Sales);
                var refused = await host.Client().SendAsync(request, Ct);
                refused.StatusCode.ShouldBe(HttpStatusCode.SeeOther);
                refused.Headers.Location!.OriginalString.ShouldBe("/?maintenance=signin");
            }

            // The operator signs in again and lifts it.
            var (again, _) = await host.SignInAsync(operatorId, CrmRoles.Admin);
            (await SwitchAsync(again, "Normal", readOnly.GetProperty("key").GetString())).GetProperty("mode").GetString().ShouldBe("Normal");
        }
        finally
        {
            DeleteStore(switchStore);
            Directory.Delete(keyRing, recursive: true);
        }
    }

    [Fact]
    public async Task AC01_a_deployment_forced_read_only_by_configuration_cannot_be_lifted_by_the_switch()
    {
        var switchStore = new TestDocumentStore();
        try
        {
            await using var host = Host(new SplitDocumentStore(switchStore, factory.Documents), b =>
            {
                b.UseSetting("Maintenance:ForceReadOnly", "true");
                b.UseSetting("Maintenance:ForceReason", "The document store is down (DEV-13 test).");
            });
            // Signed in where the CRM is writable: the forced host would refuse provisioning the user.
            (await factory.ClientAs(CrmRoles.Admin, userKey: "maint-forced").GetAsync("/bff/user", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
            var admin = QuoteDocumentsTests.Client(host, CrmRoles.Admin, "maint-forced");
            var status = await admin.GetFromJsonAsync<JsonElement>($"{Operations}/maintenance", Ct);
            status.GetProperty("mode").GetString().ShouldBe("ReadOnly");
            status.GetProperty("forced").GetBoolean().ShouldBeTrue();

            var write = await admin.PostAsJsonAsync("/api/v1/customers/organizations", TestData.Organization("Tvunget AS"), Ct);
            write.StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);
            (await write.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe(MaintenanceHttp.ReadOnlyCode);
            (await admin.GetAsync("/api/v1/customers/organizations?limit=1", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);

            var lift = await admin.PutAsJsonAsync($"{Operations}/maintenance", Decision("Normal", null), Ct);
            lift.StatusCode.ShouldBe(HttpStatusCode.Conflict);
            (await lift.ReadJsonAsync()).GetProperty("detail").GetString()!.ShouldContain("Maintenance:ForceReadOnly");
            (await switchStore.Inner.ListAsync("operations/maintenance/", Ct).CountAsync(Ct)).ShouldBe(0);
        }
        finally
        {
            DeleteStore(switchStore);
        }
    }

    [Fact]
    public async Task AC02_a_replica_whose_cached_switch_still_says_normal_sends_nothing_and_an_unreadable_switch_sends_nothing()
    {
        var switchStore = new TestDocumentStore();
        try
        {
            // Replica A is where the operator switches. Replica B never refreshes its cached state (the worst case of a cache):
            // requests and database writes there still see "normal"; only the fresh reads before a send see the store.
            var storeB = new SplitDocumentStore(switchStore, factory.Documents);
            var probes = new MaintenanceProbeLog();
            await using var a = Host(new SplitDocumentStore(switchStore, factory.Documents));
            await using var b = Host(storeB, services: services =>
            {
                var real = services.Last(d => d.ServiceType == typeof(IMaintenanceGate)).ImplementationType!;
                services.AddSingleton<IMaintenanceGate>(sp => new FrozenCacheGate((IMaintenanceGate)ActivatorUtilities.CreateInstance(sp, real)));
                services.AddSingleton(probes);
                services.AddScoped<IOutboundHandler, MaintenanceProbeHandler>();
            });
            var operatorA = QuoteDocumentsTests.Client(a, CrmRoles.Admin, "maint-admin");
            var salesB = QuoteDocumentsTests.Client(b, CrmRoles.Sales, "maint-sales");
            var marker = $"M{Guid.NewGuid():N}"[..10];
            factory.Graph.Given(Request.Create().WithPath("/graph/v1.0/users/maint-sales@test.local/sendMail").UsingPost())
                .RespondWith(Response.Create().WithStatusCode(202));
            var (customerId, contactId) = await QuoteDocumentsTests.CustomerAsync(salesB, marker);
            var quoteId = await QuoteDocumentsTests.QuoteAsync(salesB, customerId, contactId, marker, "nb");
            (await salesB.PostAsync($"/api/v1/sales/quotes/{quoteId}/submit", null, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
            var prospectId = await salesB.CreateOrganizationAsync(TestData.Organization($"{marker} Mappe AS"));
            var entityId = Guid.NewGuid();
            var operationId = SequentialId.New();
            await using (var scope = b.Services.CreateAsyncScope())
            {
                // Run explicitly below; due in the far future, so the runs of the classes beside this one leave it alone.
                var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
                db.OutboundOperations.Add(new OutboundOperation
                {
                    Id = operationId, System = MaintenanceProbeHandler.ProbeSystem, Operation = MaintenanceProbeHandler.ProbeOperation,
                    EntityType = MaintenanceProbeHandler.ProbeEntity, EntityId = entityId, IdempotencyKey = $"dev13-probe:{entityId:N}",
                    Status = OutboundStatus.Pending, CreatedAt = DateTimeOffset.UtcNow, NextAttemptAt = new DateTimeOffset(2100, 1, 1, 0, 0, 0, TimeSpan.Zero),
                });
                await db.SaveChangesAsync(Ct);
            }

            var outboundB = b.Services.GetRequiredService<OutboundProcessorJob>();
            var send = new { toAddress = $"kari.{marker}@example.no", subject = $"{marker} Tilbud" };

            // Maintenance begins on A.
            var readOnly = await SwitchAsync(operatorA, "ReadOnly", expectedKey: null);
            (await b.Services.GetRequiredService<IMaintenanceGate>().CurrentAsync(Ct)).IsReadOnly.ShouldBeFalse();
            (await outboundB.ExecuteOneAsync(operationId, Ct)).ShouldBeFalse();
            var mail = await salesB.PostAsJsonAsync($"/api/v1/sales/quotes/{quoteId}/send", send, Ct);
            mail.StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);
            (await mail.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe(MaintenanceHttp.ReadOnlyCode);
            await using (var scope = b.Services.CreateAsyncScope())
            {
                await Should.ThrowAsync<MaintenanceReadOnlyException>(() =>
                    scope.ServiceProvider.GetRequiredService<IDocumentLibrary>().EnsureFolderAsync(prospectId, Ct));
            }

            probes.Sent.ShouldBe(0);
            QuoteDocumentsTests.Attachments(factory, marker).ShouldBeEmpty();
            await AssertWaitingAsync(b, operationId);

            // Maintenance ends, but B cannot read the switch: still nothing leaves (fail closed), while reads go on.
            await SwitchAsync(operatorA, "Normal", readOnly.GetProperty("key").GetString());
            storeB.FailMaintenanceReads = true;
            (await outboundB.ExecuteOneAsync(operationId, Ct)).ShouldBeFalse();
            var unknown = await salesB.PostAsJsonAsync($"/api/v1/sales/quotes/{quoteId}/send", send, Ct);
            unknown.StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);
            (await unknown.ReadJsonAsync()).GetProperty("code").GetString().ShouldBe("MAINTENANCE_STATE_UNAVAILABLE");
            (await salesB.GetAsync($"/api/v1/sales/quotes/{quoteId}", Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
            probes.Sent.ShouldBe(0);
            QuoteDocumentsTests.Attachments(factory, marker).ShouldBeEmpty();
            await AssertWaitingAsync(b, operationId);

            // Readable again: each send goes out once, journaled before and after.
            storeB.FailMaintenanceReads = false;
            (await outboundB.ExecuteOneAsync(operationId, Ct)).ShouldBeTrue();
            probes.Sent.ShouldBe(1);
            (await salesB.PostAsJsonAsync($"/api/v1/sales/quotes/{quoteId}/send", send, Ct)).StatusCode.ShouldBe(HttpStatusCode.OK);
            QuoteDocumentsTests.Attachments(factory, marker).Count.ShouldBe(1);
            await using (var scope = b.Services.CreateAsyncScope())
            {
                var operation = await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().OutboundOperations.AsNoTracking()
                    .SingleAsync(o => o.Id == operationId, Ct);
                operation.Status.ShouldBe(OutboundStatus.Succeeded);
                operation.Attempts.ShouldBe(1);
            }

            var journal = await b.Services.GetRequiredService<IExternalEffectJournal>().ForEntityAsync(MaintenanceProbeHandler.ProbeEntity, entityId, Ct);
            journal.Select(e => e.Phase).ShouldBe([EffectPhase.Sending, EffectPhase.Sent]);
            journal.ShouldAllBe(e => e.OperationId == operationId);
            journal[^1].Reference.ShouldBe($"probe-{entityId:N}");
            var mailJournal = await b.Services.GetRequiredService<IExternalEffectJournal>().ForEntityAsync("Quote", quoteId, Ct);
            mailJournal.Select(e => e.Phase).ShouldBe([EffectPhase.Sending, EffectPhase.Sent]);
        }
        finally
        {
            DeleteStore(switchStore);
        }
    }

    [Fact]
    public async Task AC02_a_send_under_way_when_maintenance_begins_records_its_outcome_and_nothing_new_starts()
    {
        var switchStore = new TestDocumentStore();
        try
        {
            await using var host = Host(new SplitDocumentStore(switchStore, factory.Documents), services: services =>
                services.AddScoped<IOutboundHandler, SwitchingProbeHandler>());
            var (first, firstEntity) = await QueueProbeAsync(host, SwitchingProbeHandler.ProbeOperation);
            var (second, _) = await QueueProbeAsync(host, SwitchingProbeHandler.ProbeOperation);
            var outbound = host.Services.GetRequiredService<OutboundProcessorJob>();

            // The external system has taken the request when maintenance begins (the probe switches it on before it returns):
            // the outcome is recorded all the same, or the restored copy would send it again.
            (await outbound.ExecuteOneAsync(first, Ct)).ShouldBeTrue();
            (await host.Services.GetRequiredService<IMaintenanceGate>().FreshAsync(Ct)).IsReadOnly.ShouldBeTrue();
            await using (var scope = host.Services.CreateAsyncScope())
            {
                var done = await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().OutboundOperations.AsNoTracking()
                    .SingleAsync(o => o.Id == first, Ct);
                done.Status.ShouldBe(OutboundStatus.Succeeded);
                done.Attempts.ShouldBe(1);
                done.LeaseOwner.ShouldBeNull();
            }

            (await host.Services.GetRequiredService<IExternalEffectJournal>().ForEntityAsync(MaintenanceProbeHandler.ProbeEntity, firstEntity, Ct))
                .Select(e => e.Phase).ShouldBe([EffectPhase.Sending, EffectPhase.Sent]);

            // Nothing new starts.
            (await outbound.ExecuteOneAsync(second, Ct)).ShouldBeFalse();
            await AssertWaitingAsync(host, second);
        }
        finally
        {
            DeleteStore(switchStore);
        }
    }

    /// <summary>A probe operation, run explicitly; due in the far future, so the runs of the classes beside this one leave it alone.</summary>
    private static async Task<(Guid Operation, Guid Entity)> QueueProbeAsync(WebApplicationFactory<Program> host, string operation)
    {
        var entityId = Guid.NewGuid();
        var operationId = SequentialId.New();
        await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IntegrationDbContext>();
        db.OutboundOperations.Add(new OutboundOperation
        {
            Id = operationId, System = MaintenanceProbeHandler.ProbeSystem, Operation = operation, EntityType = MaintenanceProbeHandler.ProbeEntity,
            EntityId = entityId, IdempotencyKey = $"dev13-probe:{operation}:{entityId:N}", Status = OutboundStatus.Pending,
            CreatedAt = DateTimeOffset.UtcNow, NextAttemptAt = new DateTimeOffset(2100, 1, 1, 0, 0, 0, TimeSpan.Zero),
        });
        await db.SaveChangesAsync(Ct);
        return (operationId, entityId);
    }

    private WebApplicationFactory<Program> Host(
        IDocumentStore store, Action<IWebHostBuilder>? configure = null, Action<IServiceCollection>? services = null) =>
        factory.WithWebHostBuilder(builder =>
        {
            configure?.Invoke(builder);
            builder.ConfigureTestServices(collection =>
            {
                collection.AddSingleton(store);
                services?.Invoke(collection);
            });
        });

    private static object Decision(string mode, string? expectedKey) => new { mode, reason = Reason, reference = "DEV-13", expectedKey };

    private static async Task<JsonElement> SwitchAsync(HttpClient admin, string mode, string? expectedKey)
    {
        var response = await admin.PutAsJsonAsync($"{Operations}/maintenance", Decision(mode, expectedKey), Ct);
        response.StatusCode.ShouldBe(HttpStatusCode.OK, await response.Content.ReadAsStringAsync(Ct));
        return await response.ReadJsonAsync();
    }

    /// <summary>The operation was neither attempted nor left leased: it waits exactly as it was.</summary>
    private static async Task AssertWaitingAsync(WebApplicationFactory<Program> host, Guid operationId)
    {
        await using var scope = host.Services.CreateAsyncScope();
        var operation = await scope.ServiceProvider.GetRequiredService<IntegrationDbContext>().OutboundOperations.AsNoTracking()
            .SingleAsync(o => o.Id == operationId, Ct);
        operation.Status.ShouldBe(OutboundStatus.Pending);
        operation.Attempts.ShouldBe(0);
        operation.LockedUntil.ShouldBeNull();
        operation.LeaseOwner.ShouldBeNull();
    }

    /// <summary>Sign-in has its own answer (checked above); signing out at Entra leaves the CRM for the identity provider.</summary>
    private static bool IsSignIn(string pattern) => pattern is "/bff/login" or "/bff/dev-login" or "/bff/signout-entra";

    private static string Shorten(string body) => body.Length > 200 ? body[..200] : body;

    private static void DeleteStore(TestDocumentStore store)
    {
        // The test's own switch folder; nothing else is ever stored there.
        if (Directory.Exists(store.Root))
        {
            Directory.Delete(store.Root, recursive: true);
        }
    }
}

/// <summary>A replica whose cached switch never moves on: requests and database writes see what it read first, sends read the store.</summary>
internal sealed class FrozenCacheGate(IMaintenanceGate inner) : IMaintenanceGate
{
    public MaintenanceState Last => MaintenanceState.Normal;

    public ValueTask<MaintenanceState> CurrentAsync(CancellationToken cancellationToken) => ValueTask.FromResult(MaintenanceState.Normal);

    public Task<MaintenanceState> FreshAsync(CancellationToken cancellationToken) => inner.FreshAsync(cancellationToken);

    public Task<MaintenanceState> SetAsync(
        MaintenanceMode mode, string reason, string? reference, string setBy, string? expectedKey, CancellationToken cancellationToken) =>
        inner.SetAsync(mode, reason, reference, setBy, expectedKey, cancellationToken);
}

/// <summary>An external system that takes the request while maintenance begins: the probe switches it on before it returns.</summary>
internal sealed class SwitchingProbeHandler(IMaintenanceGate gate) : IOutboundHandler
{
    public const string ProbeOperation = "send-then-maintenance";

    public string System => MaintenanceProbeHandler.ProbeSystem;

    public string Operation => ProbeOperation;

    public async Task<OutboundResult> ExecuteAsync(OutboundOperation operation, CancellationToken cancellationToken)
    {
        var current = await gate.FreshAsync(cancellationToken);
        await gate.SetAsync(MaintenanceMode.ReadOnly, "DEV-13 test: maintenance begins mid-send", null, "test", current.Key, cancellationToken);
        return new OutboundResult("Probe sent.", $"probe-{operation.EntityId:N}");
    }
}

public sealed class MaintenanceProbeLog
{
    private int _sent;

    public int Sent => Volatile.Read(ref _sent);

    public void Record() => Interlocked.Increment(ref _sent);
}

/// <summary>An outbound handler that only counts what reached it — the external system of the stale-cache test.</summary>
internal sealed class MaintenanceProbeHandler(MaintenanceProbeLog log) : IOutboundHandler
{
    public const string ProbeSystem = "dev13-probe";
    public const string ProbeOperation = "send";
    public const string ProbeEntity = "Probe";

    public string System => ProbeSystem;

    public string Operation => ProbeOperation;

    public Task<OutboundResult> ExecuteAsync(OutboundOperation operation, CancellationToken cancellationToken)
    {
        log.Record();
        return Task.FromResult(new OutboundResult("Probe sent.", $"probe-{operation.EntityId:N}"));
    }
}
