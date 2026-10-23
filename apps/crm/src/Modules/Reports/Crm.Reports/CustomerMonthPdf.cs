using System.Globalization;
using Crm.Backup.Contracts;
using Crm.Customers.Contracts;
using Crm.Service.Contracts;
using Crm.SharedKernel.Documents;

namespace Crm.Reports;

/// <summary>
/// Parasoll's monthly summary of one customer as a PDF (M43), from <see cref="CustomerMonthSnapshot"/> alone, in Bokmål or English.
/// Every value is printed whole (wrapped, never cut). A Reconstructed summary says so under its title and in the footer of every page.
/// </summary>
internal static class CustomerMonthPdf
{
    /// <summary>Recorded with every filed summary; bump it whenever the output changes (filed summaries stay as they were).</summary>
    public const string RendererVersion = "customer-month-pdf/1";

    private const float LabelSize = 8f;
    private const float BodySize = 9.5f;
    private const float FigureSize = 15f;
    private const float RowHeight = BodySize * 1.9f;

    public static byte[] Render(CustomerMonthSnapshot s)
    {
        var t = CustomerMonthTexts.For(s.Language);
        var culture = t.Culture;
        var month = Capitalize(s.MonthStart.ToString("MMMM yyyy", culture), culture);
        var pdf = new PdfBuilder($"{t.Title} {s.OrganizationName} {month}");
        pdf.SetFooter((page, count) => Footer(s, t, page, count));

        // ---- Letterhead and title ----
        pdf.Y = PdfBuilder.Margin + 6f;
        pdf.DrawText("Parasoll", PdfBuilder.Left, pdf.Y, 15f, PdfFontStyle.Bold, PdfColor.Accent);
        pdf.DrawTextRight(t.Title, PdfBuilder.Right, pdf.Y - 3f, LabelSize, PdfFontStyle.Regular, PdfColor.Grey);
        pdf.MoveDown(16f);
        pdf.DrawRule(pdf.Y, color: PdfColor.Accent, thickness: 1.2f);
        pdf.MoveDown(10f);
        pdf.Paragraph(s.OrganizationName, 19f, PdfFontStyle.Bold, lineHeight: 1.25f);
        pdf.Paragraph(string.IsNullOrWhiteSpace(s.OrgNumber) ? month : $"{month} · {t.OrgNumber} {s.OrgNumber}", 11.5f, color: PdfColor.Grey);
        pdf.MoveDown(4f);
        pdf.Paragraph(string.Format(culture, t.Period, Date(s.MonthStart, culture), Date(s.MonthEnd, culture), Date(s.TakenAt, culture)),
            LabelSize, color: PdfColor.Grey);
        if (s.Provenance == StoredDocumentProvenance.Reconstructed)
        {
            pdf.MoveDown(6f);
            pdf.Paragraph(string.Format(culture, t.ReconstructedNote, Date(s.TakenAt, culture)), BodySize, color: PdfColor.Accent);
        }

        pdf.MoveDown(10f);

        // ---- Alerts ----
        Heading(pdf, t.Alerts);
        var alerts = s.Service.Alerts;
        if (alerts.Count == 0)
        {
            pdf.Paragraph(t.NoAlerts, BodySize);
        }
        else
        {
            Table(pdf, [t.Source, t.Severity, t.Opened, t.Resolved, t.OpenAtEnd], [0.30f, 0.22f, 0.16f, 0.16f, 0.16f],
                alerts.Select(a => (IReadOnlyList<string>)[CustomerMonthTexts.SourceName(a.System), t.SeverityName(a.Severity), Count(a.Opened, culture), Count(a.Resolved, culture),
                    Count(a.OpenAtEnd, culture)]).ToList(),
                [t.Total, string.Empty, Count(alerts.Sum(a => a.Opened), culture), Count(alerts.Sum(a => a.Resolved), culture),
                    Count(alerts.Sum(a => a.OpenAtEnd), culture)]);
        }

        // ---- Tickets ----
        Heading(pdf, t.Tickets);
        Figures(pdf, [(t.TicketsCreated, Count(s.Service.TicketsCreated, culture)), (t.TicketsResolved, Count(s.Service.TicketsResolved, culture)),
            (t.TicketsOpen, Count(s.Service.TicketsOpenAtEnd, culture))]);

        // ---- Devices ----
        Heading(pdf, t.Devices);
        if (s.Devices is { } devices)
        {
            Figures(pdf, Enum.GetValues<DeviceType>().Where(type => devices.Counts.GetValueOrDefault(type) > 0 || type is DeviceType.Workstation or DeviceType.Server)
                .Select(type => (t.DeviceTypeName(type), Count(devices.Counts.GetValueOrDefault(type), culture))).ToList());
            pdf.Paragraph(devices.CountedOn is { } counted ? string.Format(culture, t.DevicesCounted, Date(counted, culture)) : t.DevicesLive,
                LabelSize, color: PdfColor.Grey);
        }
        else
        {
            pdf.Paragraph(t.NoDevices, BodySize);
        }

        // ---- Security ----
        Heading(pdf, t.Security);
        if (s.Security.Count == 0)
        {
            pdf.Paragraph(t.NoSecurity, BodySize);
        }
        else
        {
            foreach (var report in s.Security)
            {
                Figures(pdf, [
                    (t.IncidentsReported, Count(report.IncidentsReported, culture, t.NotGiven)),
                    (t.IncidentsResolved, Count(report.IncidentsResolved, culture, t.NotGiven)),
                    (t.SignalsDetected, Count(report.SignalsDetected, culture, t.NotGiven)),
                    (t.Agents, Count(report.AgentsCount, culture, t.NotGiven)),
                ]);
            }

            pdf.Paragraph(t.SecurityFiled, LabelSize, color: PdfColor.Grey);
        }

        // ---- Backup ----
        Heading(pdf, t.Backup);
        if (s.Backup is not { } backup)
        {
            pdf.Paragraph(t.NoBackup, BodySize);
        }
        else if (backup.Services.Count == 0)
        {
            pdf.Paragraph(backup.ReadAt is null ? t.BackupNotRead : t.BackupEmpty, BodySize);
        }
        else
        {
            Table(pdf, [t.Service, t.InBackup, t.Ok, t.Failed, t.Late, t.Paused, t.NotInBackup], [0.22f, 0.13f, 0.13f, 0.13f, 0.13f, 0.13f, 0.13f],
                backup.Services.Select(v => (IReadOnlyList<string>)[t.ServiceName(v.Service), Count(v.Total, culture), Count(v.Ok, culture), Count(v.Failed, culture),
                    Count(v.Late, culture), Count(v.Paused, culture), Count(v.NotInBackup, culture)]).ToList(), null);
            pdf.Paragraph(backup.ReadAt is { } read
                ? string.Format(culture, backup.ReadComplete ? t.BackupRead : t.BackupReadIncomplete, Date(read, culture))
                : t.BackupNotRead, LabelSize, color: PdfColor.Grey);
        }

        // ---- Hours ----
        Heading(pdf, t.Hours);
        if (s.Hours is { } hours)
        {
            Figures(pdf, [(t.HoursWorked, Hours(hours, t)), (t.HoursBillable, Hours(s.BilledHours ?? 0m, t))]);
        }
        else
        {
            pdf.Paragraph(t.NoHours, BodySize);
        }

        return pdf.Build();
    }

