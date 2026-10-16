using FluentValidation;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace Crm.Infrastructure.Http;

/// <summary>Runs the registered FluentValidation validator for the endpoint argument of type <typeparamref name="T"/>.</summary>
public sealed class ValidationFilter<T> : IEndpointFilter
    where T : class
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var argument = context.Arguments.OfType<T>().FirstOrDefault();
        var validator = context.HttpContext.RequestServices.GetService<IValidator<T>>();
        if (argument is not null && validator is not null)
        {
            var result = await validator.ValidateAsync(argument, context.HttpContext.RequestAborted);
            if (!result.IsValid)
            {
                return result.ToValidationProblem();
            }
        }

        return await next(context);
    }
}

public static class ValidationFilterExtensions
{
    public static RouteHandlerBuilder Validate<T>(this RouteHandlerBuilder builder)
        where T : class =>
        builder.AddEndpointFilter<ValidationFilter<T>>().ProducesValidationProblem();
}

public static class HeaderExtensions
{
    /// <summary>Returns the If-Match value, or null when the header is absent.</summary>
    public static string? GetIfMatch(this HttpRequest request) =>
        request.Headers.IfMatch.Count > 0 ? request.Headers.IfMatch.ToString() : null;

    public static IResult PreconditionRequired() =>
        Results.Problem(
            detail: "Send the If-Match header with the ETag from the last read of this resource.",
            statusCode: StatusCodes.Status428PreconditionRequired,
            title: "IF_MATCH_REQUIRED",
            extensions: new Dictionary<string, object?> { ["code"] = "IF_MATCH_REQUIRED" });
}
