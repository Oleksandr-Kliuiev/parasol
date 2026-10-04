using Crm.Customers.Domain;
using Crm.Privacy.Contracts;
using Crm.Privacy.Domain;
using Crm.Privacy.Features;
using Crm.Sales.Contracts;
using Crm.Sales.Domain;

namespace Crm.UnitTests;

/// <summary>DEV-11: the pieces of a subject request that need no database.</summary>
public class PrivacyDomainTests
{
    [Fact]
    public void A_plan_is_recognised_by_its_digest_whatever_order_the_modules_answered_in()
    {
        var contact = new PlannedErasure(new RecordRef("customers", "Contact", Guid.Parse("00000000-0000-0000-0000-000000000002")), ErasureAction.Pseudonymize, "customers.contact");
        var call = new PlannedErasure(new RecordRef("activities", "Activity", Guid.Parse("00000000-0000-0000-0000-000000000001")), ErasureAction.Delete, "activities.activity");
        var first = PrivacyPlan.Serialize(PrivacyPlan.Canonical([contact, call]));
        var second = PrivacyPlan.Serialize(PrivacyPlan.Canonical([call, contact]));

        PrivacyPlan.Digest(first).ShouldBe(PrivacyPlan.Digest(second));
        PrivacyPlan.Deserialize(first).ShouldBe([call, contact]);
        var held = PrivacyPlan.Serialize(PrivacyPlan.Canonical([contact, call with { Action = ErasureAction.Retain, Basis = RetentionBasis.LegalHold, RetainUntil = new DateOnly(2027, 1, 1) }]));
        PrivacyPlan.Digest(held).ShouldNotBe(PrivacyPlan.Digest(first), "a hold placed after the preview makes it a different plan");
    }

    [Fact]
    public void A_suppression_hash_ignores_case_and_spaces_and_depends_on_the_installation_key()
    {
        var key = Enumerable.Range(1, 32).Select(i => (byte)i).ToArray();
        SuppressionHasher.Hash(key, " Ola.Nordmann@Example.NO ").ShouldBe(SuppressionHasher.Hash(key, "ola.nordmann@example.no"));
        SuppressionHasher.Hash(key, "ola.nordmann@example.no").ShouldNotContain("ola");
        SuppressionHasher.Hash([.. key.Reverse()], "ola.nordmann@example.no").ShouldNotBe(SuppressionHasher.Hash(key, "ola.nordmann@example.no"));
    }

    [Fact]
    public void An_erased_contact_keeps_its_row_under_a_pseudonym_from_its_id_and_ends_every_affiliation_but_a_held_one()
    {
        var contact = Contact.Create(new ContactDetails("Ola", "Nordmann", "ola@example.no", "+47 900 00 000", "+47 400 00 000", "nb")).Value;
        contact.Affiliate(Guid.NewGuid(), new AffiliationDetails("Daglig leder", ContactRoles.DecisionMaker, IsPrimary: true)).IsSuccess.ShouldBeTrue();
        contact.Affiliate(Guid.NewGuid(), new AffiliationDetails("Styreleder", ContactRoles.None, IsPrimary: false)).IsSuccess.ShouldBeTrue();
        var held = contact.Affiliations.Last().Id;
        contact.ClearDomainEvents();

        contact.Pseudonymize("PRV-2026-0001", new HashSet<Guid> { held }).ShouldBeTrue();

        contact.FullName.ShouldBe(Contact.PseudonymFor(contact.Id));
        contact.FullName.ShouldStartWith("Anonymized-");
        (contact.Email, contact.Phone, contact.MobilePhone, contact.PreferredLanguage).ShouldBe((null as string, null as string, null as string, null as string));
        contact.IsDeleted.ShouldBeTrue();
        contact.ErasureReference.ShouldBe("PRV-2026-0001");
        contact.DomainEvents.ShouldBeEmpty("an erasure is not a change to send to PowerOffice");
        var ended = contact.Affiliations.Single(a => a.Id != held);
        (ended.Title, ended.IsActive, ended.IsPrimary, ended.IsDeleted).ShouldBe((null as string, false, false, true));
        var kept = contact.Affiliations.Single(a => a.Id == held);
        (kept.Title, kept.IsActive, kept.IsDeleted).ShouldBe(("Styreleder", true, false));
        contact.Pseudonymize("PRV-2026-0002", new HashSet<Guid> { held }).ShouldBeFalse("nothing left to erase");
    }

