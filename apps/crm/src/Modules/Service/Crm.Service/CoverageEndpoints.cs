using Crm.Authorization;
using Crm.Infrastructure.Http;
using Crm.Service.Features.Coverage;
using Crm.SharedKernel.Results;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Crm.Service;

/// <summary>
/// The CRM's own coverage rules (M40): their settings, and a person's change to one (switched on or off, its limit). A change
/// sends the ETag of the rule it was made on and answers with the rule as it is now.
/// </summary>
internal static class CoverageEndpoints
{
    public static RouteGroupBuilder MapCoverageEndpoints(this RouteGroupBuilder group)
    {
        group.MapGet("/coverage/rules", async (CoverageSettings settings, CancellationToken ct) => Results.Ok(await settings.ListAsync(ct)))
            .RequirePermission(Permissions.ServiceRead);

        group.MapPut("/coverage/rules/{code}", async (string code, ChangeCoverageRuleRequest request, HttpRequest http, CoverageSettings settings,
                CancellationToken ct) =>
            {
                if (http.GetIfMatch() is not { } ifMatch)
                {
                    return HeaderExtensions.PreconditionRequired();
                }

                var changed = await settings.ChangeAsync(code, request, ifMatch, ct);
                return changed.IsSuccess
                    ? Results.Ok((await settings.ListAsync(ct)).Single(r => r.Code == changed.Value))
                    : changed.Error!.ToProblem();
            })
            .Validate<ChangeCoverageRuleRequest>()
            .RequirePermission(Permissions.ServiceWrite);

        return group;
    }
}
