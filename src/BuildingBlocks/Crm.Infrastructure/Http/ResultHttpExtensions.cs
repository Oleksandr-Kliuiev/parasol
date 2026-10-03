using Crm.SharedKernel.Results;
using FluentValidation.Results;
using Microsoft.AspNetCore.Http;

namespace Crm.Infrastructure.Http;

/// <summary>Maps business results to RFC 9457 problem responses with a stable <c>code</c> extension.</summary>
public static class ResultHttpExtensions
{
    public static IResult ToProblem(this Error error)
    {
        var status = error.Type switch
        {
            ErrorType.Validation => StatusCodes.Status400BadRequest,
            ErrorType.NotFound => StatusCodes.Status404NotFound,
            ErrorType.Conflict => StatusCodes.Status409Conflict,
            ErrorType.Forbidden => StatusCodes.Status403Forbidden,
            ErrorType.PreconditionFailed => StatusCodes.Status412PreconditionFailed,
            _ => StatusCodes.Status500InternalServerError,
        };

        var extensions = new Dictionary<string, object?> { ["code"] = error.Code };
        if (error.Metadata is not null)
        {
            foreach (var (key, value) in error.Metadata)
            {
                extensions[key] = value;
            }
        }

        return Results.Problem(detail: error.Message, statusCode: status, title: error.Code, extensions: extensions);
    }

    public static IResult ToValidationProblem(this ValidationResult validation) =>
        Results.ValidationProblem(
            validation.ToDictionary(),
            title: "VALIDATION_FAILED",
            extensions: new Dictionary<string, object?> { ["code"] = "VALIDATION_FAILED" });

    public static IResult ToHttpResult<T>(this Result<T> result, Func<T, IResult> onSuccess) =>
        result.IsSuccess ? onSuccess(result.Value) : result.Error!.ToProblem();

    public static IResult ToHttpResult(this Result result, Func<IResult> onSuccess) =>
        result.IsSuccess ? onSuccess() : result.Error!.ToProblem();
}
