import {
  pgTable,
  text,
  timestamp,
  integer,
  numeric,
  jsonb,
  bigserial,
  unique,
  index,
  vector
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ---------------------------------------------------------------------------
// 1. Repositories
// ---------------------------------------------------------------------------
export const repositories = pgTable(
  "repositories",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    rootPath: text("root_path").notNull(),
    ownerId: text("owner_id"),
    status: text("status").default("pending"),
    checkpointData: jsonb("checkpoint_data").default({}),
    architectureSummary: text("architecture_summary"),
    onboardingGuide: text("onboarding_guide"),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).defaultNow()
  },
  (table) => [
    index("idx_repositories_owner").on(table.ownerId)
  ]
);

// ---------------------------------------------------------------------------
// 2. Code Nodes (Hierarchical: functions, files, modules, directories)
// ---------------------------------------------------------------------------
export const codeNodes = pgTable(
  "code_nodes",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    nodeType: text("node_type").notNull(),
    name: text("name").notNull(),
    filePath: text("file_path").notNull(),
    startLine: integer("start_line"),
    endLine: integer("end_line"),
    startColumn: integer("start_column"),
    endColumn: integer("end_column"),
    signature: text("signature"),
    rawCode: text("raw_code"),
    summary: text("summary").default("pending_summary"),
    embedding: vector("embedding", { dimensions: 768 }),
    level: integer("level").default(0),
    metadata: jsonb("metadata").default({})
  },
  (table) => [
    index("idx_code_nodes_repo").on(table.repoId),
    index("idx_code_nodes_type_path").on(table.repoId, table.nodeType, table.filePath)
  ]
);

// ---------------------------------------------------------------------------
// 3. Code Edges (calls, imports, contains, references)
// ---------------------------------------------------------------------------
export const codeEdges = pgTable(
  "code_edges",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => codeNodes.id, { onDelete: "cascade" }),
    targetId: text("target_id")
      .notNull()
      .references(() => codeNodes.id, { onDelete: "cascade" }),
    relation: text("relation").notNull(),
    confidence: text("confidence").default("EXTRACTED"),
    metadata: jsonb("metadata").default({})
  },
  (table) => [
    unique("unique_repo_edge").on(table.repoId, table.sourceId, table.targetId, table.relation),
    index("idx_code_edges_source").on(table.sourceId),
    index("idx_code_edges_target").on(table.targetId),
    index("idx_code_edges_relation").on(table.relation)
  ]
);

// ---------------------------------------------------------------------------
// 4. Git Ownership & Authorship
// ---------------------------------------------------------------------------
export const gitOwnership = pgTable(
  "git_ownership",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    nodeId: text("node_id")
      .notNull()
      .references(() => codeNodes.id, { onDelete: "cascade" }),
    authorName: text("author_name").notNull(),
    authorEmail: text("author_email").notNull(),
    linesAuthored: integer("lines_authored").notNull(),
    ownershipPercentage: numeric("ownership_percentage", { precision: 5, scale: 2 }).notNull(),
    lastCommitDate: timestamp("last_commit_date", { withTimezone: true }),
    totalCommits: integer("total_commits").default(1)
  },
  (table) => [
    index("idx_git_ownership_node").on(table.nodeId)
  ]
);

// ---------------------------------------------------------------------------
// 5. API Keys (for CLI, CI/CD, and AI Agent Harness authentication)
// ---------------------------------------------------------------------------
export const apiKeys = pgTable(
  "api_keys",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    keyHash: text("key_hash").notNull().unique(),
    keyPrefix: text("key_prefix").notNull(),
    userId: text("user_id").notNull(),
    userEmail: text("user_email"),
    name: text("name").notNull().default("Default API Key"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true })
  },
  (table) => [
    index("idx_api_keys_hash").on(table.keyHash),
    index("idx_api_keys_user").on(table.userId)
  ]
);

// ---------------------------------------------------------------------------
// 6. Chat Threads (Conversations per repository)
// ---------------------------------------------------------------------------
export const chatThreads = pgTable(
  "chat_threads",
  {
    id: text("id").primaryKey(),
    repoId: text("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New Conversation"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow()
  },
  (table) => [
    index("idx_chat_threads_repo").on(table.repoId)
  ]
);

// ---------------------------------------------------------------------------
// 7. Chat Messages (Persisted turns with code citations & blast radius)
// ---------------------------------------------------------------------------
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // 'user' | 'assistant'
    content: text("content").notNull(),
    referencedNodes: jsonb("referenced_nodes").default([]),
    blastRadius: jsonb("blast_radius").default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow()
  },
  (table) => [
    index("idx_chat_messages_thread").on(table.threadId)
  ]
);

// ---------------------------------------------------------------------------
// Relational Definitions (Drizzle Queries)
// ---------------------------------------------------------------------------
export const repositoriesRelations = relations(repositories, ({ many }) => ({
  nodes: many(codeNodes),
  edges: many(codeEdges),
  ownerships: many(gitOwnership),
  threads: many(chatThreads)
}));

export const codeNodesRelations = relations(codeNodes, ({ one, many }) => ({
  repository: one(repositories, {
    fields: [codeNodes.repoId],
    references: [repositories.id]
  }),
  outgoingEdges: many(codeEdges, { relationName: "sourceEdges" }),
  incomingEdges: many(codeEdges, { relationName: "targetEdges" }),
  ownerships: many(gitOwnership)
}));

export const codeEdgesRelations = relations(codeEdges, ({ one }) => ({
  repository: one(repositories, {
    fields: [codeEdges.repoId],
    references: [repositories.id]
  }),
  sourceNode: one(codeNodes, {
    fields: [codeEdges.sourceId],
    references: [codeNodes.id],
    relationName: "sourceEdges"
  }),
  targetNode: one(codeNodes, {
    fields: [codeEdges.targetId],
    references: [codeNodes.id],
    relationName: "targetEdges"
  })
}));

export const gitOwnershipRelations = relations(gitOwnership, ({ one }) => ({
  repository: one(repositories, {
    fields: [gitOwnership.repoId],
    references: [repositories.id]
  }),
  node: one(codeNodes, {
    fields: [gitOwnership.nodeId],
    references: [codeNodes.id]
  })
}));

export const chatThreadsRelations = relations(chatThreads, ({ one, many }) => ({
  repository: one(repositories, {
    fields: [chatThreads.repoId],
    references: [repositories.id]
  }),
  messages: many(chatMessages)
}));

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  thread: one(chatThreads, {
    fields: [chatMessages.threadId],
    references: [chatThreads.id]
  })
}));

// ---------------------------------------------------------------------------
// Inferred TypeScript Types
// ---------------------------------------------------------------------------
export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;

export type CodeNode = typeof codeNodes.$inferSelect;
export type NewCodeNode = typeof codeNodes.$inferInsert;

export type CodeEdge = typeof codeEdges.$inferSelect;
export type NewCodeEdge = typeof codeEdges.$inferInsert;

export type GitOwnership = typeof gitOwnership.$inferSelect;
export type NewGitOwnership = typeof gitOwnership.$inferInsert;

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;

export type ChatThread = typeof chatThreads.$inferSelect;
export type NewChatThread = typeof chatThreads.$inferInsert;

export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