    [Fact]
    public void A_lead_loses_the_prospect_s_details_and_a_quote_forgets_who_it_went_to()
    {
        var lead = Lead.Create(new LeadDetails("Firma AS", null, "Kari Hansen", "kari@example.no", "+47 22 00 00 00", "Web", null, "Ring Kari")).Value;
        lead.Pseudonymize("PRV-2026-0003").ShouldBeTrue();
        (lead.CompanyName, lead.ContactName, lead.Email, lead.Phone, lead.Notes, lead.IsDeleted).ShouldBe(("Firma AS", null as string, null as string, null as string, null as string, true));
        lead.Pseudonymize("PRV-2026-0003").ShouldBeFalse();
    }

    [Fact]
    public void A_hold_lasts_to_its_end_date_inclusive_or_until_released()
    {
        var hold = LegalHold.Place("activities", "Activity", Guid.NewGuid(), LegalHoldReason.LegalClaim, "Dispute", new DateOnly(2026, 12, 31));
        hold.IsActiveOn(new DateOnly(2026, 12, 31)).ShouldBeTrue();
        hold.IsActiveOn(new DateOnly(2027, 1, 1)).ShouldBeFalse();
        hold.Release("Settled", null, DateTimeOffset.UtcNow);
        hold.IsActiveOn(new DateOnly(2026, 6, 1)).ShouldBeFalse();
    }

    [Fact]
    public void A_manifest_names_ids_actions_and_hashes_and_its_receipt_counts_them_per_module()
    {
        var privacyCase = PrivacyCase.Open("PRV-2026-0004", PrivacyCaseKind.Erasure, DataSubjectKind.Contact, Guid.NewGuid(), RequestChannel.Email,
            DateTimeOffset.UtcNow, new DateOnly(2026, 11, 4), null);
        var contact = new RecordRef("customers", "Contact", privacyCase.SubjectId);
        var quote = new RecordRef("sales", "Quote", Guid.NewGuid());
        var document = new RecordRef("sales", "QuoteDocument", Guid.NewGuid());
        var plan = new List<PlannedErasure>
        {
            new(contact, ErasureAction.Pseudonymize, "customers.contact"),
            new(quote, ErasureAction.Retain, "sales.accepted-quote", RetentionBasis.Bookkeeping, new DateOnly(2031, 12, 31)),
            new(document, ErasureAction.OperatorErasure, "sales.quote-document"),
        };
        var erased = new List<ErasedRecord> { new(contact, ErasureAction.Pseudonymize, "customers.contact"), new(document, ErasureAction.OperatorErasure, "sales.quote-document") };
        var suppressions = new[] { Suppression.For(SuppressionKind.Email, "ab12", privacyCase.Id), Suppression.For(SuppressionKind.ExternalReference, "atera:Contact:7", privacyCase.Id) };

        var (json, sha) = ManifestContent.Create(Guid.NewGuid(), "0123456789abcdef", privacyCase, plan, erased, suppressions, DateTimeOffset.UtcNow);
        var parsed = ManifestContent.Parse(json).ShouldNotBeNull();

        parsed.Installation.ShouldBe("0123456789abcdef");
        parsed.Records.Select(r => r.Record).ShouldBe([contact, document]);
        parsed.Retained.ShouldHaveSingleItem().Basis.ShouldBe(RetentionBasis.Bookkeeping);
        parsed.Suppressions.Count.ShouldBe(2);
        sha.Length.ShouldBe(64);
        var receipt = ManifestContent.Receipt(parsed, sha);
        receipt.ShouldContain("\"externalSystems\":[\"atera\"]");
        receipt.ShouldContain("\"operatorErasure\":[{\"module\":\"sales\",\"entityType\":\"QuoteDocument\",\"records\":1}]");
        ManifestContent.Parse("{not json").ShouldBeNull();
    }
}
