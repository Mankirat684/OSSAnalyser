import pg from "pg";
import type { GraphStore, RepoRecord, NodeRecord, EdgeRecord, GitOwnershipRecord } from "../storage/graphStore.js";

const { Pool } = pg;

export interface PostgresExportOptions {
  connectionString: string;
  repoId: string;
}

export interface ExportStats {
  repoName: string;
  nodesExported: number;
  edgesExported: number;
  ownershipExported: number;
  durationMs: number;
}

export class PostgresExporter {
  public static async exportToPostgres(
    store: GraphStore,
    options: PostgresExportOptions
  ): Promise<ExportStats> {
    const startTime = Date.now();
    const isSsl =
      options.connectionString.includes("supabase.co") ||
      options.connectionString.includes("sslmode=require");

    const pool = new Pool({
      connectionString: options.connectionString,
      ssl: isSsl ? { rejectUnauthorized: false } : undefined
    });

    const client = await pool.connect();

    try {
      await client.query("BEGIN;");

      // 1. Fetch Repository Record
      const repo = await store.getRepository(options.repoId);
      if (!repo) {
        throw new Error(`Repository record with id '${options.repoId}' not found in local SQLite database.`);
      }

      await client.query(
        `INSERT INTO repositories (id, name, root_path, status, checkpoint_data, architecture_summary, onboarding_guide, indexed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           root_path = EXCLUDED.root_path,
           status = EXCLUDED.status,
           checkpoint_data = EXCLUDED.checkpoint_data,
           architecture_summary = EXCLUDED.architecture_summary,
           onboarding_guide = EXCLUDED.onboarding_guide,
           indexed_at = NOW();`,
        [
          repo.id,
          repo.name,
          repo.rootPath,
          repo.status || "indexed",
          JSON.stringify(repo.checkpointData || {}),
          repo.architectureSummary ?? null,
          repo.onboardingGuide ?? null
        ]
      );

      // 2. Export Code Nodes (in chunks of 100)
      const allNodes = await store.getAllNodes(options.repoId);
      const CHUNK_SIZE = 100;

      for (let i = 0; i < allNodes.length; i += CHUNK_SIZE) {
        const chunk = allNodes.slice(i, i + CHUNK_SIZE);
        for (const n of chunk) {
          await client.query(
            `INSERT INTO code_nodes (
               id, repo_id, node_type, name, file_path,
               start_line, end_line, start_column, end_column,
               signature, raw_code, summary, level, metadata
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             ON CONFLICT (id) DO UPDATE SET
               repo_id = EXCLUDED.repo_id,
               node_type = EXCLUDED.node_type,
               name = EXCLUDED.name,
               file_path = EXCLUDED.file_path,
               start_line = EXCLUDED.start_line,
               end_line = EXCLUDED.end_line,
               start_column = EXCLUDED.start_column,
               end_column = EXCLUDED.end_column,
               signature = EXCLUDED.signature,
               raw_code = EXCLUDED.raw_code,
               summary = EXCLUDED.summary,
               level = EXCLUDED.level,
               metadata = EXCLUDED.metadata;`,
            [
              n.id,
              n.repoId,
              n.nodeType,
              n.name,
              n.filePath,
              n.startLine ?? null,
              n.endLine ?? null,
              n.startColumn ?? null,
              n.endColumn ?? null,
              n.signature ?? null,
              n.rawCode ?? null,
              n.summary ?? "pending_summary",
              n.level ?? 0,
              JSON.stringify(n.metadata || {})
            ]
          );
        }
      }

      // 3. Export Code Edges
      // Extract outgoing edges for all nodes
      let edgeCount = 0;
      for (const n of allNodes) {
        const callees = await store.getDependencies(n.id, 1, true);
        for (const c of callees) {
          await client.query(
            `INSERT INTO code_edges (repo_id, source_id, target_id, relation, confidence, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (repo_id, source_id, target_id, relation) DO UPDATE SET
               confidence = EXCLUDED.confidence,
               metadata = EXCLUDED.metadata;`,
            [
              options.repoId,
              n.id,
              c.id,
              c.relation,
              c.confidence || "EXTRACTED",
              JSON.stringify({ line: c.line })
            ]
          );
          edgeCount++;
        }
      }

      // 4. Export Git Ownership
      let ownershipCount = 0;
      for (const n of allNodes) {
        const ownership = await store.getOwnership(n.id);
        if (ownership.length > 0) {
          await client.query(`DELETE FROM git_ownership WHERE node_id = $1`, [n.id]);
          for (const o of ownership) {
            await client.query(
              `INSERT INTO git_ownership (
                 repo_id, node_id, author_name, author_email,
                 lines_authored, ownership_percentage, last_commit_date, total_commits
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);`,
              [
                o.repoId,
                o.nodeId,
                o.authorName,
                o.authorEmail,
                o.linesAuthored,
                Math.round(o.ownershipPercentage * 100) / 100,
                o.lastCommitDate ?? null,
                o.totalCommits ?? 1
              ]
            );
            ownershipCount++;
          }
        }
      }

      await client.query("COMMIT;");

      return {
        repoName: repo.name,
        nodesExported: allNodes.length,
        edgesExported: edgeCount,
        ownershipExported: ownershipCount,
        durationMs: Date.now() - startTime
      };
    } catch (err) {
      await client.query("ROLLBACK;");
      throw err;
    } finally {
      client.release();
      await pool.end();
    }
  }
}
