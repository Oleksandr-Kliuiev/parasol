using Crm.Integrations.Core;
using Crm.Integrations.Core.Persistence;
using Crm.Integrations.MicrosoftGraph;
using Microsoft.Extensions.Options;

namespace Crm.UnitTests;

/// <summary>
/// The customers' folders in SharePoint (M47): the CRM's own folder name and how it is recognized, the names a person would have given an
/// old folder, the root folder's addresses, and a folder as the mapping screen reads it.
/// </summary>
public class SharePointFolderTests
{
    [Theory]
    [InlineData("Fjord IT AS (999888777)", "999888777")]
    [InlineData("Fjord IT AS (999888777) ", "999888777")]
    [InlineData("Kviknes Hotel", null)]
    [InlineData("Prosjekt (2026)", null)]
    [InlineData("Avdeling (999888777) gammel", null)]
    public void The_org_number_is_read_only_from_the_end_of_a_name(string folder, string? expected)
    {
        SharePointNames.OrgNumberOf(folder).ShouldBe(expected);
    }

    [Theory]
    [InlineData("Fjord IT AS (999888777)", "999888777", true)]
    [InlineData("Fjord IT (999888777)", "999888777", true)]
    [InlineData("Fjord IT AS (999888777)", "912345678", false)]
    [InlineData("Fjord IT AS", "999888777", false)]
    [InlineData("Fjord IT AS (999888777)", null, false)]
    public void Only_a_folder_with_the_crms_own_form_for_the_organization_follows_a_rename(string folder, string? orgNumber, bool own)
    {
        SharePointNames.IsOwnName(folder, orgNumber).ShouldBe(own);
    }

    [Fact]
    public void A_long_name_gives_way_and_the_org_number_stays()
    {
        var name = SharePointNames.FolderName(new string('A', 200), "999888777");
        name.Length.ShouldBe(120);
        SharePointNames.IsOwnName(name, "999888777").ShouldBeTrue();
    }

    [Fact]
    public void A_person_named_the_old_folders_without_the_company_form()
    {
        SharePointNames.PlainNames("Kviknes Hotel AS").ShouldBe(["Kviknes Hotel AS", "Kviknes Hotel"]);
        SharePointNames.PlainNames("Gasta").ShouldBe(["Gasta"]);
        SharePointNames.PlainNames("AS").ShouldBe(["AS"], "a name that is nothing but the form keeps it");
        SharePointNames.PlainNames("Walther Sæthre & Co").ShouldBe(["Walther Sæthre & Co"]);
        SharePointNames.PlainNames("Kunde / Avdeling ASA").ShouldBe(["Kunde - Avdeling ASA", "Kunde - Avdeling"]);
    }

    [Fact]
    public void The_root_folder_is_a_path_inside_the_library_and_every_segment_is_escaped()
    {
        SharePointNames.RootPath(" /Kunder/ ").ShouldBe("Kunder");
        SharePointNames.RootPath(null).ShouldBe(string.Empty);
        SharePointNames.ItemAddress("drive-1", "Kunder", suffix: "/children").ShouldBe("drives/drive-1/root:/Kunder:/children");
        SharePointNames.ItemAddress("drive-1", "Kunder", "Fjord IT AS (999888777)")
            .ShouldBe("drives/drive-1/root:/Kunder/Fjord%20IT%20AS%20%28999888777%29:");
        SharePointNames.ItemAddress("drive-1", null, suffix: "/children").ShouldBe("drives/drive-1/root/children");
        SharePointNames.ItemAddress("drive-1", "Delt/Kunder", "Ærø & Co").ShouldBe("drives/drive-1/root:/Delt/Kunder/%C3%86r%C3%B8%20%26%20Co:");
    }

    [Fact]
    public void A_folder_is_matched_by_its_name_without_the_number_and_by_the_number_it_carries()
    {
        var adapter = new SharePointAdapter(Options.Create(new GraphOptions()), new EmptyServices());
        var made = new ExternalRecord
        {
            System = SharePointTypes.System, ExternalType = SharePointTypes.Folder, ExternalId = "item-1", DisplayName = "Fjord IT AS (999888777)",
            OrgNumber = "999888777", Payload = "{}", Hash = "x",
        };
        var old = new ExternalRecord
        {
            System = SharePointTypes.System, ExternalType = SharePointTypes.Folder, ExternalId = "item-2", DisplayName = "Kviknes Hotel",
            Payload = "{}", Hash = "x",
        };

        adapter.ToOrganizationData(made).ShouldSatisfyAllConditions(
            data => data!.Name.ShouldBe("Fjord IT AS"),
            data => data!.OrgNumber.ShouldBe("999888777"));
        adapter.ToOrganizationData(old)!.OrgNumber.ShouldBeNull();
        adapter.RecordTypes.Single().Importable.ShouldBeFalse("a folder is linked, never turned into an organization");
        adapter.RecordTypes.Single().EntityType.ShouldBe(EntityTypes.Organization);
    }

    [Fact]
    public void Writing_needs_the_switches_and_the_application_identity()
    {
        var options = new GraphOptions { Enabled = true, TenantId = "t", ClientId = "c", CertificatePath = "/run/secrets/graph.pfx" };
        options.SharePoint.Enabled = true;
        options.SharePoint.SiteId = "site";
        options.SharePoint.WriteEnabled = true;
        options.SharePoint.EnabledActions.Add(SharePointActionKinds.FolderCreate);

        var switches = new SharePointActionGate(new Monitor(options)).Read();
        switches.Enabled.ShouldBeTrue();
        switches.Configured.ShouldBeTrue();
        switches.WriteEnabled.ShouldBeTrue();
        switches.EnabledActions.ShouldBe([SharePointActionKinds.FolderCreate]);

        options.CertificatePath = "graph.pfx";
        new SharePointActionGate(new Monitor(options)).Read().Configured.ShouldBeFalse("a relative certificate path is refused by the credential");
        options.SharePoint.SiteId = null;
        new SharePointActionGate(new Monitor(options)).Read().Enabled.ShouldBeFalse("SharePoint needs its site");
    }

    private sealed class EmptyServices : IServiceProvider
    {
        public object? GetService(Type serviceType) => null;
    }

    private sealed class Monitor(GraphOptions value) : IOptionsMonitor<GraphOptions>
    {
        public GraphOptions CurrentValue => value;

        public GraphOptions Get(string? name) => value;

        public IDisposable? OnChange(Action<GraphOptions, string?> listener) => null;
    }
}
