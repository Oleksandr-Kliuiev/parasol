using System.Net.Http.Json;
using System.Text.Json.Serialization;
using Crm.Sales.Contracts;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.MicrosoftGraph;

/// <summary>
/// Sends a quote from the salesperson's own mailbox (FR-SAL-04): <c>POST /users/{sender}/sendMail</c> with the PDF
/// attached and <c>saveToSentItems</c> on, so the message is in their Outlook Sent folder and the customer's reply comes
/// back to them, not to a shared inbox (docs/05-integrations.md §1.3a).
/// </summary>
internal sealed class GraphQuoteMailSender(HttpClient http, IOptions<SalesMailOptions> options) : IQuoteMailSender
{
    public bool IsConfigured => options.Value.EmailEnabled;

    public async Task SendAsync(QuoteMail mail, CancellationToken cancellationToken)
    {
        var message = new GraphMessage(
            mail.Subject,
            new GraphBody("HTML", mail.HtmlBody),
            [new GraphRecipient(new GraphAddress(mail.ToAddress, mail.ToName))])
        {
            CcRecipients = mail.Cc.Count == 0 ? null : [.. mail.Cc.Select(address => new GraphRecipient(new GraphAddress(address, null)))],
            Attachments = [new GraphFileAttachment(mail.FileName, "application/pdf", Convert.ToBase64String(mail.Pdf.Span))],
        };

        using var response = await http.PostAsJsonAsync(
            $"users/{Uri.EscapeDataString(mail.SenderAddress)}/sendMail",
            new GraphSendMail(message, SaveToSentItems: true),
            cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new HttpRequestException($"Graph sendMail returned {(int)response.StatusCode}: {(body.Length > 300 ? body[..300] : body)}");
        }
    }
}

/// <summary>The flag that lets quotes leave the building; it lives with the other sales settings.</summary>
public sealed class SalesMailOptions
{
    public const string SectionName = "Sales";

    /// <summary>Same flag as <c>Sales:EmailEnabled</c>: without it the PDF is downloaded and sent by hand.</summary>
    public bool EmailEnabled { get; set; }
}

internal sealed record GraphFileAttachment(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("contentType")] string ContentType,
    [property: JsonPropertyName("contentBytes")] string ContentBytes)
{
    [JsonPropertyName("@odata.type")]
    public string ODataType { get; } = "#microsoft.graph.fileAttachment";
}
