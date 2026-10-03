namespace Crm.SharedKernel.Results;

public enum ErrorType
{
    Validation,
    NotFound,
    Conflict,
    Forbidden,
    PreconditionFailed,
    Failure,
}

/// <summary>Business error with a stable machine-readable code, e.g. <c>CUS_DUPLICATE_ORGNR</c>.</summary>
public sealed record Error(string Code, string Message, ErrorType Type, IReadOnlyDictionary<string, object?>? Metadata = null)
{
    public static Error Validation(string code, string message, IReadOnlyDictionary<string, object?>? metadata = null) =>
        new(code, message, ErrorType.Validation, metadata);

    public static Error NotFound(string code, string message) => new(code, message, ErrorType.NotFound);

    public static Error Conflict(string code, string message, IReadOnlyDictionary<string, object?>? metadata = null) =>
        new(code, message, ErrorType.Conflict, metadata);

    public static Error PreconditionFailed(string code, string message) => new(code, message, ErrorType.PreconditionFailed);
}

public class Result
{
    protected Result(Error? error) => Error = error;

    public Error? Error { get; }

    public bool IsSuccess => Error is null;

    public static Result Success() => new(null);

    public static Result Failure(Error error) => new(error);

    public static implicit operator Result(Error error) => Failure(error);
}

public sealed class Result<T> : Result
{
    private readonly T? _value;

    private Result(T value) : base(null) => _value = value;

    private Result(Error error) : base(error) { }

    public T Value => IsSuccess
        ? _value!
        : throw new InvalidOperationException($"Cannot read the value of a failed result ({Error!.Code}).");

    public static Result<T> Success(T value) => new(value);

    public static new Result<T> Failure(Error error) => new(error);

    public static implicit operator Result<T>(T value) => new(value);

    public static implicit operator Result<T>(Error error) => new(error);
}
