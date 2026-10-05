using Crm.SharedKernel.Text;
using FluentValidation;

namespace Crm.Infrastructure.Http;

public static class EmailRules
{
    /// <summary>Replaces <c>EmailAddress()</c>: a null value passes (say <c>NotEmpty()</c> for a required one), a quote or a space does not.</summary>
    public static IRuleBuilderOptions<T, TProperty> StrictEmail<T, TProperty>(this IRuleBuilder<T, TProperty> rule) =>
        rule.Must(value => value is null || (value is string text && EmailAddresses.IsValid(text)))
            .WithErrorCode("EmailValidator")
            .WithMessage("'{PropertyName}' is not a valid email address.");
}
