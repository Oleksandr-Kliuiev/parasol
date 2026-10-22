using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Crm.Integrations.Huntress;

/// <summary>
/// Huntress API v1 client (M41). Paths, fields and paging are those of Huntress's own reference (OpenAPI 2.0 at
/// <c>/v1/swagger_doc.json</c>, read 22.10.2026); a single resource answers as <c>{ "agent": … }</c>, a list as
/// <c>{ "agents": […], "pagination": { "next_page_token" } }</c>. The same class serves the reads and the actions, each with an
/// HTTP client of its own budget.
/// </summary>
internal sealed partial class HuntressClient(HttpClient http, IOptions<HuntressOptions> options) : IHuntressActionClient
{
    public async Task<HuntressAccount> GetAccountAsync(CancellationToken cancellationToken)
    {
        using var document = await GetAsync("account", cancellationToken)
            ?? throw new HuntressApiException(HttpStatusCode.NotFound, "Huntress does not know the account of these credentials.");
        return ReadAccount(Single(document.RootElement, "account"))
               ?? throw new HuntressApiException(HttpStatusCode.OK, "Huntress answered for the account without an id.");
    }

    public IAsyncEnumerable<HuntressOrganization> GetOrganizationsAsync(CancellationToken cancellationToken) =>
        GetPagedAsync("organizations", "organizations", ReadOrganization, null, o => o.Id, cancellationToken);

    public async Task<HuntressUsage?> GetUsageAsync(long organizationId, CancellationToken cancellationToken)
    {
        using var document = await GetAsync($"organizations/{organizationId.ToString(CultureInfo.InvariantCulture)}", cancellationToken);
        return document is null ? null : ReadUsage(Single(document.RootElement, "organization"));
    }

    public IAsyncEnumerable<HuntressAgent> GetAgentsAsync(long? organizationId, CancellationToken cancellationToken) =>
        GetPagedAsync("agents", "agents", ReadAgent,
            organizationId is { } id ? "organization_id=" + id.ToString(CultureInfo.InvariantCulture) : null, a => a.Id, cancellationToken);

    public async Task<HuntressAgent?> GetAgentAsync(long agentId, CancellationToken cancellationToken)
    {
        using var document = await GetAsync($"agents/{agentId.ToString(CultureInfo.InvariantCulture)}", cancellationToken);
        return document is null ? null : ReadAgent(Single(document.RootElement, "agent"))
            ?? throw new HuntressApiException(HttpStatusCode.OK, $"Huntress answered for agent {agentId} without an agent.");
    }

    public IAsyncEnumerable<HuntressIncident> GetIncidentsAsync(string status, CancellationToken cancellationToken) =>
        GetPagedAsync("incident_reports", "incident_reports", ReadIncident, "status=" + Uri.EscapeDataString(status), i => i.Id, cancellationToken);

    public async Task<HuntressIncident?> GetIncidentAsync(long incidentId, CancellationToken cancellationToken)
    {
        using var document = await GetAsync($"incident_reports/{incidentId.ToString(CultureInfo.InvariantCulture)}", cancellationToken);
        return document is null ? null : ReadIncident(Single(document.RootElement, "incident_report"))
            ?? throw new HuntressApiException(HttpStatusCode.OK, $"Huntress answered for incident report {incidentId} without a report.");
    }

    public async Task<IReadOnlyList<HuntressRemediation>> GetRemediationsAsync(long incidentId, CancellationToken cancellationToken)
    {
        var remediations = new List<HuntressRemediation>();
        await foreach (var remediation in GetPagedAsync(
                           $"incident_reports/{incidentId.ToString(CultureInfo.InvariantCulture)}/remediations", "remediations", ReadRemediation, null, r => r.Id, cancellationToken))
        {
            remediations.Add(remediation);
        }

        return remediations.OrderBy(r => r.Id).ToList();
    }

    public async Task<IReadOnlyList<HuntressComment>> GetCommentsAsync(long incidentId, CancellationToken cancellationToken)
    {
        var comments = new List<HuntressComment>();
        await foreach (var comment in GetPagedAsync(
                           $"incident_reports/{incidentId.ToString(CultureInfo.InvariantCulture)}/comments", "comments", ReadComment, null, c => c.Id, cancellationToken))
        {
            comments.Add(comment);
        }

        return comments.OrderBy(c => c.CreatedAt).ThenBy(c => c.Id).ToList();
    }

    public IAsyncEnumerable<HuntressNotice> GetNoticesAsync(HuntressNoticeKind kind, string status, CancellationToken cancellationToken) =>
        GetPagedAsync(NoticePath(kind), NoticePath(kind), e => ReadNotice(kind, e), "status=" + Uri.EscapeDataString(status), n => n.Id, cancellationToken);

    public async Task<HuntressNotice?> GetNoticeAsync(HuntressNoticeKind kind, long id, CancellationToken cancellationToken)
    {
        using var document = await GetAsync($"{NoticePath(kind)}/{id.ToString(CultureInfo.InvariantCulture)}", cancellationToken);
        return document is null ? null : ReadNotice(kind, Single(document.RootElement, kind == HuntressNoticeKind.Escalation ? "escalation" : "platform_action"))
            ?? throw new HuntressApiException(HttpStatusCode.OK, $"Huntress answered for {NoticePath(kind)} {id} without one.");
    }

