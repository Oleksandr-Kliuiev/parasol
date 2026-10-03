namespace Crm.SharedKernel.Domain;

public abstract class Entity
{
    private readonly List<IDomainEvent> _domainEvents = [];

    protected Entity() => Id = SequentialId.New();

    protected Entity(Guid id) => Id = id;

    public Guid Id { get; protected init; }

    public IReadOnlyCollection<IDomainEvent> DomainEvents => _domainEvents;

    protected void Raise(IDomainEvent domainEvent) => _domainEvents.Add(domainEvent);

    public void ClearDomainEvents() => _domainEvents.Clear();
}

/// <summary>Filled by the persistence layer on save.</summary>
public interface IAuditable
{
    DateTimeOffset CreatedAt { get; }
    Guid? CreatedBy { get; }
    DateTimeOffset? ModifiedAt { get; }
    Guid? ModifiedBy { get; }
}

public interface ISoftDeletable
{
    bool IsDeleted { get; }
    void MarkDeleted();
}

public abstract class AuditableEntity : Entity, IAuditable, ISoftDeletable
{
    protected AuditableEntity() { }

    protected AuditableEntity(Guid id) : base(id) { }

    public DateTimeOffset CreatedAt { get; private set; }
    public Guid? CreatedBy { get; private set; }
    public DateTimeOffset? ModifiedAt { get; private set; }
    public Guid? ModifiedBy { get; private set; }
    public bool IsDeleted { get; private set; }

    public virtual void MarkDeleted() => IsDeleted = true;

    public virtual void Restore() => IsDeleted = false;
}