    private static void Heading(PdfBuilder pdf, string text)
    {
        pdf.EnsureSpace(64f);
        pdf.MoveDown(18f);
        pdf.DrawText(text.ToUpper(CultureInfo.InvariantCulture), PdfBuilder.Left, pdf.Y, LabelSize, PdfFontStyle.Bold, PdfColor.Grey);
        pdf.MoveDown(6f);
        pdf.DrawRule(pdf.Y);
        pdf.MoveDown(4f);
    }

    /// <summary>A row of figures: the number large, its label under it, each label wrapped in its own column.</summary>
    private static void Figures(PdfBuilder pdf, List<(string Label, string Value)> figures)
    {
        var width = PdfBuilder.ContentWidth / Math.Max(1, figures.Count);
        var labels = figures.Select(f => PdfBuilder.Wrap(f.Label, width - 10f, LabelSize)).ToList();
        var height = FigureSize * 1.4f + (labels.Max(l => l.Count) * LabelSize * 1.35f) + 6f;
        pdf.EnsureSpace(height);
        var top = pdf.Y + FigureSize * 1.25f;
        for (var i = 0; i < figures.Count; i++)
        {
            var x = PdfBuilder.Left + (i * width);
            pdf.DrawText(figures[i].Value, x, top, FigureSize, PdfFontStyle.Bold);
            var line = top + LabelSize * 1.5f;
            foreach (var part in labels[i])
            {
                pdf.DrawText(part, x, line, LabelSize, PdfFontStyle.Regular, PdfColor.Grey);
                line += LabelSize * 1.35f;
            }
        }

        pdf.Y += height;
    }

