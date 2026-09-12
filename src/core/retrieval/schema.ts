/** Rebuildable projections only. No foreign keys into authoritative SAM source tables. */
export const RETRIEVAL_SCHEMA = [
  `CREATE TABLE retrieval_lab_sources (id TEXT PRIMARY KEY NOT NULL, item_json TEXT NOT NULL)`,
  `CREATE TABLE retrieval_items (
    id TEXT PRIMARY KEY NOT NULL,
    namespace TEXT NOT NULL, type TEXT NOT NULL,
    source_system TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
    content TEXT NOT NULL, content_hash TEXT NOT NULL, revision TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL,
    scope_kind TEXT NOT NULL, scope_key TEXT NOT NULL, metadata_json TEXT,
    projection_version INTEGER NOT NULL, schema_version INTEGER NOT NULL,
    lexical_state TEXT NOT NULL CHECK(lexical_state IN ('pending','ready','failed')),
    vector_state TEXT NOT NULL CHECK(vector_state IN ('pending','ready','stale','failed')),
    fingerprint_json TEXT, failure_json TEXT,
    UNIQUE(namespace, type, source_system, source_type, source_id)
  )`,
  `CREATE TABLE retrieval_vectors (
    id TEXT PRIMARY KEY NOT NULL REFERENCES retrieval_items(id) ON DELETE CASCADE,
    revision TEXT NOT NULL, fingerprint TEXT NOT NULL, dimensions INTEGER NOT NULL,
    data BLOB NOT NULL CHECK(length(data) = dimensions * 4)
  )`,
  `CREATE INDEX idx_retrieval_scope ON retrieval_items(scope_kind, scope_key, namespace, type)`,
  `CREATE INDEX idx_retrieval_source ON retrieval_items(source_system, source_type, source_id)`,
  `CREATE INDEX idx_retrieval_work ON retrieval_items(vector_state, lexical_state, indexed_at)`,
  `CREATE INDEX idx_retrieval_dates ON retrieval_items(created_at, updated_at)`,
  `CREATE INDEX idx_retrieval_fingerprint ON retrieval_vectors(fingerprint, id)`,
  // Capability-dependent FTS DDL is installed transactionally by SqliteRetrievalStore.
  `CREATE TABLE retrieval_backend (id INTEGER PRIMARY KEY CHECK(id=1), lexical TEXT NOT NULL, version INTEGER NOT NULL)`,
];
