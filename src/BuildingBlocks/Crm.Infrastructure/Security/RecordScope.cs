using Crm.SharedKernel.Application;
using Microsoft.Extensions.Options;

namespace Crm.Infrastructure.Security;

public sealed class RecordScopeOptions
{
    public const string SectionName = "Authorization";

    /// <summary>
    /// Restricted unless an environment explicitly opens it (runbook 11): the written policy is SEC-AZ-03, and the business
    /// confirmation of the matrix is EXT-01 (ADR-018).
    /// </summary>
    public RecordScopeMode RecordScope { get; set; } = RecordScopeMode.Restricted;
}

/// <summary>
/// The caller's record scope (DEV-09): background work holds every permission, so it sees everything; a signed-in user
/// sees everything of a kind only through the "every record" permission their roles give (Permissions.cs).
/// </summary>
internal sealed class RecordScope(ICurrentUser user, IOptions<RecordScopeOptions> options) : IRecordScope
{
    public RecordScopeMode Mode => options.Value.RecordScope;

    public Guid? LimitedTo(string everyRecordPermission) =>
        Mode == RecordScopeMode.Open || user.HasPermission(everyRecordPermission) ? null : user.UserId ?? Guid.Empty;
}
