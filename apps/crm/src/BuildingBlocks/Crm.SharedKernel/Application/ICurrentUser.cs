namespace Crm.SharedKernel.Application;

public interface ICurrentUser
{
    /// <summary>Internal CRM user id; null for background jobs and anonymous calls.</summary>
    Guid? UserId { get; }

    string DisplayName { get; }

    bool IsAuthenticated { get; }

    bool HasPermission(string permission);
}

public interface ICommandHandler<in TCommand, TResult>
{
    Task<TResult> HandleAsync(TCommand command, CancellationToken cancellationToken);
}

public interface IQueryHandler<in TQuery, TResult>
{
    Task<TResult> HandleAsync(TQuery query, CancellationToken cancellationToken);
}
