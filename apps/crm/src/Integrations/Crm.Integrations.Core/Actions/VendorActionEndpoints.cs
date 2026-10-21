using System.Text.Json;
using Crm.Authorization;
using Crm.Infrastructure.Http;
using FluentValidation;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Crm.Integrations.Core.Actions;

internal sealed class VendorActionPreviewRequestValidator : AbstractValidator<VendorActionPreviewRequest>
{
    public VendorActionPreviewRequestValidator()
    {
        RuleFor(x => x.System).NotEmpty().MaximumLength(64);
        RuleFor(x => x.Kind).NotEmpty().MaximumLength(64);
        RuleFor(x => x.TargetType).NotEmpty().MaximumLength(64);
        RuleFor(x => x.TargetId).NotEmpty().MaximumLength(128);
        RuleFor(x => x.Parameters).Must(VendorActionEndpoints.IsParameterObject).WithMessage("Parameters must be a JSON object of at most 16 KB.");
    }
}

internal sealed class VendorActionCommandValidator : AbstractValidator<VendorActionCommand>
{
    public VendorActionCommandValidator()
    {
        RuleFor(x => x.PreviewToken).NotEmpty().MaximumLength(4096);
        RuleFor(x => x.System).NotEmpty().MaximumLength(64);
        RuleFor(x => x.Kind).NotEmpty().MaximumLength(64);
        RuleFor(x => x.TargetType).NotEmpty().MaximumLength(64);
        RuleFor(x => x.TargetId).NotEmpty().MaximumLength(128);
        RuleFor(x => x.Parameters).Must(VendorActionEndpoints.IsParameterObject).WithMessage("Parameters must be a JSON object of at most 16 KB.");
        RuleFor(x => x.CommandKey).NotEmpty();
        RuleFor(x => x.Reason).MaximumLength(VendorActionRules.ReasonMaxLength);
        RuleFor(x => x.TypedName).MaximumLength(256);
    }
}

internal sealed class VendorActionSettlementValidator : AbstractValidator<VendorActionSettlement>
{
    public VendorActionSettlementValidator()
    {
        RuleFor(x => x.Outcome).Must(o => o is nameof(VendorActionStatus.Succeeded) or nameof(VendorActionStatus.Failed))
            .WithMessage("Say Succeeded (it happened) or Failed (it did not).");
        RuleFor(x => x.Reason).NotEmpty().Length(VendorActionRules.ReasonMinLength, VendorActionRules.ReasonMaxLength);
    }
}

/// <summary>
/// <c>/api/v1/actions</c> (M39.1): preview, command (a destructive action through its own endpoint, which demands a fresh sign-in),
/// the log, cancel during the hold and settle an uncertain outcome. Each endpoint lets in the holders of any kind's permission; the
/// service then checks the permission of the kind asked for.
/// </summary>
public static class VendorActionEndpoints
{
    /// <summary>The permissions of the registered kinds (Atera ticket actions, own time); a test keeps the list complete.</summary>
    public static readonly string[] RequestPermissions = [Permissions.ServiceWrite, Permissions.TimeOwn];

    public static readonly string[] ReadPermissions = [Permissions.ServiceRead, Permissions.TimeOwn, Permissions.IntegrationsManage];

    public const int MaxParameterBytes = 16 * 1024;

    internal static bool IsParameterObject(JsonElement parameters) =>
        parameters.ValueKind == JsonValueKind.Object && parameters.GetRawText().Length <= MaxParameterBytes;

    public static IEndpointRouteBuilder MapVendorActionEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/actions").WithTags("Actions");

        group.MapPost("/preview", async (VendorActionPreviewRequest body, VendorActionService actions, IDataProtectionProvider protection, HttpContext http, CancellationToken ct) =>
            {
                NoStore(http);
                return (await actions.PreviewAsync(body, protection, ct)).ToHttpResult(Results.Ok);
            })
            .Validate<VendorActionPreviewRequest>()
            .RequirePermission(RequestPermissions);

        group.MapPost(string.Empty, (VendorActionCommand body, VendorActionService actions, IDataProtectionProvider protection, HttpContext http, CancellationToken ct) =>
                RequestAsync(body, destructive: false, actions, protection, http, ct))
            .Validate<VendorActionCommand>()
            .RequirePermission(RequestPermissions);

        // A destructive action needs the person at the keyboard now (F-G2-08): AUTH_REVERIFY_REQUIRED sends them to sign in again.
        group.MapPost("/destructive", (VendorActionCommand body, VendorActionService actions, IDataProtectionProvider protection, HttpContext http, CancellationToken ct) =>
                RequestAsync(body, destructive: true, actions, protection, http, ct))
            .Validate<VendorActionCommand>()
            .RequirePermission(RequestPermissions)
            .RequiresFreshRoles();

        group.MapGet(string.Empty, async (
                string? system, string? targetType, string? targetId, Guid? organizationId, string? state, string? cursor, int? limit,
                VendorActionReader reader, HttpContext http, CancellationToken ct) =>
            {
                NoStore(http);
                return (await reader.ListAsync(system, targetType, targetId, organizationId, state, cursor, limit, ct)).ToHttpResult(Results.Ok);
            })
            .RequirePermission(ReadPermissions);

        group.MapGet("/{id:guid}", async (Guid id, VendorActionReader reader, HttpContext http, CancellationToken ct) =>
            {
                NoStore(http);
                return (await reader.GetAsync(id, ct)).ToHttpResult(item => WithEtag(http, item, Results.Ok(item)));
            })
            .RequirePermission(ReadPermissions);

        group.MapPost("/{id:guid}/cancel", async (Guid id, VendorActionService actions, HttpContext http, CancellationToken ct) =>
            {
                if (http.Request.GetIfMatch() is not { } etag)
                {
                    return HeaderExtensions.PreconditionRequired();
                }

                return (await actions.CancelAsync(id, etag, ct)).ToHttpResult(item => WithEtag(http, item, Results.Ok(item)));
            })
            .RequirePermission(RequestPermissions);

        group.MapPost("/{id:guid}/settle", async (Guid id, VendorActionSettlement body, VendorActionService actions, HttpContext http, CancellationToken ct) =>
            {
                if (http.Request.GetIfMatch() is not { } etag)
                {
                    return HeaderExtensions.PreconditionRequired();
                }

                return (await actions.SettleAsync(id, etag, body, ct)).ToHttpResult(item => WithEtag(http, item, Results.Ok(item)));
            })
            .Validate<VendorActionSettlement>()
            .RequirePermission(RequestPermissions);

        return app;
    }

    private static async Task<IResult> RequestAsync(
        VendorActionCommand body, bool destructive, VendorActionService actions, IDataProtectionProvider protection, HttpContext http, CancellationToken ct)
    {
        NoStore(http);
        var result = await actions.RequestAsync(body, destructive, protection, ct);
        return result.ToHttpResult(saved => WithEtag(http, saved.Action,
            saved.Created ? Results.Accepted($"/api/v1/actions/{saved.Action.Id}", saved.Action) : Results.Ok(saved.Action)));
    }

    private static IResult WithEtag(HttpContext http, VendorActionItem item, IResult result)
    {
        http.Response.Headers.ETag = item.Etag;
        return result;
    }

    /// <summary>A preview, a command answer and the log are personal to the moment: never cached.</summary>
    private static void NoStore(HttpContext http) => http.Response.Headers.CacheControl = "no-store";
}
