using System.Globalization;
using Crm.SharedKernel.Results;
using Crm.TimeTracking.Domain;

namespace Crm.TimeTracking.Features;

internal sealed partial class TimeApprovalService
{
    private static Error BankReview => Error.Conflict("TIM_BANK_RECONCILIATION_REQUIRED",
        "Historical bank movements do not match this time entry. Finance must review them before the operation can continue.");
    private static string SourcePrefix(TimeEntry entry, int approval) => string.Create(CultureInfo.InvariantCulture, $"{entry.Id}:{approval}:");

    private async Task<Error?> CheckNewApprovalAsync(TimeEntry entry, CancellationToken ct) =>
        (await contracts.GetSourceBankUsageAsync("TimeEntry", SourcePrefix(entry, entry.ApprovalCount + 1), ct)).Count == 0 ? null : BankReview;

    private async Task<Error?> CheckWithdrawalAsync(TimeEntry entry, CancellationToken ct)
    {
        var receipts = await contracts.GetSourceBankUsageAsync("TimeEntry", SourcePrefix(entry, entry.ApprovalCount), ct);
        var allocated = entry.CurrentAllocations.Where(a => a.HourBankId is not null).GroupBy(a => a.HourBankId!.Value)
            .ToDictionary(g => g.Key, g => g.Sum(a => a.Hours));
        if (receipts.Any(r => !r.Consistent || r.Date != entry.WorkDate ||
            r.SourceId != SourcePrefix(entry, entry.ApprovalCount) + r.HourBankId || r.ReturnedHours != 0 && r.ReturnedHours != r.ConsumedHours)) return BankReview;
        var consumed = receipts.Where(r => r.ConsumedHours > 0).GroupBy(r => r.HourBankId).ToDictionary(g => g.Key, g => g.Sum(r => r.ConsumedHours));
        if (allocated.Count != consumed.Count || allocated.Any(pair => consumed.GetValueOrDefault(pair.Key) != pair.Value)) return BankReview;
        return null;
    }
}
