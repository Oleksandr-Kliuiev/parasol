using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Crm.Activities.Contracts;

namespace Crm.Activities.Domain;

/// <summary>Permanent receipt: a removed Task must never free its technical source for accidental recreation.</summary>
public sealed class SourceTaskLink
{
    public required string SourceKey { get; init; }
    public Guid ActivityId { get; init; }
    public required string System { get; init; }
    public required string WorkspaceId { get; init; }
    public required string ClientId { get; init; }
    public required string ObservationId { get; init; }
    public required string TargetKind { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public Guid CreatedBy { get; init; }
    public SourceTaskIdentity Source => new(System, WorkspaceId, ClientId, ObservationId, TargetKind);
}

internal static class SourceTaskIdentityRules
{
    internal const string Subject = "Review technical observation";
    internal static bool IsValid(SourceTaskIdentity? source) => source is not null && source.System == "Atlas" && source.TargetKind == "Task"
        && Id(source.WorkspaceId, 128) && Id(source.ClientId, 128) && Id(source.ObservationId, 256);
    private static bool Id(string? value, int maximum) => value is not null && value.Length <= maximum
        && Regex.IsMatch(value, @"\A[A-Za-z0-9._:-]+\z", RegexOptions.CultureInvariant);
    internal static string Key(SourceTaskIdentity source) => Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(
        new[] { "SourceTaskV1", source.System, source.WorkspaceId, source.ClientId, source.ObservationId, source.TargetKind })));
}
