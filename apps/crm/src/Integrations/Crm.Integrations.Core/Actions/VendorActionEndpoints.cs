using System.Text.Json;
using Crm.Authorization;
using Crm.Infrastructure.Http;
using FluentValidation;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
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

internal sealed class VendorActionLookupRequestValidator : AbstractValidator<VendorActionLookupRequest>
{
    public VendorActionLookupRequestValidator()
    {
        RuleFor(x => x.System).NotEmpty().MaximumLength(64);
        RuleFor(x => x.TargetType).NotEmpty().MaximumLength(64);
        RuleFor(x => x.TargetIds).NotNull()
            .Must(ids => ids is { Count: > 0 and <= VendorActionReader.LookupLimit })
            .WithMessage($"Ask for the actions of 1 to {VendorActionReader.LookupLimit} targets.");
        RuleForEach(x => x.TargetIds).NotEmpty().MaximumLength(128);
    }
}

internal sealed class VendorActionBatchPreviewRequestValidator : AbstractValidator<VendorActionBatchPreviewRequest>
{
    public VendorActionBatchPreviewRequestValidator()
    {
        RuleFor(x => x.System).NotEmpty().MaximumLength(64);
        RuleFor(x => x.Kind).NotEmpty().MaximumLength(64);
        RuleFor(x => x.TargetType).NotEmpty().MaximumLength(64);
        VendorActionEndpoints.TargetRules(RuleFor(x => x.TargetIds));
        RuleForEach(x => x.TargetIds).NotEmpty().MaximumLength(128);
        RuleFor(x => x.Parameters).Must(VendorActionEndpoints.IsParameterObject).WithMessage("Parameters must be a JSON object of at most 16 KB.");
    }
}

internal sealed class VendorActionBatchCommandValidator : AbstractValidator<VendorActionBatchCommand>
{
    public VendorActionBatchCommandValidator()
    {
        RuleFor(x => x.PreviewToken).NotEmpty().MaximumLength(4096);
        RuleFor(x => x.System).NotEmpty().MaximumLength(64);
        RuleFor(x => x.Kind).NotEmpty().MaximumLength(64);
        RuleFor(x => x.TargetType).NotEmpty().MaximumLength(64);
        VendorActionEndpoints.TargetRules(RuleFor(x => x.TargetIds));
        RuleForEach(x => x.TargetIds).NotEmpty().MaximumLength(128);
        RuleFor(x => x.Parameters).Must(VendorActionEndpoints.IsParameterObject).WithMessage("Parameters must be a JSON object of at most 16 KB.");
        RuleFor(x => x.BatchKey).NotEmpty();
        RuleFor(x => x.Reason).MaximumLength(VendorActionRules.ReasonMaxLength);
    }
}

/// <summary>
/// <c>/api/v1/actions</c> (M39.1): preview, command (a destructive action through its own endpoint, which demands a fresh sign-in),
/// the log and the facts beside a list's rows, cancel during the hold and settle an uncertain outcome. Each endpoint lets in the holders of any kind's permission; the
/// service then checks the permission of the kind asked for.
/// </summary>
public static class VendorActionEndpoints
{
    /// <summary>
    /// The permissions of the registered kinds (Atera ticket actions, own time; M43: creating a customer at a vendor, which links it);
    /// a test keeps the list complete.
    /// </summary>
    public static readonly string[] RequestPermissions = [Permissions.ServiceWrite, Permissions.TimeOwn, Permissions.IntegrationsManage];

    public static readonly string[] ReadPermissions = [Permissions.ServiceRead, Permissions.TimeOwn, Permissions.IntegrationsManage];

    public const int MaxParameterBytes = 16 * 1024;

    /// <summary>A batch names at most 500 targets of up to 128 characters (M45).</summary>
    public const long MaxBatchBytes = 128 * 1024;

    internal static bool IsParameterObject(JsonElement parameters) =>
        parameters.ValueKind == JsonValueKind.Object && parameters.GetRawText().Length <= MaxParameterBytes;

    internal static void TargetRules<T>(IRuleBuilderInitial<T, IReadOnlyList<string>?> targets) =>
        targets.NotNull()
            .Must(ids => ids is { Count: > 0 and <= VendorActionBatches.MaxTargets })
            .WithMessage($"Ask for 1 to {VendorActionBatches.MaxTargets} targets.");

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

        // What the caller may ask for now (M39.3), so a form offers a vendor action only where a preview would let it through.
        group.MapGet("/kinds", (string? system, VendorActionService actions, HttpContext http) =>
            {
                NoStore(http);
                return Results.Ok(actions.Available(system));
            })
            .RequirePermission(ReadPermissions);

        group.MapGet(string.Empty, async (
                string? system, string? targetType, string? targetId, Guid? organizationId, string? state, string? cursor, int? limit,
                VendorActionReader reader, HttpContext http, CancellationToken ct) =>
            {
                NoStore(http);
                return (await reader.ListAsync(system, targetType, targetId, organizationId, state, cursor, limit, ct)).ToHttpResult(Results.Ok);
            })
            .RequirePermission(ReadPermissions);

        // The facts a list shows beside its rows (M39): one read per page of targets, never one per row. A read, so it works in maintenance.
        group.MapPost("/lookup", async (VendorActionLookupRequest body, VendorActionReader reader, HttpContext http, CancellationToken ct) =>
            {
                NoStore(http);
                return Results.Ok(await reader.LookupAsync(body, ct));
            })
            .Validate<VendorActionLookupRequest>()
            .RequirePermission(ReadPermissions)
            .WithMetadata(new RequestSizeLimitAttribute(16 * 1024))
            .AllowedInMaintenance();

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

        // M45: one preview and one confirmation for many targets of one kind, one action each; destructive kinds never come in a batch.
        group.MapPost("/batch/preview", async (VendorActionBatchPreviewRequest body, VendorActionBatchService batches, IDataProtectionProvider protection,
                HttpContext http, CancellationToken ct) =>
            {
                NoStore(http);
                return (await batches.PreviewAsync(body, protection, ct)).ToHttpResult(Results.Ok);
            })
            .Validate<VendorActionBatchPreviewRequest>()
            .WithMetadata(new RequestSizeLimitAttribute(MaxBatchBytes))
            .RequirePermission(RequestPermissions);

        group.MapPost("/batch", async (VendorActionBatchCommand body, VendorActionBatchService batches, IDataProtectionProvider protection, HttpContext http,
                CancellationToken ct) =>
            {
                NoStore(http);
                return (await batches.RequestAsync(body, protection, ct)).ToHttpResult(saved => saved.Repeated ? Results.Ok(saved) : Results.Accepted(
                    saved.BatchId is { } id ? $"/api/v1/actions/batches/{id}" : null, saved));
            })
            .Validate<VendorActionBatchCommand>()
            .WithMetadata(new RequestSizeLimitAttribute(MaxBatchBytes))
            .RequirePermission(RequestPermissions);

        // M45: a batch as it stands, followed by the dialog that asked for it; with items=true every action of it.
        group.MapGet("/batches/{id:guid}", async (Guid id, bool? items, VendorActionBatchService batches, HttpContext http, CancellationToken ct) =>
            {
                NoStore(http);
                return (await batches.ReadAsync(id, items == true, ct)).ToHttpResult(Results.Ok);
            })
            .RequirePermission(ReadPermissions);

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
