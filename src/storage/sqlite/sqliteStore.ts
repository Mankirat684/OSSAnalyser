import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import type {
  GraphStore,
  RepoRecord,
  NodeRecord,
  EdgeRecord,
  UnresolvedRefRecord,
  GitOwnershipRecord,
  BlastRadiusItem,
  EdgeHop,
  FtsSearchResult,
  SummaryStatus
} from "../graphStore.js";

import { runMigrations } from "./migrator.js";

// ---------------------------------------------------------------------------
// CJS interop: better-sqlite3 and sqlite-vec are CommonJS packages
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

/**
 * Splits camelCase and snake_case tokens for full-text search indexing.
 * e.g., 'initDB' -> 'initDB init db', 'user_id' -> 'user_id user id'
 */
function tokenizeIdentifier(name: string): string {
  const splits = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .toLowerCase();
  return `${name} ${splits}`;
}


export class SQLiteStore implements GraphStore {
  private db: import("better-sqlite3").Database;
  private dbPath: string;
  private vecAvailable = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
  }

  public async init(): Promise<void> {
    // 1. Pragmas for high performance and integrity
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");

    // 2. Try to load sqlite-vec for persistent ANN search
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqliteVec = require("sqlite-vec") as { load: (db: import("better-sqlite3").Database) => void };
      sqliteVec.load(this.db);
      this.vecAvailable = true;
    } catch {
      // sqlite-vec unavailable on this platform — doctor will report this
      this.vecAvailable = false;
    }

    // 3. Run versioned migrations (tracks PRAGMA user_version)
    runMigrations(this.db);

    // 4. Create vec_nodes virtual table if sqlite-vec is available
    if (this.vecAvailable) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_nodes USING vec0(
          node_id TEXT PRIMARY KEY,
          embedding FLOAT[768]
        );
      `);
    }
  }

  /** Whether sqlite-vec loaded successfully. Used by doctor command. */
  public isVecAvailable(): boolean {
    return this.vecAvailable;
  }

  /** Current schema migration version from PRAGMA user_version. */
  public getSchemaVersion(): number {
    return (this.db.pragma("user_version", { simple: true }) as number) || 0;
  }

  public async close(): Promise<void> {
    this.db.close();
  }

  // =========================================================================
  // Repository
  // =========================================================================

  public async saveRepository(repo: RepoRecord): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO repositories (id, name, root_path, owner_id, status, checkpoint_data, architecture_summary, onboarding_guide, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name,
        root_path = excluded.root_path,
        owner_id = excluded.owner_id,
        status = excluded.status,
        checkpoint_data = excluded.checkpoint_data,
        architecture_summary = excluded.architecture_summary,
        onboarding_guide = excluded.onboarding_guide,
        indexed_at = excluded.indexed_at
    `);

    stmt.run(
      repo.id,
      repo.name,
      repo.rootPath,
      repo.ownerId ?? null,
      repo.status,
      JSON.stringify(repo.checkpointData ?? {}),
      repo.architectureSummary ?? null,
      repo.onboardingGuide ?? null,
      repo.indexedAt ?? new Date().toISOString()
    );
  }

  public async getRepository(repoId: string): Promise<RepoRecord | null> {
    const stmt = this.db.prepare(`SELECT * FROM repositories WHERE id = ?`);
    const row = stmt.get(repoId) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      id: row.id as string,
      name: row.name as string,
      rootPath: row.root_path as string,
      ownerId: row.owner_id as string | undefined,
      status: row.status as string,
      checkpointData: JSON.parse((row.checkpoint_data as string) || "{}"),
      architectureSummary: row.architecture_summary as string | undefined,
      onboardingGuide: row.onboarding_guide as string | undefined,
      indexedAt: row.indexed_at as string | undefined
    };
  }

  public async getFirstRepository(): Promise<RepoRecord | null> {
    const stmt = this.db.prepare(`SELECT * FROM repositories LIMIT 1`);
    const row = stmt.get() as Record<string, unknown> | undefined;
    if (!row) {
      const nodeRow = this.db.prepare(`SELECT repo_id FROM code_nodes LIMIT 1`).get() as { repo_id: string } | undefined;
      if (nodeRow?.repo_id) {
        return {
          id: nodeRow.repo_id,
          name: nodeRow.repo_id.replace(/^repo_/, ""),
          rootPath: "",
          status: "indexed"
        };
      }
      return null;
    }

    return {
      id: row.id as string,
      name: row.name as string,
      rootPath: row.root_path as string,
      ownerId: row.owner_id as string | undefined,
      status: row.status as string,
      checkpointData: JSON.parse((row.checkpoint_data as string) || "{}"),
      architectureSummary: row.architecture_summary as string | undefined,
      onboardingGuide: row.onboarding_guide as string | undefined,
      indexedAt: row.indexed_at as string | undefined
    };
  }

  // =========================================================================
  // Nodes (Cascade-Safe Upsert & Remove)
  // =========================================================================

  public async upsertNodes(nodes: NodeRecord[]): Promise<void> {
    if (nodes.length === 0) return;

    const upsertMany = this.db.transaction((nodes: NodeRecord[]) => {
      const nodeStmt = this.db.prepare(`
        INSERT INTO code_nodes (
          id, repo_id, node_type, name, file_path, start_line, end_line, start_column, end_column,
          signature, raw_code, summary, level, metadata,
          display_id, source_hash, scc_id, summary_status, summary_input_hash, summary_content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          repo_id = excluded.repo_id,
          node_type = excluded.node_type,
          name = excluded.name,
          file_path = excluded.file_path,
          start_line = excluded.start_line,
          end_line = excluded.end_line,
          start_column = excluded.start_column,
          end_column = excluded.end_column,
          signature = excluded.signature,
          raw_code = excluded.raw_code,
          summary = excluded.summary,
          level = excluded.level,
          metadata = excluded.metadata,
          display_id = excluded.display_id,
          source_hash = excluded.source_hash,
          scc_id = excluded.scc_id,
          summary_status = excluded.summary_status,
          summary_input_hash = excluded.summary_input_hash,
          summary_content_hash = excluded.summary_content_hash
      `);

      const ftsDeleteStmt = this.db.prepare(`DELETE FROM node_fts WHERE node_id = ?`);
      const ftsInsertStmt = this.db.prepare(`INSERT INTO node_fts (node_id, name, body) VALUES (?, ?, ?)`);

      for (const node of nodes) {
        nodeStmt.run(
          node.id,
          node.repoId,
          node.nodeType,
          node.name,
          node.filePath,
          node.startLine ?? null,
          node.endLine ?? null,
          node.startColumn ?? null,
          node.endColumn ?? null,
          node.signature ?? null,
          node.rawCode ?? null,
          node.summary ?? "pending_summary",
          node.level ?? 0,
          JSON.stringify(node.metadata ?? {}),
          node.displayId ?? null,
          node.sourceHash ?? null,
          node.sccId ?? null,
          node.summaryStatus ?? "missing",
          node.summaryInputHash ?? null,
          node.summaryContentHash ?? null
        );

        // Sync FTS
        ftsDeleteStmt.run(node.id);
        const docComment = (node.metadata as Record<string, string>)?.doc_comment || "";
        const bodyContent = `${tokenizeIdentifier(node.name)} ${node.signature || ""} ${docComment} ${node.summary && node.summary !== "pending_summary" ? node.summary : ""}`.trim();
        ftsInsertStmt.run(node.id, node.name, bodyContent);
      }
    });

    upsertMany(nodes);
  }

  public async deleteNodes(nodeIds: string[]): Promise<void> {
    if (nodeIds.length === 0) return;

    const deleteMany = this.db.transaction((ids: string[]) => {
      const deleteStmt = this.db.prepare(`DELETE FROM code_nodes WHERE id = ?`);
      const deleteFtsStmt = this.db.prepare(`DELETE FROM node_fts WHERE node_id = ?`);
      for (const id of ids) {
        deleteStmt.run(id);
        deleteFtsStmt.run(id);
      }
    });

    deleteMany(nodeIds);
  }

  // =========================================================================
  // Edges
  // =========================================================================

  public async upsertEdges(edges: EdgeRecord[]): Promise<void> {
    if (edges.length === 0) return;

    const upsertMany = this.db.transaction((edges: EdgeRecord[]) => {
      const stmt = this.db.prepare(`
        INSERT INTO code_edges (repo_id, source_id, target_id, relation, confidence, metadata)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (repo_id, source_id, target_id, relation) DO UPDATE SET
          confidence = excluded.confidence,
          metadata = excluded.metadata
      `);
      for (const e of edges) {
        stmt.run(
          e.repoId,
          e.sourceId,
          e.targetId,
          e.relation,
          e.confidence ?? "EXTRACTED",
          JSON.stringify(e.metadata ?? {})
        );
      }
    });

    upsertMany(edges);
  }

  public async deleteOutgoingEdges(sourceIds: string[]): Promise<void> {
    if (sourceIds.length === 0) return;

    const deleteMany = this.db.transaction((ids: string[]) => {
      const stmt = this.db.prepare(`DELETE FROM code_edges WHERE source_id = ?`);
      for (const id of ids) stmt.run(id);
    });

    deleteMany(sourceIds);
  }

  // =========================================================================
  // Unresolved References
  // =========================================================================

  public async saveUnresolvedRefs(refs: UnresolvedRefRecord[]): Promise<void> {
    if (refs.length === 0) return;

    const saveMany = this.db.transaction((refs: UnresolvedRefRecord[]) => {
      const stmt = this.db.prepare(`
        INSERT INTO unresolved_refs (repo_id, source_id, target_name, relation, confidence, line)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (source_id, target_name, relation) DO UPDATE SET
          confidence = excluded.confidence,
          line = excluded.line
      `);
      for (const r of refs) {
        stmt.run(
          r.repoId,
          r.sourceId,
          r.targetName,
          r.relation,
          r.confidence ?? "INFERRED",
          r.line ?? null
        );
      }
    });

    saveMany(refs);
  }

  public async getUnresolvedRefs(repoId: string): Promise<UnresolvedRefRecord[]> {
    const stmt = this.db.prepare(`SELECT * FROM unresolved_refs WHERE repo_id = ?`);
    const rows = stmt.all(repoId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      repoId: r.repo_id as string,
      sourceId: r.source_id as string,
      targetName: r.target_name as string,
      relation: r.relation as string,
      confidence: r.confidence as "EXTRACTED" | "INFERRED",
      line: r.line as number | undefined
    }));
  }

  public async deleteUnresolvedRefsForSources(sourceIds: string[]): Promise<void> {
    if (sourceIds.length === 0) return;

    const deleteMany = this.db.transaction((ids: string[]) => {
      const stmt = this.db.prepare(`DELETE FROM unresolved_refs WHERE source_id = ?`);
      for (const id of ids) stmt.run(id);
    });

    deleteMany(sourceIds);
  }

  // =========================================================================
  // Git Ownership
  // =========================================================================

  public async saveOwnership(ownership: GitOwnershipRecord[]): Promise<void> {
    if (ownership.length === 0) return;

    const saveMany = this.db.transaction((ownership: GitOwnershipRecord[]) => {
      const delStmt = this.db.prepare(`DELETE FROM git_ownership WHERE node_id = ?`);
      const insertStmt = this.db.prepare(`
        INSERT INTO git_ownership (repo_id, node_id, author_name, author_email, lines_authored, ownership_percentage, last_commit_date, total_commits)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const seenNodeIds = new Set<string>();
      for (const o of ownership) {
        if (!seenNodeIds.has(o.nodeId)) {
          delStmt.run(o.nodeId);
          seenNodeIds.add(o.nodeId);
        }
        insertStmt.run(
          o.repoId,
          o.nodeId,
          o.authorName,
          o.authorEmail,
          o.linesAuthored,
          Math.round(o.ownershipPercentage * 100) / 100,
          o.lastCommitDate ?? null,
          o.totalCommits ?? 1
        );
      }
    });

    saveMany(ownership);
  }

  public async getOwnership(nodeId: string): Promise<GitOwnershipRecord[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM git_ownership WHERE node_id = ? ORDER BY ownership_percentage DESC
    `);
    const rows = stmt.all(nodeId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      repoId: r.repo_id as string,
      nodeId: r.node_id as string,
      authorName: r.author_name as string,
      authorEmail: r.author_email as string,
      linesAuthored: r.lines_authored as number,
      ownershipPercentage: r.ownership_percentage as number,
      lastCommitDate: r.last_commit_date as string | undefined,
      totalCommits: r.total_commits as number
    }));
  }

  // =========================================================================
  // Queries
  // =========================================================================

  public async getNode(idOrName: string): Promise<NodeRecord | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM code_nodes WHERE id = ? OR name = ? OR json_extract(metadata, '$.qualified_name') = ? LIMIT 1
    `);
    const r = stmt.get(idOrName, idOrName, idOrName) as Record<string, unknown> | undefined;
    if (!r) return null;
    return this.mapNodeRow(r);
  }

  public async getNodesByFilePath(filePath: string): Promise<NodeRecord[]> {
    const stmt = this.db.prepare(`SELECT * FROM code_nodes WHERE file_path = ?`);
    const rows = stmt.all(filePath) as Record<string, unknown>[];
    return rows.map((r) => this.mapNodeRow(r));
  }

  public async getAllNodes(repoId?: string, nodeType?: string): Promise<NodeRecord[]> {
    if (repoId) {
      if (nodeType) {
        const stmt = this.db.prepare(`SELECT * FROM code_nodes WHERE repo_id = ? AND node_type = ?`);
        const rows = (stmt.all(repoId, nodeType) as Record<string, unknown>[]).map((r) => this.mapNodeRow(r));
        if (rows.length > 0) return rows;
      } else {
        const stmt = this.db.prepare(`SELECT * FROM code_nodes WHERE repo_id = ?`);
        const rows = (stmt.all(repoId) as Record<string, unknown>[]).map((r) => this.mapNodeRow(r));
        if (rows.length > 0) return rows;
      }
    }
    // Fallback if repoId was omitted or did not match (e.g. folder renamed)
    if (nodeType) {
      const stmt = this.db.prepare(`SELECT * FROM code_nodes WHERE node_type = ?`);
      return (stmt.all(nodeType) as Record<string, unknown>[]).map((r) => this.mapNodeRow(r));
    }
    const stmt = this.db.prepare(`SELECT * FROM code_nodes`);
    return (stmt.all() as Record<string, unknown>[]).map((r) => this.mapNodeRow(r));
  }

  public async searchNodesFts(query: string, limit = 25): Promise<FtsSearchResult[]> {
    // Sanitize query for FTS5 (avoid syntax errors with special chars)
    const sanitized = query.replace(/[^a-zA-Z0-9_\s]/g, " ").trim();
    if (!sanitized) return [];

    const ftsQuery = sanitized.split(/\s+/).filter(Boolean).map((t) => `"${t}"*`).join(" OR ");
    if (!ftsQuery) return [];

    const stmt = this.db.prepare(`
      SELECT f.node_id, f.name, n.file_path, n.node_type, n.signature, n.summary, bm25(node_fts) AS rank
      FROM node_fts f
      JOIN code_nodes n ON n.id = f.node_id
      WHERE node_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    try {
      const rows = stmt.all(ftsQuery, limit) as Record<string, unknown>[];
      return rows.map((r) => ({
        nodeId: r.node_id as string,
        name: r.name as string,
        filePath: r.file_path as string,
        nodeType: r.node_type as string,
        signature: r.signature as string | undefined,
        summary: r.summary as string | undefined,
        rank: r.rank as number
      }));
    } catch {
      return [];
    }
  }

  public async getCallers(nodeId: string, depth = 1, includeInferred = false): Promise<EdgeHop[]> {
    const confCondition = includeInferred ? "" : "AND e.confidence = 'EXTRACTED'";
    const stmt = this.db.prepare(`
      SELECT n.id, n.name, n.file_path, n.node_type, e.relation, e.confidence, json_extract(e.metadata, '$.lines[0]') as line
      FROM code_edges e
      JOIN code_nodes n ON n.id = e.source_id
      WHERE e.target_id = ? AND e.relation = 'calls' ${confCondition}
    `);
    const rows = stmt.all(nodeId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      filePath: r.file_path as string,
      nodeType: r.node_type as string,
      relation: r.relation as string,
      confidence: r.confidence as "EXTRACTED" | "INFERRED",
      line: r.line as number | undefined
    }));
  }

  public async getDependencies(nodeId: string, depth = 1, includeInferred = false): Promise<EdgeHop[]> {
    const confCondition = includeInferred ? "" : "AND e.confidence = 'EXTRACTED'";
    const stmt = this.db.prepare(`
      SELECT n.id, n.name, n.file_path, n.node_type, e.relation, e.confidence, json_extract(e.metadata, '$.lines[0]') as line
      FROM code_edges e
      JOIN code_nodes n ON n.id = e.target_id
      WHERE e.source_id = ? AND e.relation IN ('calls', 'imports', 'references') ${confCondition}
    `);
    const rows = stmt.all(nodeId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      filePath: r.file_path as string,
      nodeType: r.node_type as string,
      relation: r.relation as string,
      confidence: r.confidence as "EXTRACTED" | "INFERRED",
      line: r.line as number | undefined
    }));
  }

  public async getBlastRadius(nodeId: string, maxDepth = 6, includeInferred = false): Promise<BlastRadiusItem[]> {
    const confCondition = includeInferred ? "" : "AND e.confidence = 'EXTRACTED'";

    // Cycle-safe recursive CTE: traverses callers upwards where relation = 'calls'
    const query = `
      WITH RECURSIVE impact(node_id, depth) AS (
        SELECT e.source_id, 1
        FROM code_edges e
        WHERE e.target_id = ? AND e.relation = 'calls' ${confCondition}

        UNION

        SELECT e.source_id, i.depth + 1
        FROM code_edges e
        JOIN impact i ON e.target_id = i.node_id
        WHERE e.relation = 'calls' ${confCondition} AND i.depth < ?
      )
      SELECT n.id, n.name, n.file_path, n.node_type, n.summary, MIN(i.depth) AS depth, n.scc_id
      FROM impact i
      JOIN code_nodes n ON n.id = i.node_id
      WHERE n.id <> ?
      GROUP BY n.id
      ORDER BY depth, n.file_path
      LIMIT 500;
    `;

    const stmt = this.db.prepare(query);
    const rows = stmt.all(nodeId, maxDepth, nodeId) as Record<string, unknown>[];

    // Check if target node is part of an SCC cycle; if so, include other members
    const targetNode = await this.getNode(nodeId);
    const items: BlastRadiusItem[] = rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      filePath: r.file_path as string,
      nodeType: r.node_type as string,
      summary: r.summary as string,
      depth: r.depth as number,
      viaCycle: false
    }));

    if (targetNode && targetNode.sccId != null) {
      const sccStmt = this.db.prepare(`
        SELECT id, name, file_path, node_type, summary
        FROM code_nodes
        WHERE scc_id = ? AND id <> ?
      `);
      const sccMembers = sccStmt.all(targetNode.sccId, nodeId) as Record<string, unknown>[];
      const existingIds = new Set(items.map((i) => i.id));

      for (const m of sccMembers) {
        if (!existingIds.has(m.id as string)) {
          items.push({
            id: m.id as string,
            name: m.name as string,
            filePath: m.file_path as string,
            nodeType: m.node_type as string,
            summary: m.summary as string,
            depth: 1,
            viaCycle: true
          });
        }
      }
    }

    return items;
  }

  // =========================================================================
  // Vector Search (sqlite-vec backed, persistent ANN)
  // =========================================================================

  /**
   * Upsert a node embedding into the persistent vec_nodes virtual table.
   * SQLite vec0 virtual tables do not support standard UPSERT (ON CONFLICT).
   * We perform a transactional DELETE + INSERT to ensure clean upsert semantics.
   */
  public upsertVecEmbedding(nodeId: string, vec: Float32Array): void {
    if (!this.vecAvailable) return;
    try {
      this.db.prepare("DELETE FROM vec_nodes WHERE node_id = ?").run(nodeId);
      this.db.prepare("INSERT INTO vec_nodes(node_id, embedding) VALUES (?, ?)").run(
        nodeId,
        Buffer.from(vec.buffer)
      );
    } catch (err) {
      console.error(`[SQLiteStore] Failed to upsert vector embedding for ${nodeId}:`, err);
    }
  }

  /**
   * Batch upsert vector embeddings into vec_nodes within a single transaction.
   * Performs 1000s of vector insertions in milliseconds without per-row commit overhead.
   */
  public upsertVecEmbeddingsBatch(items: Array<{ nodeId: string; vec: Float32Array }>): void {
    if (!this.vecAvailable || items.length === 0) return;
    try {
      const delStmt = this.db.prepare("DELETE FROM vec_nodes WHERE node_id = ?");
      const insStmt = this.db.prepare("INSERT INTO vec_nodes(node_id, embedding) VALUES (?, ?)");
      const batchTx = this.db.transaction((records: Array<{ nodeId: string; vec: Float32Array }>) => {
        for (const item of records) {
          delStmt.run(item.nodeId);
          insStmt.run(item.nodeId, Buffer.from(item.vec.buffer));
        }
      });
      batchTx(items);
    } catch (err) {
      console.error("[SQLiteStore] Batch vector upsert failed:", err);
    }
  }

  /**
   * Retrieve all node IDs currently indexed in vec_nodes virtual table.
   */
  public getExistingVecNodeIds(): Set<string> {
    if (!this.vecAvailable) return new Set();
    try {
      const rows = this.db.prepare("SELECT node_id FROM vec_nodes").all() as Array<{ node_id: string }>;
      return new Set(rows.map((r) => r.node_id));
    } catch {
      return new Set();
    }
  }

  /**
   * KNN search against the persistent vec_nodes table.
   * Returns up to `limit` results ordered by L2 distance (closest first).
   */
  public searchVec(queryVec: Float32Array, limit = 30): Array<{ nodeId: string; distance: number }> {
    if (!this.vecAvailable) return [];
    try {
      const stmt = this.db.prepare(`
        SELECT node_id, distance
        FROM vec_nodes
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      `);
      const rows = stmt.all(Buffer.from(queryVec.buffer), limit) as Array<{ node_id: string; distance: number }>;
      return rows.map((r) => ({ nodeId: r.node_id, distance: r.distance }));
    } catch {
      return [];
    }
  }

  /**
   * Return the total number of vector embeddings stored in vec_nodes.
   */
  public getVecCount(): number {
    if (!this.vecAvailable) return 0;
    try {
      const row = this.db.prepare("SELECT count(*) as c FROM vec_nodes").get() as { c: number } | undefined;
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }

  // =========================================================================
  // Freshness & Hashes
  // =========================================================================

  public async updateSummaryStatus(
    nodeId: string,
    status: SummaryStatus,
    hashes?: { inputHash?: string; contentHash?: string; summary?: string }
  ): Promise<void> {
    let sql = `UPDATE code_nodes SET summary_status = ?`;
    const params: unknown[] = [status];

    if (hashes?.inputHash !== undefined) {
      sql += `, summary_input_hash = ?`;
      params.push(hashes.inputHash);
    }
    if (hashes?.contentHash !== undefined) {
      sql += `, summary_content_hash = ?`;
      params.push(hashes.contentHash);
    }
    if (hashes?.summary !== undefined) {
      sql += `, summary = ?`;
      params.push(hashes.summary);
    }

    sql += ` WHERE id = ?`;
    params.push(nodeId);

    const stmt = this.db.prepare(sql);
    stmt.run(...params);
  }

  public async markCallersPossiblyStale(nodeId: string): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE code_nodes 
      SET summary_status = 'possibly_stale'
      WHERE id IN (
        SELECT source_id FROM code_edges 
        WHERE target_id = ? AND relation = 'calls' AND confidence = 'EXTRACTED'
      ) AND summary_status = 'fresh'
    `);
    stmt.run(nodeId);
  }

  // =========================================================================
  // Metadata Store
  // =========================================================================

  public async getMeta(key: string): Promise<string | null> {
    const stmt = this.db.prepare(`SELECT value FROM meta WHERE key = ?`);
    const row = stmt.get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  public async setMeta(key: string, value: string): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `);
    stmt.run(key, value);
  }

  // =========================================================================
  // Helper
  // =========================================================================

  private mapNodeRow(r: Record<string, unknown>): NodeRecord {
    return {
      id: r.id as string,
      repoId: r.repo_id as string,
      nodeType: r.node_type as NodeRecord["nodeType"],
      name: r.name as string,
      filePath: r.file_path as string,
      startLine: r.start_line as number | undefined,
      endLine: r.end_line as number | undefined,
      startColumn: r.start_column as number | undefined,
      endColumn: r.end_column as number | undefined,
      signature: r.signature as string | undefined,
      rawCode: r.raw_code as string | undefined,
      summary: r.summary as string | undefined,
      level: r.level as number | undefined,
      metadata: JSON.parse((r.metadata as string) || "{}"),
      displayId: r.display_id as string | undefined,
      sourceHash: r.source_hash as string | undefined,
      sccId: r.scc_id as number | undefined,
      summaryStatus: r.summary_status as SummaryStatus,
      summaryInputHash: r.summary_input_hash as string | undefined,
      summaryContentHash: r.summary_content_hash as string | undefined
    };
  }
}
