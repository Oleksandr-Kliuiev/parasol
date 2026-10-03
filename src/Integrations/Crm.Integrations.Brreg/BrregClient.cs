using System.Net;
using System.Net.Http.Json;
using Crm.Customers.Contracts;

namespace Crm.Integrations.Brreg;

public sealed record RegistryAddress(string? Street, string? PostalCode, string? City, string? CountryCode);

/// <summary>Registry data mapped to CRM vocabulary; used to prefill the organization form.</summary>
public sealed record RegistryOrganization(
    string OrgNumber,
    string Name,
    string? LegalForm,
    string? LegalFormDescription,
    string? NaceCode,
    string? NaceDescription,
    string? Website,
    string? Email,
    string? Phone,
    RegistryAddress? BusinessAddress,
    RegistryAddress? PostalAddress,
    BrregStatus Status);

public sealed record RegistryLookup(BrregStatus Status, RegistryOrganization? Organization);

public interface IBrregClient
{
    Task<RegistryLookup> GetAsync(string orgNumber, CancellationToken cancellationToken);

    Task<IReadOnlyList<RegistryOrganization>> SearchAsync(string name, int size, CancellationToken cancellationToken);
}

internal sealed class BrregClient(HttpClient http) : IBrregClient
{
    public async Task<RegistryLookup> GetAsync(string orgNumber, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync($"enheter/{Uri.EscapeDataString(orgNumber)}", cancellationToken);
        switch (response.StatusCode)
        {
            case HttpStatusCode.NotFound:
                return new RegistryLookup(BrregStatus.NotFound, null);
            case HttpStatusCode.Gone:
                // Deleted entities are served as 410 Gone with a reduced payload.
                return new RegistryLookup(BrregStatus.Deleted, null);
        }

        response.EnsureSuccessStatusCode();
        var enhet = await response.Content.ReadFromJsonAsync<BrregEnhet>(cancellationToken)
                    ?? throw new InvalidOperationException("Empty response from Enhetsregisteret.");
        var organization = Map(enhet);
        return new RegistryLookup(organization.Status, organization);
    }

    public async Task<IReadOnlyList<RegistryOrganization>> SearchAsync(string name, int size, CancellationToken cancellationToken)
    {
        var url = $"enheter?navn={Uri.EscapeDataString(name)}&size={Math.Clamp(size, 1, 50)}";
        var response = await http.GetFromJsonAsync<BrregSearchResponse>(url, cancellationToken);
        return response?.Embedded?.Enheter?.Select(Map).ToList() ?? [];
    }

    internal static RegistryOrganization Map(BrregEnhet e) => new(
        e.Organisasjonsnummer,
        e.Navn,
        e.Organisasjonsform?.Kode,
        e.Organisasjonsform?.Beskrivelse,
        e.Naeringskode1?.Kode,
        e.Naeringskode1?.Beskrivelse,
        NormalizeWebsite(e.Hjemmeside),
        e.Epostadresse,
        e.Telefon,
        Map(e.Forretningsadresse),
        Map(e.Postadresse),
        StatusOf(e));

    internal static BrregStatus StatusOf(BrregEnhet e) =>
        e.Slettedato is not null ? BrregStatus.Deleted
        : e.Konkurs ? BrregStatus.Bankrupt
        : e.UnderAvvikling || e.UnderTvangsavvikling ? BrregStatus.UnderDissolution
        : BrregStatus.Active;

    private static RegistryAddress? Map(BrregAdresse? a) => a is null
        ? null
        : new RegistryAddress(
            a.Adresse is { Count: > 0 } lines ? string.Join(", ", lines.Where(l => !string.IsNullOrWhiteSpace(l))) : null,
            a.Postnummer,
            a.Poststed,
            a.Landkode);

    private static string? NormalizeWebsite(string? website) =>
        string.IsNullOrWhiteSpace(website) ? null
        : website.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? website
        : "https://" + website;
}
