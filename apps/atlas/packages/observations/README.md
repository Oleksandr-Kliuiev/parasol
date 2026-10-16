# Observation persistence

Task 1.8 replaces the reference pipeline's in-memory map with scoped PostgreSQL repositories. Persist entityId, the applied decisionRunId, domain, priority, severityRank, reasonCodes and provenance; atomically create observation/audit/event completion; order context by (severityRank DESC, createdAt DESC, id) with counts over the whole OPEN set and a truncated flag. See docs/02_DATA_AND_MODULES.md, docs/03_CONNECTORS_AND_SYNC.md and docs/06_ACCEPTANCE.md.
