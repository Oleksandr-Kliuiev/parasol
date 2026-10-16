# Policy boundary

The reference gateway checks actor scope (denial → workspace SecurityAuditEvent), per-client permission and authoritative read-only tool metadata (denial → client AuditEvent) before invoking a reader, and returns ResourceView objects with explicit statuses. Implement a separate PolicyService in task 1.9 with ALLOW / REQUIRE_APPROVAL / DENY; Stage 1 allows only read tools and denies writes. AI probability is never an input that grants authority. Approval/execution lifecycle belongs to the next write slice.
