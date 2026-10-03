using System.Text.Json.Serialization;

namespace Crm.Integrations.Brreg;

// Enhetsregisteret API payloads (https://data.brreg.no/enhetsregisteret/api/dokumentasjon). Only fields the CRM uses.

internal sealed record BrregEnhet(
    [property: JsonPropertyName("organisasjonsnummer")] string Organisasjonsnummer,
    [property: JsonPropertyName("navn")] string Navn,
    [property: JsonPropertyName("organisasjonsform")] BrregKode? Organisasjonsform,
    [property: JsonPropertyName("naeringskode1")] BrregKode? Naeringskode1,
    [property: JsonPropertyName("forretningsadresse")] BrregAdresse? Forretningsadresse,
    [property: JsonPropertyName("postadresse")] BrregAdresse? Postadresse,
    [property: JsonPropertyName("hjemmeside")] string? Hjemmeside,
    [property: JsonPropertyName("epostadresse")] string? Epostadresse,
    [property: JsonPropertyName("telefon")] string? Telefon,
    [property: JsonPropertyName("konkurs")] bool Konkurs,
    [property: JsonPropertyName("underAvvikling")] bool UnderAvvikling,
    [property: JsonPropertyName("underTvangsavviklingEllerTvangsopplosning")] bool UnderTvangsavvikling,
    [property: JsonPropertyName("slettedato")] string? Slettedato);

internal sealed record BrregKode(
    [property: JsonPropertyName("kode")] string Kode,
    [property: JsonPropertyName("beskrivelse")] string? Beskrivelse);

internal sealed record BrregAdresse(
    [property: JsonPropertyName("adresse")] IReadOnlyList<string>? Adresse,
    [property: JsonPropertyName("postnummer")] string? Postnummer,
    [property: JsonPropertyName("poststed")] string? Poststed,
    [property: JsonPropertyName("landkode")] string? Landkode);

internal sealed record BrregSearchResponse(
    [property: JsonPropertyName("_embedded")] BrregEmbedded? Embedded);

internal sealed record BrregEmbedded(
    [property: JsonPropertyName("enheter")] IReadOnlyList<BrregEnhet>? Enheter);
