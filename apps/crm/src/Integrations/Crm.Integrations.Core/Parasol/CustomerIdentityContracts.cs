using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Crm.SharedKernel.Results;
using FluentValidation;

namespace Crm.Integrations.Core.Parasol;

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record AtlasIdentityClient(string ClientId, string Name);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record AtlasIdentitySnapshot(int SchemaVersion, string Source, string WorkspaceId, IReadOnlyList<AtlasIdentityClient> Clients);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record CustomerIdentityMapping(string AtlasClientId, Guid CustomerId);

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record CustomerIdentityImport(AtlasIdentitySnapshot Snapshot, IReadOnlyList<CustomerIdentityMapping> Mappings);

public sealed record CustomerIdentityPlanRow(string AtlasClientId, Guid CustomerId, string Outcome);
public sealed record CustomerIdentityPlan(string Sha256, bool DryRun, bool CanApply, int UnmappedClients, IReadOnlyList<CustomerIdentityPlanRow> Rows);
public sealed record AtlasCustomerReference(string WorkspaceId, string ClientId);
public sealed record CustomerIdentityView(Guid CustomerId, AtlasCustomerReference? Atlas);

internal sealed class CustomerIdentityImportValidator : AbstractValidator<CustomerIdentityImport>
{
    public CustomerIdentityImportValidator() => RuleFor(x => x).Custom((input, context) =>
    {
        if (CustomerIdentityContract.Validate(input) is { } error) context.AddFailure("body", error.Message);
    });
}

/// <summary>The CRM Organization.Id is the Parasol CustomerId. Names are review context, never matching keys.</summary>
public static class CustomerIdentityContract
{
    public const string System = "Atlas";
    public const string ExternalType = "Client";
    public static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static Error? Validate(CustomerIdentityImport input)
    {
        static bool Id(string? value) => value is { Length: > 0 and <= 128 } && value.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_' or '.' or ':');
        var s = input.Snapshot;
        if (s is null || s.SchemaVersion != 1 || s.Source != "atlas" || !Id(s.WorkspaceId)
            || s.Clients is null || s.Clients.Count is > 1000
            || s.Clients.Any(c => c is null || !Id(c.ClientId) || string.IsNullOrWhiteSpace(c.Name) || c.Name.Length > 256)
            || s.Clients.Select(c => c.ClientId).Distinct(StringComparer.Ordinal).Count() != s.Clients.Count
            || input.Mappings is null || input.Mappings.Count is 0 or > 1000
            || input.Mappings.Any(m => m is null || !Id(m.AtlasClientId) || m.CustomerId == Guid.Empty)
            || input.Mappings.Select(m => m.AtlasClientId).Distinct(StringComparer.Ordinal).Count() != input.Mappings.Count
            || input.Mappings.Select(m => m.CustomerId).Distinct().Count() != input.Mappings.Count
            || input.Mappings.Any(m => !s.Clients.Any(c => c.ClientId == m.AtlasClientId)))
            return Error.Validation("PARASOL_IDENTITY_INVALID", "Supply a version 1 Atlas export and distinct explicit customer mappings (maximum 1000 rows).");
        return null;
    }

    public static string ExternalId(string workspaceId, string clientId) => Hash(new[] { workspaceId, clientId });

    // Ordering in a file is irrelevant; every name, source ID and chosen CustomerId is part of the approval.
    public static string PlanHash(CustomerIdentityImport input) => Hash(new
    {
        input.Snapshot.SchemaVersion, input.Snapshot.Source, input.Snapshot.WorkspaceId,
        Clients = input.Snapshot.Clients.OrderBy(c => c.ClientId, StringComparer.Ordinal).ToArray(),
        Mappings = input.Mappings.OrderBy(m => m.AtlasClientId, StringComparer.Ordinal).ToArray(),
    });

    private static string Hash(object value) => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value, JsonOptions))).ToLowerInvariant();
}
