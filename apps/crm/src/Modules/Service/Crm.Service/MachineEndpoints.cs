using Crm.Authorization;
using Crm.Infrastructure.Http;
using Crm.Service.Contracts;
using Crm.Service.Features;
using Crm.SharedKernel.Results;
using FluentValidation;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace Crm.Service;

/// <summary>Two machines of one customer a person compares (M40).</summary>
public sealed record MachinePairRequest(Guid OtherMachineId);

/// <summary>A device of a machine a person takes off it (M40).</summary>
public sealed record MachineDeviceRequest(Guid DeviceId);

internal sealed class MachinePairRequestValidator : AbstractValidator<MachinePairRequest>
{
    public MachinePairRequestValidator() => RuleFor(x => x.OtherMachineId).NotEmpty();
}

internal sealed class MachineDeviceRequestValidator : AbstractValidator<MachineDeviceRequest>
{
    public MachineDeviceRequestValidator() => RuleFor(x => x.DeviceId).NotEmpty();
}

/// <summary>
/// A customer's machines (M40): one row per computer, its card, and a person's decisions about which devices are one computer. A
/// decision sends the ETag of the machine card it was made on and answers with the card of the machine the devices now make.
/// </summary>
internal static class MachineEndpoints
{
    public static RouteGroupBuilder MapMachineEndpoints(this RouteGroupBuilder group)
    {
        group.MapGet("/machines", async (
                Guid organizationId, DeviceType? type, bool? includeRemoved, string? q, string? cursor, int? limit, MachineQueries machines,
                CancellationToken ct) =>
                (await machines.ListAsync(organizationId, type, includeRemoved == true, q, cursor, limit, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.ServiceRead);

        group.MapGet("/machines/{id:guid}", async (Guid id, MachineQueries machines, CancellationToken ct) =>
                (await machines.GetAsync(id, ct)).ToHttpResult(Results.Ok))
            .RequirePermission(Permissions.ServiceRead);

        group.MapPost("/machines/{id:guid}/join", (Guid id, MachinePairRequest request, HttpRequest http, MachineDecisions decisions,
                    MachineQueries machines, CancellationToken ct) =>
                Decide(http, machines, ifMatch => decisions.JoinAsync(id, request.OtherMachineId, ifMatch, ct), ct))
            .Validate<MachinePairRequest>()
            .RequirePermission(Permissions.ServiceWrite);

        group.MapPost("/machines/{id:guid}/keep-apart", (Guid id, MachinePairRequest request, HttpRequest http, MachineDecisions decisions,
                    MachineQueries machines, CancellationToken ct) =>
                Decide(http, machines, ifMatch => decisions.KeepApartAsync(id, request.OtherMachineId, ifMatch, ct), ct))
            .Validate<MachinePairRequest>()
            .RequirePermission(Permissions.ServiceWrite);

        group.MapPost("/machines/{id:guid}/detach", (Guid id, MachineDeviceRequest request, HttpRequest http, MachineDecisions decisions,
                    MachineQueries machines, CancellationToken ct) =>
                Decide(http, machines, ifMatch => decisions.DetachAsync(id, request.DeviceId, ifMatch, ct), ct))
            .Validate<MachineDeviceRequest>()
            .RequirePermission(Permissions.ServiceWrite);

        return group;
    }

    private static async Task<IResult> Decide(
        HttpRequest http, MachineQueries machines, Func<string, Task<Result<Guid>>> decide, CancellationToken ct)
    {
        if (http.GetIfMatch() is not { } ifMatch)
        {
            return HeaderExtensions.PreconditionRequired();
        }

        var decided = await decide(ifMatch);
        return decided.IsSuccess
            ? (await machines.GetAsync(decided.Value, ct)).ToHttpResult(Results.Ok)
            : decided.Error!.ToProblem();
    }
}