    /// <summary>
    /// A table with its header repeated on a new page; every cell wraps in its column (first column left, the others right-aligned), so a
    /// long source name or service is printed whole. <paramref name="footer"/> is a bold total row.
    /// </summary>
    private static void Table(
        PdfBuilder pdf, IReadOnlyList<string> header, IReadOnlyList<float> widths, List<IReadOnlyList<string>> rows, IReadOnlyList<string>? footer)
    {
        var columns = widths.Select(w => w * PdfBuilder.ContentWidth).ToList();

        void Row(IReadOnlyList<string> cells, PdfFontStyle style, PdfColor color, bool band)
        {
            var wrapped = cells.Select((cell, i) => PdfBuilder.Wrap(cell, columns[i] - 10f, BodySize, style)).ToList();
            var height = Math.Max(RowHeight, (wrapped.Max(w => w.Count) * BodySize * 1.3f) + 8f);
            if (pdf.EnsureSpace(height + RowHeight))
            {
                Row(header, PdfFontStyle.Bold, PdfColor.Grey, false);
            }

            if (band)
            {
                pdf.DrawRect(PdfBuilder.Left, pdf.Y, PdfBuilder.ContentWidth, height, PdfColor.Band);
            }

            var x = PdfBuilder.Left;
            for (var i = 0; i < cells.Count; i++)
            {
                var line = pdf.Y + BodySize * 1.35f;
                foreach (var part in wrapped[i])
                {
                    if (i == 0)
                    {
                        pdf.DrawText(part, x + 4f, line, BodySize, style, color);
                    }
                    else
                    {
                        pdf.DrawTextRight(part, x + columns[i] - 4f, line, BodySize, style, color);
                    }

                    line += BodySize * 1.3f;
                }

                x += columns[i];
            }

            pdf.Y += height;
        }

        Row(header, PdfFontStyle.Bold, PdfColor.Grey, false);
        for (var r = 0; r < rows.Count; r++)
        {
            Row(rows[r], PdfFontStyle.Regular, PdfColor.Black, r % 2 == 0);
        }

        if (footer is not null)
        {
            pdf.DrawRule(pdf.Y);
            Row(footer, PdfFontStyle.Bold, PdfColor.Black, false);
        }
    }

    private const string FooterSeparator = "   ·   ";
    private const float FooterSize = 8f;

    /// <summary>One line under every page: a reconstructed summary says so first, the page numbers always fit.</summary>
    internal static string Footer(CustomerMonthSnapshot s, CustomerMonthTexts t, int page, int count)
    {
        string Compose(string? customer) => string.Join(FooterSeparator, new[]
        {
            s.Provenance == StoredDocumentProvenance.Reconstructed ? string.Format(t.Culture, t.ReconstructedFooter, Date(s.TakenAt, t.Culture)) : null,
            "Parasoll",
            customer,
            string.Format(t.Culture, t.Page, page, count),
        }.Where(part => !string.IsNullOrWhiteSpace(part)));

        var full = Compose(s.OrganizationName);
        if (PdfBuilder.Measure(full, FooterSize) <= PdfBuilder.ContentWidth)
        {
            return full;
        }

        var room = PdfBuilder.ContentWidth - PdfBuilder.Measure(Compose(null) + FooterSeparator, FooterSize);
        return room >= 40f ? Compose(PdfBuilder.Ellipsize(s.OrganizationName, room, FooterSize)) : Compose(null);
    }

