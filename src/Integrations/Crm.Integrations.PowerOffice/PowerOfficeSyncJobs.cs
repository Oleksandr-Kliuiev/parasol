using System.Globalization;
using Crm.Customers.Contracts;
using Crm.Integrations.Core;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.PowerOffice;

/// <summary>
/// Incremental import of PowerOffice customers (lastChangedDateTimeOffsetGreaterThan). Changed records are stored for mapping;
/// unlinked customers with an unambiguous org number match are linked; billing details flow into the CRM when PowerOffice is
/// the billing master.
/// </summary>
public sealed class PowerOfficeCustomerSyncJob(
    IPowerOfficeClient client,
    ExternalRecordStore records,
    ExternalLinkService links,
    SyncRunner runner,
    ICustomersApi customers,
    IOptions<PowerOfficeOptions> options,
    ILogger<PowerOfficeCustomerSyncJob> logger)
{
    public const string JobId = "poweroffice-customers";
    private const string Stream = "customers";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("PowerOffice customer sync skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(PowerOfficeTypes.System, JobId, async (progress, ct) =>
        {
            var since = PowerOfficeCursor.Parse(await runner.GetCursorAsync(PowerOfficeTypes.System, Stream, ct));
            var newest = since;
            IOrganizationMatcher? matcher = null;
            int autoLinked = 0, billingUpdates = 0;

            await foreach (var customer in client.GetCustomersAsync(PowerOfficeCursor.ReadFrom(since), ct))
            {
                progress.Read++;
                newest = newest is null || customer.LastChangedDateTimeOffset > newest ? customer.LastChangedDateTimeOffset : newest;
                var outcome = await records.UpsertAsync(PowerOfficeMapping.ToRecord(customer), ct);
                if (!outcome.Changed)
                {
                    continue;
                }

                progress.Changed++;
                var id = outcome.Record.ExternalId;
                var link = await links.FindByExternalAsync(PowerOfficeTypes.System, PowerOfficeTypes.Customer, id, ct);
                if (link is null && options.Value.AutoLinkByOrgNumber && customer.IsArchived != true)
                {
                    matcher ??= await customers.CreateMatcherAsync(ct);
                    if (matcher.Match(PowerOfficeMapping.ToOrganizationData(customer)) is [{ IsExact: true } exact])
                    {
                        var linked = await links.LinkAsync(EntityTypes.Organization, exact.OrganizationId, PowerOfficeTypes.System, PowerOfficeTypes.Customer, id, Core.Persistence.LinkMethod.Automatic, null, ct);
                        if (linked.IsSuccess)
                        {
                            link = linked.Value;
                            autoLinked++;
                        }
                    }
                }

                if (link is not null && await customers.ApplyExternalBillingDetailsAsync(link.EntityId, PowerOfficeMapping.ToBilling(customer), ct))
                {
                    billingUpdates++;
                }
            }

            await runner.SetCursorAsync(PowerOfficeTypes.System, Stream, PowerOfficeCursor.Format(newest), ct);
            progress.Message = $"changed {progress.Changed}, auto-linked {autoLinked}, billing updates {billingUpdates}";
        }, cancellationToken);
    }
}

