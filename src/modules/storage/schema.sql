-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Repositories
CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL,
    owner_id TEXT,
    status TEXT DEFAULT 'pending',
    checkpoint_data JSONB DEFAULT '{}'::jsonb,
    architecture_summary TEXT,
    onboarding_guide TEXT,
    indexed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure columns exist if table was created earlier
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS owner_id TEXT;
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS checkpoint_data JSONB DEFAULT '{}'::jsonb;

-- Code Nodes (Hierarchical: functions, files, modules, directories)
CREATE TABLE IF NOT EXISTS code_nodes (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    node_type TEXT NOT NULL,
    name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    start_line INT,
    end_line INT,
    start_column INT,
    end_column INT,
    signature TEXT,
    raw_code TEXT,
    summary TEXT DEFAULT 'pending_summary',
    embedding vector(768),
    level INT DEFAULT 0,
    metadata JSONB DEFAULT '{}'::jsonb
);

ALTER TABLE code_nodes ADD COLUMN IF NOT EXISTS start_column INT;
ALTER TABLE code_nodes ADD COLUMN IF NOT EXISTS end_column INT;
ALTER TABLE code_nodes ALTER COLUMN summary DROP NOT NULL;
ALTER TABLE code_nodes ALTER COLUMN summary SET DEFAULT 'pending_summary';

-- Code Edges (calls, imports, contains, references)
CREATE TABLE IF NOT EXISTS code_edges (
    id BIGSERIAL PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    confidence TEXT DEFAULT 'EXTRACTED',
    metadata JSONB DEFAULT '{}'::jsonb,
    CONSTRAINT unique_repo_edge UNIQUE (repo_id, source_id, target_id, relation)
);

-- Git Ownership & Authorship
CREATE TABLE IF NOT EXISTS git_ownership (
    id BIGSERIAL PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES code_nodes(id) ON DELETE CASCADE,
    author_name TEXT NOT NULL,
    author_email TEXT NOT NULL,
    lines_authored INT NOT NULL,
    ownership_percentage NUMERIC(5, 2) NOT NULL,
    last_commit_date TIMESTAMPTZ,
    total_commits INT DEFAULT 1
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_code_nodes_repo ON code_nodes (repo_id);
CREATE INDEX IF NOT EXISTS idx_code_nodes_type_path ON code_nodes (repo_id, node_type, file_path);
CREATE INDEX IF NOT EXISTS idx_code_edges_source ON code_edges (source_id);
CREATE INDEX IF NOT EXISTS idx_code_edges_target ON code_edges (target_id);
CREATE INDEX IF NOT EXISTS idx_code_edges_relation ON code_edges (relation);
CREATE INDEX IF NOT EXISTS idx_git_ownership_node ON git_ownership (node_id);

-- API Keys (for CLI, CI/CD, and AI Agent Harness authentication)
CREATE TABLE IF NOT EXISTS api_keys (
    id BIGSERIAL PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_email TEXT,
    name TEXT NOT NULL DEFAULT 'Default API Key',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);
CREATE INDEX IF NOT EXISTS idx_repositories_owner ON repositories (owner_id);

-- Chat Threads (Conversations per repository)
CREATE TABLE IF NOT EXISTS chat_threads (
    id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'New Conversation',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chat Messages (Persisted turns with code citations & blast radius)
CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGSERIAL PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    referenced_nodes JSONB DEFAULT '[]'::jsonb,
    blast_radius JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_threads_repo ON chat_threads (repo_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages (thread_id);
