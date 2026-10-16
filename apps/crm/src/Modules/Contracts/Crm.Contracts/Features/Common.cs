using Crm.SharedKernel.Results;

namespace Crm.Contracts.Features;

public sealed record Versioned<T>(T Value, string Etag);

public sealed record RefDto(Guid Id, string Name);

internal static class OsloClock
{
    private static readonly TimeZoneInfo Oslo = TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo");

    public static DateOnly Today(this TimeProvider time) => DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(time.GetUtcNow(), Oslo).DateTime);
}

internal static class CommonErrors
{
    public static Error InvalidETag => Error.PreconditionFailed("INVALID_ETAG", "The If-Match header is not a valid ETag.");

    public static Error OrganizationNotFound(Guid id) => Error.Validation("CON_UNKNOWN_ORGANIZATION", $"Organization {id} does not exist.");
}
