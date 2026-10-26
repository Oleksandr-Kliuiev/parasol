using Crm.Integrations.Core;
using Crm.SharedKernel.Text;

namespace Crm.Integrations.PartnerCenter;

/// <summary>
/// The billing export names its own links: the operation to poll (the <c>Location</c> of the export), the manifest and the line
/// files. They are data from outside the code (DEV-21), so each one is resolved against the configured Graph address and sorted
/// before a request is made: a link on the Graph origin is sent with the Graph token (<see cref="GraphLinks"/>), a file in the
/// export storage carries its own SAS signature and is sent without the token, and any other link is refused. A line file is
/// read only from the export storage (<see cref="ClassifyFile"/>).
/// </summary>
internal static class PartnerBillingLinks
{
    public enum Destination
    {
        /// <summary>The configured Graph origin: the request carries the Graph token.</summary>
        Graph,

        /// <summary>A signed file in the export storage: the SAS signature in the link is its only key, no token is sent.</summary>
        Storage,
    }

    /// <summary>The absolute link and where it goes, or a refusal that names no part of it: a storage link carries its signature.</summary>
    public static (Uri Uri, Destination Destination) Classify(Uri graphBase, string link, IEnumerable<string> storageHostSuffixes)
    {
        var uri = Resolve(graphBase, link);
        if (uri is not null && GraphLinks.IsSameOrigin(graphBase, uri))
        {
            return (uri, Destination.Graph);
        }

        if (uri is not null && WebUrl.HostMatches(uri, storageHostSuffixes))
        {
            if (!WebUrl.IsSecureEndpoint(uri))
            {
                throw Refused("a storage link that is not https");
            }

            return HasSasSignature(uri) ? (uri, Destination.Storage) : throw Refused("a storage link without a SAS signature");
        }

        throw Refused("a link outside the configured Graph address and the export storage (Integrations:PartnerCenter:BillingStorageHostSuffixes)");
    }

    /// <summary>
    /// A line file: only a signed https file in the export storage, sent without the token. A file is never read from Graph, so a
    /// link that resolves onto the Graph address (a bare file name, a manifest without its root directory) is refused like any
    /// other wrong link instead of going out with the token.
    /// </summary>
    public static Uri ClassifyFile(Uri graphBase, string link, IEnumerable<string> storageHostSuffixes)
    {
        var (uri, destination) = Classify(graphBase, link, storageHostSuffixes);
        return destination == Destination.Storage ? uri : throw Refused("a line file outside the export storage");
    }

    /// <summary>
    /// A relative link is a path on the Graph address. A link that starts with "/" is read as relative on purpose: as an absolute
    /// URI it would be a Unix file path ("file:///v1.0/…").
    /// </summary>
    private static Uri? Resolve(Uri graphBase, string link)
    {
        if (Uri.TryCreate(link, UriKind.Absolute, out var absolute) && absolute.Scheme is "http" or "https")
        {
            return absolute;
        }

        return Uri.TryCreate(link, UriKind.Relative, out var relative) && Uri.TryCreate(graphBase, relative, out var resolved) ? resolved : null;
    }

    /// <summary>An Azure SAS carries its signature in the <c>sig</c> query parameter.</summary>
    private static bool HasSasSignature(Uri uri) =>
        uri.Query.TrimStart('?').Split('&').Any(p => p.Length > "sig=".Length && p.StartsWith("sig=", StringComparison.Ordinal));

    private static PartnerBillingLinkRefusedException Refused(string what) =>
        new($"The partner billing export named {what}; it was not followed and no token was sent.");
}

/// <summary>
/// A link of the billing export that was not followed. A failed run records only the exception's type name (SyncRunner), so the
/// type says what happened; the message names the rule, never a part of the link.
/// </summary>
public sealed class PartnerBillingLinkRefusedException(string message) : InvalidOperationException(message);
