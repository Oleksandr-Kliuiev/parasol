using System.Globalization;
using Crm.Activities.Contracts;
using Crm.Billing.Contracts;
using Crm.Contracts.Contracts;

namespace Crm.Web.CustomerFacts;

/// <summary>Why a customer needs attention now, most urgent first: the attention view is ordered in this order.</summary>
public enum AttentionReason
{
    /// <summary>An invoice has an amount left after its due date (billing.read).</summary>
    OverdueInvoices,

    /// <summary>An open task or meeting is past its due time (activities.read).</summary>
    OverdueWork,

    /// <summary>An active contract ends within the next <see cref="AttentionRanking.AgreementEndingDays"/> days, today included (contracts.read).</summary>
    AgreementEnding,

    /// <summary>An active hour bank is low (contracts.read).</summary>
    HourBankLow,
}

/// <summary>
/// What the modules said about one organization, merged: the values that put it on the attention list and order it. Values of a
/// kind the caller may not see are never asked for, so they stay empty here.
/// </summary>
public sealed record AttentionCandidate(
    Guid OrganizationId,
    int OverdueInvoices,
    decimal OverdueAmount,
    int OverdueWork,
    DateOnly? AgreementEndsOn,
    bool HourBankLow)
{
    public IReadOnlyList<AttentionReason> Reasons
    {
        get
        {
            var reasons = new List<AttentionReason>(4);
            if (OverdueInvoices > 0)
            {
                reasons.Add(AttentionReason.OverdueInvoices);
            }

            if (OverdueWork > 0)
            {
                reasons.Add(AttentionReason.OverdueWork);
            }

            if (AgreementEndsOn is not null)
            {
                reasons.Add(AttentionReason.AgreementEnding);
            }

            if (HourBankLow)
            {
                reasons.Add(AttentionReason.HourBankLow);
            }

            return reasons;
        }
    }
}

/// <summary>Merges the modules' answers and orders the customers that need attention (UX 2026, В6). Pure, so it is unit tested.</summary>
public static class AttentionRanking
{
    /// <summary>How far ahead an ending contract counts, today included.</summary>
    public const int AgreementEndingDays = 60;

    /// <summary>How many customers the attention view shows; the response says how many qualify in all.</summary>
    public const int Shown = 50;

    private static readonly StringComparer Names = StringComparer.Create(CultureInfo.GetCultureInfo("nb-NO"), ignoreCase: true);

    /// <summary>One candidate per organization that has at least one reason; each module answers with one row per organization.</summary>
    public static IReadOnlyList<AttentionCandidate> Merge(
        IEnumerable<OrganizationOverdueInvoices> invoices,
        IEnumerable<OrganizationOverdueWork> work,
        IEnumerable<OrganizationAgreementEnding> agreements,
        IEnumerable<OrganizationLowHourBanks> hourBanks)
    {
        var merged = new Dictionary<Guid, AttentionCandidate>();
        AttentionCandidate Of(Guid id) => merged.TryGetValue(id, out var found) ? found : new AttentionCandidate(id, 0, 0m, 0, null, false);

        foreach (var row in invoices.Where(r => r.Overdue > 0))
        {
            var current = Of(row.OrganizationId);
            merged[row.OrganizationId] = current with
            {
                OverdueInvoices = current.OverdueInvoices + row.Overdue,
                OverdueAmount = current.OverdueAmount + row.OverdueAmount,
            };
        }

        foreach (var row in work.Where(r => r.Overdue > 0))
        {
            var current = Of(row.OrganizationId);
            merged[row.OrganizationId] = current with { OverdueWork = current.OverdueWork + row.Overdue };
        }

        foreach (var row in agreements.Where(r => r.Contracts > 0))
        {
            var current = Of(row.OrganizationId);
            merged[row.OrganizationId] = current with
            {
                AgreementEndsOn = current.AgreementEndsOn is { } earlier && earlier < row.EndsOn ? earlier : row.EndsOn,
            };
        }

        foreach (var row in hourBanks.Where(r => r.Banks > 0))
        {
            merged[row.OrganizationId] = Of(row.OrganizationId) with { HourBankLow = true };
        }

        return merged.Values.ToList();
    }

    /// <summary>
    /// Most urgent first: overdue invoices — by the overdue amount when the caller may see money, else by how many are overdue —,
    /// then overdue work by how much, then the soonest ending contract, then a low hour bank; ties by name (Norwegian order,
    /// case ignored), then id. A caller without <c>finance.read</c> is never ordered by money, so the order cannot reveal it.
    /// </summary>
    public static IReadOnlyList<T> Rank<T>(IEnumerable<T> items, Func<T, AttentionCandidate> candidate, Func<T, string> name, bool byOverdueAmount) =>
        items
            .Select(item => (Item: item, Candidate: candidate(item)))
            .OrderByDescending(x => x.Candidate.OverdueInvoices > 0)
            .ThenByDescending(x => byOverdueAmount ? x.Candidate.OverdueAmount : x.Candidate.OverdueInvoices)
            .ThenByDescending(x => x.Candidate.OverdueWork)
            .ThenBy(x => x.Candidate.AgreementEndsOn ?? DateOnly.MaxValue)
            .ThenByDescending(x => x.Candidate.HourBankLow)
            .ThenBy(x => name(x.Item), Names)
            .ThenBy(x => x.Candidate.OrganizationId)
            .Select(x => x.Item)
            .ToList();
}