/// <summary>Incremental import of contact persons; unlinked ones are linked to CRM contacts with the same e-mail.</summary>
public sealed class PowerOfficeContactPersonSyncJob(
    IPowerOfficeClient client,
    ExternalRecordStore records,
    ExternalLinkService links,
    SyncRunner runner,
    ICustomersApi customers,
    IOptions<PowerOfficeOptions> options,
    ILogger<PowerOfficeContactPersonSyncJob> logger)
{
    public const string JobId = "poweroffice-contact-persons";
    private const string Stream = "contact-persons";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("PowerOffice contact person sync skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(PowerOfficeTypes.System, JobId, async (progress, ct) =>
        {
            var since = PowerOfficeCursor.Parse(await runner.GetCursorAsync(PowerOfficeTypes.System, Stream, ct));
            var newest = since;
            var changed = new List<(string ExternalId, string? Email)>();
            await foreach (var person in client.GetContactPersonsAsync(PowerOfficeCursor.ReadFrom(since), ct))
            {
                progress.Read++;
                newest = newest is null || person.LastChangedDateTimeOffset > newest ? person.LastChangedDateTimeOffset : newest;
                var outcome = await records.UpsertAsync(PowerOfficeMapping.ToRecord(person), ct);
                if (outcome.Changed)
                {
                    progress.Changed++;
                    changed.Add((outcome.Record.ExternalId, outcome.Record.Email));
                }
            }

            var byEmail = await customers.FindContactsByEmailAsync(changed.Where(c => c.Email != null).Select(c => c.Email!).ToList(), ct);
            int autoLinked = 0;
            foreach (var (externalId, email) in changed)
            {
                if (email is not null && byEmail.TryGetValue(email, out var contactId) &&
                    await links.FindByExternalAsync(PowerOfficeTypes.System, PowerOfficeTypes.ContactPerson, externalId, ct) is null &&
                    (await links.LinkAsync(EntityTypes.Contact, contactId, PowerOfficeTypes.System, PowerOfficeTypes.ContactPerson, externalId, Core.Persistence.LinkMethod.Automatic, null, ct)).IsSuccess)
                {
                    autoLinked++;
                }
            }

            await runner.SetCursorAsync(PowerOfficeTypes.System, Stream, PowerOfficeCursor.Format(newest), ct);
            progress.Message = $"changed {progress.Changed}, auto-linked {autoLinked}";
        }, cancellationToken);
    }
}

/// <summary>Imports the PowerOffice product list, used to map CRM catalog products to invoice lines (docs/02 §4.4, Sprint 4).</summary>
public sealed class PowerOfficeProductSyncJob(
    IPowerOfficeClient client,
    ExternalRecordStore records,
    SyncRunner runner,
    IOptions<PowerOfficeOptions> options,
    ILogger<PowerOfficeProductSyncJob> logger)
{
    public const string JobId = "poweroffice-products";
    private const string Stream = "products";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.IsConfigured)
        {
            logger.LogInformation("PowerOffice product sync skipped: integration not configured.");
            return;
        }

        await runner.RunAsync(PowerOfficeTypes.System, JobId, async (progress, ct) =>
        {
            var since = PowerOfficeCursor.Parse(await runner.GetCursorAsync(PowerOfficeTypes.System, Stream, ct));
            var newest = since;
            await foreach (var product in client.GetProductsAsync(PowerOfficeCursor.ReadFrom(since), ct))
            {
                progress.Read++;
                newest = newest is null || product.LastChangedDateTimeOffset > newest ? product.LastChangedDateTimeOffset : newest;
                if ((await records.UpsertAsync(PowerOfficeMapping.ToRecord(product), ct)).Changed)
                {
                    progress.Changed++;
                }
            }

            await runner.SetCursorAsync(PowerOfficeTypes.System, Stream, PowerOfficeCursor.Format(newest), ct);
            progress.Message = $"changed {progress.Changed}";
        }, cancellationToken);
    }
}

internal static class PowerOfficeCursor
{
    public static DateTimeOffset? Parse(string? value) =>
        DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var parsed) ? parsed : null;

    /// <summary>
    /// A record changed while a page was being read, or stamped by a clock slightly behind, can carry a change time just below
    /// the stored cursor. Reading from a little earlier re-reads those records; upserts are hash-idempotent, so a record seen
    /// twice is stored once and counted as changed only when its content differs.
    /// </summary>
    public static readonly TimeSpan Overlap = TimeSpan.FromMinutes(5);

    /// <summary>Where a read starts for a stored cursor: the cursor minus <see cref="Overlap"/>; everything when there is none.</summary>
    public static DateTimeOffset? ReadFrom(DateTimeOffset? cursor) => cursor?.Subtract(Overlap);

    public static string? Format(DateTimeOffset? value) => value?.ToString("O", CultureInfo.InvariantCulture);
}
