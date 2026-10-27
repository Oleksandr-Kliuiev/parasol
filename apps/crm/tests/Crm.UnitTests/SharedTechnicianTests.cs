using Crm.Identity.Contracts;
using Crm.Identity.Domain;
using Crm.Integrations.Atera;

namespace Crm.UnitTests;

/// <summary>
/// One Atera account for the whole firm (after M39): the technician shared by everyone is the one a person without their own
/// writes as, and sharing it is a person's decision that belongs to no one in particular.
/// </summary>
public class SharedTechnicianTests
{
    private static readonly Guid Me = Guid.NewGuid();
    private static readonly Guid Colleague = Guid.NewGuid();

    private static TechnicianListing Technician(string id, Guid? user = null, bool shared = false) =>
        new(id, $"Tekniker {id}", $"{id}@firm.test", user, shared);

    [Fact]
    public void A_person_writes_as_their_own_technician_before_the_shared_one()
    {
        var mine = Technician("101", Me);

        AteraTechnicians.WritesAs([Technician("100", shared: true), mine, Technician("102", Colleague)], Me).ShouldBe(mine);
    }

    [Fact]
    public void A_person_without_their_own_writes_as_the_shared_one()
    {
        var shared = Technician("100", shared: true);

        AteraTechnicians.WritesAs([Technician("102", Colleague), shared], Me).ShouldBe(shared);
    }

    [Fact]
    public void Only_a_numeric_atera_id_signs_so_a_mapping_keyed_by_email_never_does()
    {
        AteraTechnicians.WritesAs([Technician("felles@firm.test", shared: true), Technician("tekniker@firm.test", Me)], Me).ShouldBeNull();
    }

    [Fact]
    public void Without_their_own_or_a_shared_technician_there_is_no_one_to_write_as()
    {
        AteraTechnicians.WritesAs([Technician("102", Colleague)], Me).ShouldBeNull();
        AteraTechnicians.WritesAs([Technician("100", shared: true)], null).ShouldBeNull();
    }

    [Fact]
    public void Sharing_ends_a_persons_mapping_and_tells_the_time_module_that_no_one_owns_it()
    {
        var mapping = TechnicianMapping.Register(new TechnicianRef("atera", "100", "felles@firm.test", "Felles"), Me, DateTimeOffset.UtcNow);
        mapping.Method.ShouldBe(TechnicianMappingMethod.Email);

        mapping.ShareWithEveryone();

        mapping.Shared.ShouldBeTrue();
        mapping.UserId.ShouldBeNull();
        mapping.Method.ShouldBe(TechnicianMappingMethod.Manual);
        mapping.DomainEvents.OfType<TechnicianMappingChanged>().ShouldHaveSingleItem().UserId.ShouldBeNull();
    }

    [Fact]
    public void Mapping_a_shared_technician_to_a_person_or_to_no_one_ends_the_sharing()
    {
        var mapping = TechnicianMapping.Register(new TechnicianRef("atera", "100", null, "Felles"), null, DateTimeOffset.UtcNow);

        mapping.ShareWithEveryone();
        mapping.MapTo(Colleague);
        mapping.Shared.ShouldBeFalse();
        mapping.UserId.ShouldBe(Colleague);

        mapping.ShareWithEveryone();
        mapping.MapTo(null);
        mapping.Shared.ShouldBeFalse();
        mapping.Method.ShouldBe(TechnicianMappingMethod.Unmapped);
    }
}