    public IAsyncEnumerable<HuntressReport> GetReportsAsync(DateOnly periodFrom, CancellationToken cancellationToken) =>
        GetPagedAsync("reports", "reports", ReadReport,
            "type=monthly_summary&period_min=" + periodFrom.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture), r => r.Id, cancellationToken);

    public async Task ApproveRemediationsAsync(long incidentId, CancellationToken cancellationToken)
    {
        // An empty body: Huntress automates what it would automate; the manual steps stay for people to mark.
        using var response = await http.PostAsJsonAsync(
            $"incident_reports/{incidentId.ToString(CultureInfo.InvariantCulture)}/remediations/bulk_approval", new Dictionary<string, object?>(), cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
    }

    public async Task RejectRemediationsAsync(long incidentId, HuntressRejection rejection, CancellationToken cancellationToken)
    {
        using var response = await http.PostAsJsonAsync(
            $"incident_reports/{incidentId.ToString(CultureInfo.InvariantCulture)}/remediations/bulk_rejection",
            new Dictionary<string, object?> { ["comment"] = rejection.Comment, ["useful"] = rejection.Useful, ["reason"] = rejection.Reason },
            cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
    }

    public async Task SetRemediationCompletionAsync(long incidentId, long remediationId, bool completed, CancellationToken cancellationToken)
    {
        using var response = await http.PostAsJsonAsync(
            $"incident_reports/{incidentId.ToString(CultureInfo.InvariantCulture)}/remediations/{remediationId.ToString(CultureInfo.InvariantCulture)}/completion",
            new Dictionary<string, object?> { ["completed"] = completed }, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
    }

    public async Task ResolveIncidentAsync(long incidentId, CancellationToken cancellationToken)
    {
        using var response = await http.PostAsync($"incident_reports/{incidentId.ToString(CultureInfo.InvariantCulture)}/resolution", content: null, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
    }

    public async Task<HuntressComment?> CreateCommentAsync(long incidentId, string body, CancellationToken cancellationToken)
    {
        using var response = await http.PostAsJsonAsync(
            $"incident_reports/{incidentId.ToString(CultureInfo.InvariantCulture)}/comments", new Dictionary<string, object?> { ["body"] = body }, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        using var document = await ParseAsync(response, cancellationToken);
        return document is null ? null : ReadComment(Single(document.RootElement, "comment"));
    }

    public async Task ResolveEscalationAsync(long escalationId, HuntressEscalationAnswer answer, CancellationToken cancellationToken)
    {
        // A determination is given for the identity only and never revokes or disables it: that stays a decision made in Huntress.
        var body = answer.Determination is { } determination
            ? new Dictionary<string, object?> { ["determination"] = determination, ["scope"] = "identity", ["revoke_and_disable_identities"] = false }
            : new Dictionary<string, object?>();
        using var response = await http.PostAsJsonAsync($"escalations/{escalationId.ToString(CultureInfo.InvariantCulture)}/resolution", body, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
    }

    public async Task<HuntressAgent?> IsolateAgentAsync(long agentId, string reason, CancellationToken cancellationToken)
    {
        using var response = await http.PostAsJsonAsync($"agents/{agentId.ToString(CultureInfo.InvariantCulture)}/isolation",
            new Dictionary<string, object?> { ["reason"] = reason, ["strict_isolation"] = false }, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        using var document = await ParseAsync(response, cancellationToken);
        return document is null ? null : ReadAgent(Single(document.RootElement, "agent"));
    }

    public async Task<HuntressAgent?> ReleaseAgentAsync(long agentId, CancellationToken cancellationToken)
    {
        using var response = await http.DeleteAsync($"agents/{agentId.ToString(CultureInfo.InvariantCulture)}/isolation", cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
        // The reference answers this one with the agent itself rather than wrapped; both are read.
        using var document = await ParseAsync(response, cancellationToken);
        return document is null ? null : ReadAgent(Single(document.RootElement, "agent"));
    }

    public async Task UninstallAgentAsync(long agentId, CancellationToken cancellationToken)
    {
        using var response = await http.DeleteAsync($"agents/{agentId.ToString(CultureInfo.InvariantCulture)}", cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
    }

    private static string NoticePath(HuntressNoticeKind kind) => kind == HuntressNoticeKind.Escalation ? "escalations" : "platform_actions";

    /// <summary>A single resource, or null when Huntress answers 404 (it does not know it, or the credentials may not see it).</summary>
    private async Task<JsonDocument?> GetAsync(string path, CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync(path, cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        await EnsureSuccessAsync(response, cancellationToken);
        return await ParseAsync(response, cancellationToken)
               ?? throw new HuntressApiException(response.StatusCode, $"Huntress answered {path} without a body.");
    }

    /// <summary>The body of an answer, or null when it has none (a 201 or 204 without content).</summary>
    private static async Task<JsonDocument?> ParseAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        var text = await response.Content.ReadAsStringAsync(cancellationToken);
        return string.IsNullOrWhiteSpace(text) ? null : JsonDocument.Parse(text);
    }

    /// <summary>The resource of a single answer: under its name, or the answer itself when Huntress did not wrap it.</summary>
    private static JsonElement Single(JsonElement root, string name) =>
        root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var inner) && inner.ValueKind == JsonValueKind.Object ? inner : root;

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.IsSuccessStatusCode)
        {
            return;
        }

        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        throw new HuntressApiException(response.StatusCode,
            $"Huntress {(int)response.StatusCode} for {response.RequestMessage?.Method} {response.RequestMessage?.RequestUri?.AbsolutePath}: {(body.Length > 500 ? body[..500] : body)}");
    }
}
