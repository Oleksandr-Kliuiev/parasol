using Crm.Identity;
using Crm.Identity.Domain;
using Crm.Identity.Features;

namespace Crm.UnitTests;

/// <summary>M38: every employee has every permission, so My day is laid out by the person's own choice, not by their role.</summary>
public sealed class MyDayLayoutTests
{
    [Theory]
    [InlineData("work")]
    [InlineData("lead")]
    [InlineData("finance")]
    public void The_three_layouts_are_accepted(string layout) =>
        new MyDayLayoutRequestValidator().Validate(new MyDayLayoutRequest(layout)).IsValid.ShouldBeTrue();

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData(" work")]
    [InlineData("Work")]
    [InlineData("admin")]
    [InlineData("finance,work")]
    public void Anything_else_is_refused_with_the_supported_names(string? layout)
    {
        var result = new MyDayLayoutRequestValidator().Validate(new MyDayLayoutRequest(layout));

        result.IsValid.ShouldBeFalse();
        result.Errors.Single().ErrorMessage.ShouldBe("Supported layouts: work, lead, finance.");
    }

    [Fact]
    public void A_new_user_has_no_choice_and_the_profile_carries_the_one_made()
    {
        var user = User.Create("tenant", "oid");
        user.MyDayLayout.ShouldBeNull();
        user.ToProfile().MyDayLayout.ShouldBeNull();

        user.SetMyDayLayout("finance");

        user.ToProfile().MyDayLayout.ShouldBe("finance");
        user.PreferredLanguage.ShouldBeNull("the layout is saved apart from the language");
    }
}
