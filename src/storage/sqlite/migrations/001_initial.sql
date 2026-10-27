PRAGMA foreign_keys = ON;

-- Repositories: exactly one row per local DB.
CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL,
    owner_id TEXT,                                   -- NULL locally
    status TEXT DEFAULT 'pending',
    checkpoint_data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(checkpoint_data)),
    architecture_summary TEXT,                       -- repo-level summary lives here, as in the web app
    onboarding_guide TEXT,
    indexed_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Code nodes: hierarchical (functions, files, modules, directories), as in the web app.
CREATE TABLE IF NOT EXISTS code_nodes (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    node_type TEXT NOT NULL,
    name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    start_line INTEGER,
    end_line INTEGER,
    start_column INTEGER,
    end_column INTEGER,
    signature TEXT,
    raw_code TEXT,                                   -- kept for parity; NOT populated by default
    summary TEXT DEFAULT 'pending_summary',
    level INTEGER DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),

    -- CLI additions (Section 3.4)
    display_id TEXT,                                 -- legacy coordinate-based id
    source_hash TEXT,                                -- symbols: sha256 of symbol source; files: sha256 of file bytes
    scc_id INTEGER,                                  -- Tarjan component; NULL until computed
    summary_status TEXT NOT NULL DEFAULT 'missing',  -- missing|fresh|stale|possibly_stale|heuristic
    summary_input_hash TEXT,                         -- hash of everything that produced the summary
    summary_content_hash TEXT                        -- sha256 of summary text
);

-- Code edges: only resolved edges (target_id NOT NULL), as in the web app.
CREATE TABLE IF NOT EXISTS code_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,                          -- calls | imports | contains | references
    confidence TEXT DEFAULT 'EXTRACTED',             -- 'EXTRACTED' | 'INFERRED'
    metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
    CONSTRAINT unique_repo_edge UNIQUE (repo_id, source_id, target_id, relation)
);

-- Git ownership: identical to the web app.
CREATE TABLE IF NOT EXISTS git_ownership (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
    author_name TEXT NOT NULL,
    author_email TEXT NOT NULL,
    lines_authored INTEGER NOT NULL,
    ownership_percentage REAL NOT NULL,
    last_commit_date TEXT,
    total_commits INTEGER DEFAULT 1
);

-- Indexes (matching web schema names where they exist)
CREATE INDEX IF NOT EXISTS idx_code_nodes_repo ON code_nodes (repo_id);
CREATE INDEX IF NOT EXISTS idx_code_nodes_type_path ON code_nodes (repo_id, node_type, file_path);
CREATE INDEX IF NOT EXISTS idx_code_edges_source ON code_edges (source_id);
CREATE INDEX IF NOT EXISTS idx_code_edges_target ON code_edges (target_id);
CREATE INDEX IF NOT EXISTS idx_code_edges_relation ON code_edges (relation);
CREATE INDEX IF NOT EXISTS idx_git_ownership_node ON git_ownership (node_id);
CREATE INDEX IF NOT EXISTS idx_repositories_owner ON repositories (owner_id);

-- CLI-addition indexes
CREATE INDEX IF NOT EXISTS idx_code_nodes_name ON code_nodes (name);
CREATE INDEX IF NOT EXISTS idx_code_nodes_scc ON code_nodes (scc_id);
CREATE INDEX IF NOT EXISTS idx_code_nodes_summary_status ON code_nodes (summary_status);
CREATE INDEX IF NOT EXISTS idx_code_nodes_qname ON code_nodes (json_extract(metadata, '$.qualified_name'));

-- Metadata key/value store
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Unresolved references
CREATE TABLE IF NOT EXISTS unresolved_refs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  source_id   TEXT NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
  target_name TEXT NOT NULL,
  relation    TEXT NOT NULL,
  confidence  TEXT DEFAULT 'INFERRED',
  line        INTEGER,
  UNIQUE (source_id, target_name, relation)
);
CREATE INDEX IF NOT EXISTS idx_unresolved_name ON unresolved_refs (target_name);

-- Pipeline jobs
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,              -- index|summarize|embed
  status      TEXT NOT NULL,              -- running|completed|failed|interrupted
  params_json TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  tokens_in   INTEGER DEFAULT 0,
  tokens_out  INTEGER DEFAULT 0,
  error       TEXT
);

-- Full-text search over node names, signatures, doc comments and summaries
CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
  node_id UNINDEXED, name, body,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '_'"
);

-- Node embeddings metadata (for Phase 4)
CREATE TABLE IF NOT EXISTS node_embeddings (
  node_id    TEXT PRIMARY KEY REFERENCES code_nodes(id) ON DELETE CASCADE,
  vec_rowid  INTEGER NOT NULL UNIQUE,
  input_hash TEXT NOT NULL,
  model      TEXT NOT NULL,
  dims       INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
