using Crm.SharedKernel.Results;

namespace Crm.Customers.Domain;

/// <summary>Norwegian organisasjonsnummer: 9 digits, MOD11 check digit with weights 3 2 7 6 5 4 3 2.</summary>
public static class OrgNumber
{
    private static readonly int[] Weights = [3, 2, 7, 6, 5, 4, 3, 2];

    public static Error Invalid => Error.Validation("CUS_INVALID_ORGNR", "Organization number must be 9 digits with a valid check digit.");

    public static string Normalize(string value) => new(value.Where(c => !char.IsWhiteSpace(c)).ToArray());

    public static bool IsValid(string? value)
    {
        if (value is null)
        {
            return false;
        }

        var digits = Normalize(value);
        if (digits.Length != 9 || !digits.All(char.IsAsciiDigit))
        {
            return false;
        }

        int sum = 0;
        for (int i = 0; i < 8; i++)
        {
            sum += (digits[i] - '0') * Weights[i];
        }

        int check = 11 - (sum % 11);
        if (check == 11)
        {
            check = 0;
        }

        return check != 10 && check == digits[8] - '0';
    }

    public static Result<string?> Parse(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return Result<string?>.Success(null);
        }

        return IsValid(value) ? Normalize(value) : Invalid;
    }
}
