using Crm.Customers.Contracts;
using Crm.Customers.Domain;
using FluentValidation;

namespace Crm.Customers.Features.Organizations;

public sealed record AddressDto(string? Street, string? PostalCode, string? City, string? CountryCode)
{
    internal Address ToDomain() => new(Street, PostalCode, City, CountryCode);

    internal static AddressDto From(Address address) => new(address.Street, address.PostalCode, address.City, address.CountryCode);
}

public sealed record OrganizationRequest(
    string Name,
    string? OrgNumber,
    string? LegalForm,
    OrganizationStatus Status,
    string? NaceCode,
    string? Website,
    string? Phone,
    string? Email,
    string? InvoiceEmail,
    bool EhfEnabled,
    Guid? AccountManagerId,
    Guid? PrimaryTechnicianId,
    AddressDto? PostalAddress,
    AddressDto? VisitAddress,
    AddressDto? BillingAddress,
    IReadOnlyList<string>? Domains)
{
    internal OrganizationDetails ToDetails() => new(
        Name, OrgNumber, LegalForm, Status, NaceCode, Website, Phone, Email, InvoiceEmail, EhfEnabled,
        AccountManagerId, PrimaryTechnicianId, PostalAddress?.ToDomain(), VisitAddress?.ToDomain(), BillingAddress?.ToDomain(), Domains);
}

internal sealed class OrganizationRequestValidator : AbstractValidator<OrganizationRequest>
{
    public OrganizationRequestValidator()
    {
        RuleFor(x => x.Name).NotEmpty().MaximumLength(256);
        RuleFor(x => x.OrgNumber)
            .Must(v => string.IsNullOrWhiteSpace(v) || OrgNumber.IsValid(v))
            .WithErrorCode("CUS_INVALID_ORGNR")
            .WithMessage("Organization number must be 9 digits with a valid check digit.");
        RuleFor(x => x.Status).IsInEnum();
        RuleFor(x => x.Email).EmailAddress().When(x => !string.IsNullOrWhiteSpace(x.Email));
        RuleFor(x => x.InvoiceEmail).EmailAddress().When(x => !string.IsNullOrWhiteSpace(x.InvoiceEmail));
        RuleFor(x => x.Website).MaximumLength(256);
        RuleFor(x => x.Phone).MaximumLength(32);
        RuleForEach(x => x.Domains).NotEmpty().MaximumLength(253)
            .Matches(@"^@?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$").WithMessage("'{PropertyValue}' is not a valid domain.");
        RuleFor(x => x.Domains).Must(d => d is null || d.Count <= 20).WithMessage("At most 20 domains.");
        RuleFor(x => x.PostalAddress!).SetValidator(new AddressDtoValidator()).When(x => x.PostalAddress is not null);
        RuleFor(x => x.VisitAddress!).SetValidator(new AddressDtoValidator()).When(x => x.VisitAddress is not null);
        RuleFor(x => x.BillingAddress!).SetValidator(new AddressDtoValidator()).When(x => x.BillingAddress is not null);
    }
}

internal sealed class AddressDtoValidator : AbstractValidator<AddressDto>
{
    public AddressDtoValidator()
    {
        RuleFor(x => x.Street).MaximumLength(256);
        RuleFor(x => x.PostalCode).MaximumLength(16);
        RuleFor(x => x.City).MaximumLength(128);
        RuleFor(x => x.CountryCode).Length(2).When(x => !string.IsNullOrWhiteSpace(x.CountryCode));
    }
}

public sealed record UserRefDto(Guid Id, string DisplayName);

/// <summary>An organization seen from another one: the parent above it or a subsidiary below it (FR-CUS-07).</summary>
public sealed record OrganizationGroupMember(Guid Id, string Name, OrganizationStatus Status, bool BilledThroughParent);

public sealed record SetParentRequest(Guid? ParentId, bool BilledThroughParent);

public sealed record OrganizationResponse(
    Guid Id,
    string Name,
    string? OrgNumber,
    string? LegalForm,
    OrganizationStatus Status,
    string? NaceCode,
    string? Website,
    string? Phone,
    string? Email,
    string? InvoiceEmail,
    bool EhfEnabled,
    UserRefDto? AccountManager,
    UserRefDto? PrimaryTechnician,
    AddressDto PostalAddress,
    AddressDto VisitAddress,
    AddressDto BillingAddress,
    IReadOnlyList<string> Domains,
    BrregStatus RegistryStatus,
    DateTimeOffset? RegistryCheckedAt,
    OrganizationGroupMember? Parent,
    bool BilledThroughParent,
    IReadOnlyList<OrganizationGroupMember> Children,
    DateTimeOffset CreatedAt,
    DateTimeOffset? ModifiedAt);

public sealed record OrganizationListItem(
    Guid Id,
    string Name,
    string? OrgNumber,
    OrganizationStatus Status,
    string? City,
    UserRefDto? AccountManager,
    BrregStatus RegistryStatus);