    private static string Date(DateOnly day, CultureInfo culture) => day.ToString("dd.MM.yyyy", culture);

    private static string Date(DateTimeOffset at, CultureInfo culture) =>
        TimeZoneInfo.ConvertTime(at, TimeZoneInfo.FindSystemTimeZoneById("Europe/Oslo")).ToString("dd.MM.yyyy", culture);

    private static string Count(long value, CultureInfo culture) => value.ToString("#,0", culture);

    private static string Count(long? value, CultureInfo culture, string notGiven) => value is { } v ? Count(v, culture) : notGiven;

    private static string Hours(decimal value, CustomerMonthTexts t) => $"{value.ToString("#,0.#", t.Culture)} {t.HourUnit}";

    private static string Capitalize(string text, CultureInfo culture) => text.Length == 0 ? text : char.ToUpper(text[0], culture) + text[1..];
}

/// <summary>The words of the monthly summary in Bokmål (also for Nynorsk readers) and English.</summary>
internal sealed record CustomerMonthTexts(
    CultureInfo Culture,
    string Title, string OrgNumber, string Period, string ReconstructedNote, string ReconstructedFooter, string Page,
    string Alerts, string NoAlerts, string Source, string Severity, string Opened, string Resolved, string OpenAtEnd, string Total,
    string Critical, string Warning,
    string Tickets, string TicketsCreated, string TicketsResolved, string TicketsOpen,
    string Devices, string Workstations, string Servers, string Network, string OtherDevices, string DevicesCounted, string DevicesLive, string NoDevices,
    string Security, string IncidentsReported, string IncidentsResolved, string SignalsDetected, string Agents, string SecurityFiled, string NoSecurity,
    string NotGiven,
    string Backup, string Service, string InBackup, string Ok, string Failed, string Late, string Paused, string NotInBackup, string BackupRead,
    string BackupReadIncomplete, string BackupNotRead, string BackupEmpty, string NoBackup, string Mail, string OneDrive, string SharePoint, string Teams,
    string OtherService,
    string Hours, string HoursWorked, string HoursBillable, string NoHours, string HourUnit)
{
    /// <summary>A source is named as its label everywhere (UX glossary): the vendor's name, or Parasoll for its own coverage checks.</summary>
    public static string SourceName(string system) => system switch
    {
        "atera" => "Atera",
        "huntress" => "Huntress",
        "cloudally" => "CloudAlly",
        "parasoll" => "Parasoll",
        _ => system,
    };

    public string SeverityName(AlertSeverity severity) => severity == AlertSeverity.Critical ? Critical : Warning;

    public string DeviceTypeName(DeviceType type) => type switch
    {
        DeviceType.Workstation => Workstations,
        DeviceType.Server => Servers,
        DeviceType.Network => Network,
        _ => OtherDevices,
    };

    public string ServiceName(BackupService service) => service switch
    {
        BackupService.Mail => Mail,
        BackupService.OneDrive => OneDrive,
        BackupService.SharePoint => SharePoint,
        BackupService.Teams => Teams,
        _ => OtherService,
    };

    public static CustomerMonthTexts For(string? language) => language is "en" ? English : Norwegian;

    /// <summary>
    /// The language's formats with characters the PDF's fonts have (WinAnsi): where ICU gives a narrow no-break space between thousands
    /// or a minus sign, which would print as a question mark, a no-break space and a hyphen stand in.
    /// </summary>
    private static CultureInfo PdfCulture(string name)
    {
        var culture = (CultureInfo)CultureInfo.GetCultureInfo(name).Clone();
        if (culture.NumberFormat.NumberGroupSeparator.Any(c => c > 'ÿ'))
        {
            culture.NumberFormat.NumberGroupSeparator = " ";
        }

        if (culture.NumberFormat.NegativeSign.Any(c => c > 'ÿ'))
        {
            culture.NumberFormat.NegativeSign = "-";
        }

        return culture;
    }

    private static readonly CustomerMonthTexts Norwegian = new(
        PdfCulture("nb-NO"),
        "Månedsrapport", "Org.nr.", "Perioden {0}–{1}, laget {2}.",
        "Rekonstruert: laget {0} av det Parasoll hadde da, ikke ved månedsslutt. Løste driftsvarsler og lukkede hendelser kan være slettet etter sin lagringstid, og sikkerhetskopien er vist slik den sto da rapporten ble laget.",
        "Rekonstruert {0}", "Side {0} av {1}",
        "Driftsvarsler", "Ingen driftsvarsler i måneden.", "Kilde", "Alvorlighet", "Nye", "Løst", "Åpne ved månedsslutt", "Sum",
        "Kritisk", "Advarsel",
        "Saker i servicedesken", "Opprettet", "Løst", "Åpne ved månedsslutt",
        "Enheter ved månedsslutt", "Arbeidsstasjoner", "Servere", "Nettverksenheter", "Andre enheter", "Telling fra Atera {0}.",
        "Ingen daglig telling: enhetene Atera meldte da rapporten ble laget, er talt.", "Ingen enheter fra Atera i måneden.",
        "Sikkerhet (Huntress)", "Hendelser meldt", "Hendelser løst", "Signaler oppdaget", "Agenter",
        "Huntress' egen månedsrapport ligger også blant kundens dokumenter i Parasoll.", "Ingen månedsrapport fra Huntress for måneden.",
        "ikke oppgitt",
        "Sikkerhetskopi (CloudAlly)", "Tjeneste", "I kopi", "I orden", "Feilet", "Forsinket", "På pause", "Ikke i kopi", "CloudAlly lest {0}.",
        "CloudAlly lest {0}, men lesingen ble ikke fullført.", "CloudAlly er ikke lest ennå.", "Ingen sikkerhetskopier lest ennå.",
        "Ingen CloudAlly-konto koblet til kunden.", "E-post", "OneDrive", "SharePoint", "Teams og grupper", "Annet",
        "Timer", "Arbeidet", "Fakturerbart", "Ingen godkjente timer i måneden.", "t");

    private static readonly CustomerMonthTexts English = new(
        PdfCulture("en-GB"),
        "Monthly report", "Org. no.", "Period {0}–{1}, made {2}.",
        "Reconstructed: made {0} from what Parasoll held then, not at the month's end. Resolved alerts and closed incidents may be gone after their retention, and backups are shown as they stood when the report was made.",
        "Reconstructed {0}", "Page {0} of {1}",
        "Alerts", "No alerts in the month.", "Source", "Severity", "New", "Resolved", "Open at month end", "Total",
        "Critical", "Warning",
        "Service desk tickets", "Created", "Resolved", "Open at month end",
        "Devices at month end", "Workstations", "Servers", "Network devices", "Other devices", "Counted from Atera on {0}.",
        "No daily count: the devices Atera reported when the report was made are counted.", "No devices from Atera in the month.",
        "Security (Huntress)", "Incidents reported", "Incidents resolved", "Signals detected", "Agents",
        "Huntress's own monthly report is also among the customer's documents in Parasoll.", "No monthly report from Huntress for the month.",
        "not given",
        "Backup (CloudAlly)", "Service", "In backup", "OK", "Failed", "Overdue", "Paused", "Not in backup", "CloudAlly read {0}.",
        "CloudAlly read {0}, but the read did not finish.", "CloudAlly has not been read yet.", "No backups read yet.",
        "No CloudAlly account linked to the customer.", "Email", "OneDrive", "SharePoint", "Teams and groups", "Other",
        "Hours", "Worked", "Billable", "No approved hours in the month.", "h");
}
