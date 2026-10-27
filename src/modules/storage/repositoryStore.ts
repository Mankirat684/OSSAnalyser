import * as path from "node:path";
import { pool } from "../../config/database.js";
import type {
  CodebaseSummaryResult,
  AnalyzerPipelineResult,
  BlastRadiusResult,
  NodeDetailResponse,
  FunctionSummary,
  FileSummary,
  DirectorySummary,
  RepoSummary,
  CodeNode,
  RawGraphEdge
} from "../../core/types.js";
import { extractGitOwnershipForRange } from "../git/index.js";
import { extractGitOwnershipInWorkerThread } from "../workers/gitBlameWorker.js";
import { GeminiSummarizerClient } from "../summarizer/index.js";
import { condenseGraphWithTarjan } from "../analyzer/tarjan.js";
import { computeBottomUpTopoLevels } from "../analyzer/topoSort.js";
import { packTopoLevelsIntoLLMBatches } from "../analyzer/chunker.js";

export class RepositoryStore {
  /**
   * Checkpoint 1: Immediately saves the structural graph (nodes, edges, git blame)
   * after parsing completes, before any LLM calls are made.
   */
  public static async saveParsedStructure(
    repoId: string,
    repoName: string,
    repoRootPath: string,
    analyzerResult: AnalyzerPipelineResult
  ): Promise<void> {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // 1. Upsert Repository record with status 'parsed'
      const checkpointData = {
        stage: "parsed",
        totalNodes: analyzerResult.totalNodes,
        totalEdges: analyzerResult.totalEdges,
        topoLevels: analyzerResult.topoLevels.length,
        parsedAt: new Date().toISOString()
      };

      await client.query(
        `INSERT INTO repositories (id, name, root_path, status, checkpoint_data, indexed_at)
         VALUES ($1, $2, $3, 'parsed', $4, NOW())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           root_path = EXCLUDED.root_path,
           status = 'parsed',
           checkpoint_data = EXCLUDED.checkpoint_data,
           indexed_at = NOW()`,
        [repoId, repoName, repoRootPath, JSON.stringify(checkpointData)]
      );

      // 2. Pre-extract Git Ownership using Worker Thread off the main event loop
      const blameInputs = Array.from(analyzerResult.rawNodes.entries()).map(([nodeId, node]) => ({
        id: nodeId,
        source_file: node.source_file,
        start_line: node.start_line,
        end_line: node.end_line
      }));

      const ownershipMap = await extractGitOwnershipInWorkerThread({
        repoRoot: repoRootPath,
        nodes: blameInputs
      });

      // 3. Insert all raw code nodes with summary = 'pending_summary'
      let processedNodes = 0;
      for (const [nodeId, node] of analyzerResult.rawNodes.entries()) {
        await client.query(
          `INSERT INTO code_nodes (id, repo_id, node_type, name, file_path, start_line, end_line, start_column, end_column, signature, raw_code, summary, level, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending_summary', 0, $12)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             file_path = EXCLUDED.file_path,
             start_line = EXCLUDED.start_line,
             end_line = EXCLUDED.end_line,
             start_column = EXCLUDED.start_column,
             end_column = EXCLUDED.end_column,
             signature = EXCLUDED.signature,
             raw_code = EXCLUDED.raw_code,
             metadata = EXCLUDED.metadata`,
          [
            nodeId,
            repoId,
            node.is_class ? "class" : "function",
            node.label,
            node.source_file,
            node.start_line || null,
            node.end_line || null,
            node.start_column || null,
            node.end_column || null,
            node.signature || node.label,
            node.raw_code || "",
            JSON.stringify({
              is_callable: node.is_callable,
              is_class: node.is_class,
              dependencies: node.dependencies
            })
          ]
        );

        // Git Ownership from precomputed worker thread map
        const ownershipList = ownershipMap[nodeId] || [];

        await client.query(`DELETE FROM git_ownership WHERE repo_id = $1 AND node_id = $2`, [repoId, nodeId]);

        for (const owner of ownershipList) {
          await client.query(
            `INSERT INTO git_ownership (repo_id, node_id, author_name, author_email, lines_authored, ownership_percentage, last_commit_date, total_commits)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              repoId,
              nodeId,
              owner.authorName,
              owner.authorEmail,
              owner.linesAuthored,
              owner.ownershipPercentage,
              owner.lastCommitDate,
              owner.totalCommits
            ]
          );
        }

        if (++processedNodes % 100 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      // 4. Insert all Edges
      for (const [nodeId, node] of analyzerResult.rawNodes.entries()) {
        for (const calleeId of node.dependencies) {
          if (analyzerResult.rawNodes.has(calleeId)) {
            await client.query(
              `INSERT INTO code_edges (repo_id, source_id, target_id, relation, confidence)
               VALUES ($1, $2, $3, 'calls', 'EXTRACTED')
               ON CONFLICT ON CONSTRAINT unique_repo_edge DO NOTHING`,
              [repoId, nodeId, calleeId]
            );
          }
        }
      }

      await client.query("COMMIT");
      console.log(`[RepositoryStore] ✓ Checkpoint 1: Structure, edges, and git blame saved for "${repoName}"`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[RepositoryStore] Failed to save parsed structure:", err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Reconstructs the complete AnalyzerPipelineResult directly from PostgreSQL.
   * Enables resuming or restarting summarization even when the cloned repo was deleted from disk!
   */
  public static async reconstructAnalyzerResult(repoId: string): Promise<AnalyzerPipelineResult> {
    const nodesRes = await pool.query(
      `SELECT id, name, node_type, file_path, start_line, end_line, start_column, end_column, signature, raw_code, metadata
       FROM code_nodes
       WHERE repo_id = $1 AND node_type IN ('function', 'class')`,
      [repoId]
    );

    const edgesRes = await pool.query(
      `SELECT source_id, target_id, relation
       FROM code_edges
       WHERE repo_id = $1 AND relation = 'calls'`,
      [repoId]
    );

    const rawEdges: RawGraphEdge[] = edgesRes.rows.map((r) => ({
      source: r.source_id,
      target: r.target_id,
      relation: r.relation
    }));

    const outgoingEdges = new Map<string, string[]>();
    const incomingEdges = new Map<string, string[]>();

    for (const edge of rawEdges) {
      if (!outgoingEdges.has(edge.source)) outgoingEdges.set(edge.source, []);
      outgoingEdges.get(edge.source)!.push(edge.target);

      if (!incomingEdges.has(edge.target)) incomingEdges.set(edge.target, []);
      incomingEdges.get(edge.target)!.push(edge.source);
    }

    const nodes = new Map<string, CodeNode>();
    for (const row of nodesRes.rows) {
      const rawCode = row.raw_code || "";
      nodes.set(row.id, {
        id: row.id,
        label: row.name,
        file_type: path.extname(row.file_path || "").replace(".", ""),
        source_file: row.file_path,
        start_line: row.start_line,
        end_line: row.end_line,
        start_column: row.start_column,
        end_column: row.end_column,
        is_callable: true,
        is_class: row.node_type === "class",
        raw_code: rawCode,
        signature: row.signature || row.name,
        estimated_tokens: Math.ceil(rawCode.length / 4),
        dependencies: outgoingEdges.get(row.id) || [],
        callers: incomingEdges.get(row.id) || []
      });
    }

    const dag = condenseGraphWithTarjan(nodes);
    const { levels } = computeBottomUpTopoLevels(dag);

    const cyclicSCCs: AnalyzerPipelineResult["cyclicSCCs"] = [];
    for (const comp of dag.components.values()) {
      if (comp.isCyclic) {
        cyclicSCCs.push({
          id: comp.id,
          nodeCount: comp.nodeIds.length,
          nodeIds: comp.nodeIds,
          labels: comp.nodes.map((n) => n.label),
          totalTokens: comp.totalTokens
        });
      }
    }

    const formattedLevels = levels.map((lvl) => ({
      level: lvl.level,
      componentCount: lvl.components.length,
      nodeCount: lvl.components.reduce((sum, c) => sum + c.nodeIds.length, 0),
      components: lvl.components.map((c) => ({
        id: c.id,
        isCyclic: c.isCyclic,
        nodeIds: c.nodeIds,
        labels: c.nodes.map((n) => n.label),
        dependencies: Array.from(c.dependencies)
      }))
    }));

    const batches = packTopoLevelsIntoLLMBatches(levels);

    return {
      totalNodes: nodes.size,
      totalEdges: rawEdges.length,
      sccCount: dag.components.size,
      cyclicSCCs,
      topoLevels: formattedLevels,
      batches,
      rawNodes: nodes,
      dag
    };
  }


  /**
   * Retrieves any existing completed function summaries from PostgreSQL.
   * Used for resuming interrupted or failed ingestion jobs with zero wasted tokens.
   */
  public static async getExistingSummaries(repoId: string): Promise<Map<string, FunctionSummary>> {
    const existing = new Map<string, FunctionSummary>();
    try {
      const res = await pool.query(
        `SELECT id, name, file_path, summary, level, metadata 
         FROM code_nodes 
         WHERE repo_id = $1 
           AND summary IS NOT NULL 
           AND summary != 'pending_summary'
           AND node_type IN ('function', 'class')`,
        [repoId]
      );

      for (const row of res.rows) {
        existing.set(row.id, {
          nodeId: row.id,
          label: row.name,
          sourceFile: row.file_path,
          summary: row.summary,
          inputs: row.metadata?.inputs,
          outputs: row.metadata?.outputs,
          sideEffects: row.metadata?.sideEffects,
          level: row.level || 0,
          isCycleMember: row.metadata?.isCycleMember || false
        });
      }
    } catch (err) {
      console.warn("[RepositoryStore] Could not fetch existing summaries, starting fresh:", err);
    }
    return existing;
  }

  /**
   * Sub-Checkpoint: Saves an incremental batch of function summaries + vector embeddings.
   * Commits progress to the DB every ~20% or per level, so work is never lost.
   */
  public static async saveFunctionSummaryBatch(
    repoId: string,
    batchSummaries: FunctionSummary[],
    checkpointData?: Record<string, unknown>
  ): Promise<void> {
    if (batchSummaries.length === 0) return;

    const gemini = new GeminiSummarizerClient();

    // 1. Generate embeddings in paced chunks to prevent concurrent API burst errors
    const preparedUpdates: Array<{ fn: FunctionSummary; vectorStr: string }> = [];
    const chunkSize = 4;
    for (let i = 0; i < batchSummaries.length; i += chunkSize) {
      const chunk = batchSummaries.slice(i, i + chunkSize);
      const chunkResults = await Promise.all(
        chunk.map(async (fn) => {
          const embedding = await gemini.generateEmbedding(`${fn.label} ${fn.summary}`);
          return {
            fn,
            vectorStr: `[${embedding.join(",")}]`
          };
        })
      );
      preparedUpdates.push(...chunkResults);
    }

    // 2. Open quick transactional DB lock strictly for updates (sub-50ms)
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      for (const { fn, vectorStr } of preparedUpdates) {
        await client.query(
          `UPDATE code_nodes 
           SET summary = $1, 
               embedding = $2::vector, 
               level = $3, 
               metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{summaryInfo}', $4::jsonb)
           WHERE repo_id = $5 AND id = $6`,
          [
            fn.summary,
            vectorStr,
            fn.level,
            JSON.stringify({
              inputs: fn.inputs,
              outputs: fn.outputs,
              sideEffects: fn.sideEffects,
              isCycleMember: fn.isCycleMember
            }),
            repoId,
            fn.nodeId
          ]
        );
      }

      if (checkpointData) {
        await client.query(
          `UPDATE repositories 
           SET checkpoint_data = $1, 
               status = 'summarizing'
           WHERE id = $2`,
          [JSON.stringify(checkpointData), repoId]
        );
      }

      await client.query("COMMIT");
      console.log(`[RepositoryStore] ✓ Sub-checkpoint: ${batchSummaries.length} summaries and vectors committed.`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[RepositoryStore] Failed to save summary batch:", err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Rollup Checkpoint: Saves file and directory subsystem rollup summaries with vector embeddings.
   */
  public static async saveFileAndDirectoryRollups(
    repoId: string,
    fileSummaries: Map<string, FileSummary>,
    dirSummaries: Map<string, DirectorySummary>
  ): Promise<void> {
    const gemini = new GeminiSummarizerClient();

    // 1. Pre-generate embeddings for files and directories outside DB transaction
    const preparedFiles = await Promise.all(
      Array.from(fileSummaries.entries()).map(async ([filePath, fileSumm]) => {
        const fileNodeId = `file_${filePath.replace(/[^a-zA-Z0-9_]/g, "_")}`;
        const embedding = await gemini.generateEmbedding(`${filePath} ${fileSumm.summary}`);
        return {
          fileNodeId,
          filePath,
          fileSumm,
          vectorStr: `[${embedding.join(",")}]`
        };
      })
    );

    const preparedDirs = await Promise.all(
      Array.from(dirSummaries.entries()).map(async ([dirPath, dirSumm]) => {
        const dirNodeId = `dir_${dirPath.replace(/[^a-zA-Z0-9_]/g, "_")}`;
        const embedding = await gemini.generateEmbedding(`${dirPath} ${dirSumm.summary}`);
        return {
          dirNodeId,
          dirPath,
          dirSumm,
          vectorStr: `[${embedding.join(",")}]`
        };
      })
    );

    // 2. Fast DB commit
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Insert File Nodes with Embeddings
      for (const { fileNodeId, filePath, fileSumm, vectorStr } of preparedFiles) {
        await client.query(
          `INSERT INTO code_nodes (id, repo_id, node_type, name, file_path, summary, embedding, level, metadata)
           VALUES ($1, $2, 'file', $3, $4, $5, $6::vector, 10, $7)
           ON CONFLICT (id) DO UPDATE SET 
             summary = EXCLUDED.summary,
             embedding = EXCLUDED.embedding,
             metadata = EXCLUDED.metadata`,
          [
            fileNodeId,
            repoId,
            filePath,
            filePath,
            fileSumm.summary,
            vectorStr,
            JSON.stringify({
              purpose: fileSumm.purpose,
              exportedSymbols: fileSumm.exportedSymbols,
              functionCount: fileSumm.functionCount
            })
          ]
        );
      }

      // Insert Directory Nodes with Embeddings
      for (const { dirNodeId, dirPath, dirSumm, vectorStr } of preparedDirs) {
        await client.query(
          `INSERT INTO code_nodes (id, repo_id, node_type, name, file_path, summary, embedding, level, metadata)
           VALUES ($1, $2, 'directory', $3, $4, $5, $6::vector, 20, $7)
           ON CONFLICT (id) DO UPDATE SET 
             summary = EXCLUDED.summary,
             embedding = EXCLUDED.embedding,
             metadata = EXCLUDED.metadata`,
          [
            dirNodeId,
            repoId,
            dirPath,
            dirPath,
            dirSumm.summary,
            vectorStr,
            JSON.stringify({
              responsibility: dirSumm.responsibility,
              files: dirSumm.files
            })
          ]
        );
      }

      await client.query("COMMIT");
      console.log(`[RepositoryStore] ✓ Rollup checkpoint: ${fileSummaries.size} files and ${dirSummaries.size} directories saved.`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[RepositoryStore] Failed to save rollups:", err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Final Checkpoint: Finalizes repo architecture summary, onboarding guide, and marks status 'completed'.
   */
  public static async finalizeRepositorySummary(
    repoId: string,
    repoSummary: RepoSummary
  ): Promise<void> {
    await pool.query(
      `UPDATE repositories 
       SET architecture_summary = $1, 
           onboarding_guide = $2, 
           status = 'completed',
           checkpoint_data = jsonb_set(COALESCE(checkpoint_data, '{}'::jsonb), '{stage}', '"completed"')
       WHERE id = $3`,
      [repoSummary.summary, repoSummary.onboardingGuide, repoId]
    );
    console.log(`[RepositoryStore] ✓ Final checkpoint: Repository ${repoId} marked 'completed'.`);
  }

  /**
   * Backwards-compatible save: Executes all checkpoint stages sequentially.
   */
  public static async saveCodebase(
    repoId: string,
    repoName: string,
    repoRootPath: string,
    analyzerResult: AnalyzerPipelineResult,
    summaries: CodebaseSummaryResult
  ): Promise<void> {
    await this.saveParsedStructure(repoId, repoName, repoRootPath, analyzerResult);
    await this.saveFunctionSummaryBatch(repoId, Array.from(summaries.functions.values()));
    await this.saveFileAndDirectoryRollups(repoId, summaries.files, summaries.directories);
    await this.finalizeRepositorySummary(repoId, summaries.repo);
  }

  /**
   * Computes Blast Radius using SQL Recursive Common Table Expression (CTE).
   */
  public static async getBlastRadius(
    repoId: string,
    nodeId: string,
    maxDepth = 10
  ): Promise<BlastRadiusResult[]> {
    const query = `
      WITH RECURSIVE blast_radius AS (
        SELECT 
          source_id AS affected_node_id, 
          target_id AS triggered_by,
          relation, 
          1 AS depth
        FROM code_edges
        WHERE repo_id = $1 AND target_id = $2 AND relation = 'calls'

        UNION ALL

        SELECT 
          e.source_id, 
          e.target_id,
          e.relation, 
          br.depth + 1
        FROM code_edges e
        INNER JOIN blast_radius br ON e.target_id = br.affected_node_id
        WHERE e.repo_id = $1 AND e.relation = 'calls' AND br.depth < $3
      )
      SELECT DISTINCT 
        n.id, n.name, n.file_path, n.node_type, n.summary, br.depth
      FROM blast_radius br
      JOIN code_nodes n ON n.id = br.affected_node_id AND n.repo_id = $1
      ORDER BY br.depth ASC;
    `;

    const result = await pool.query(query, [repoId, nodeId, maxDepth]);
    return result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      filePath: r.file_path,
      nodeType: r.node_type,
      summary: r.summary,
      depth: r.depth
    }));
  }

  /**
   * Retrieves full details for a node, including ownership, callers, callees, and blast radius.
   */
  public static async getNodeDetails(
    repoId: string,
    nodeId: string
  ): Promise<NodeDetailResponse | null> {
    const nodeRes = await pool.query(
      `SELECT * FROM code_nodes WHERE repo_id = $1 AND id = $2`,
      [repoId, nodeId]
    );

    if (nodeRes.rows.length === 0) return null;
    const n = nodeRes.rows[0];

    const ownerRes = await pool.query(
      `SELECT author_name, author_email, lines_authored, ownership_percentage, last_commit_date, total_commits
       FROM git_ownership WHERE repo_id = $1 AND node_id = $2
       ORDER BY ownership_percentage DESC`,
      [repoId, nodeId]
    );

    const callersRes = await pool.query(
      `SELECT n.id, n.name, n.file_path
       FROM code_edges e
       JOIN code_nodes n ON n.id = e.source_id AND n.repo_id = $1
       WHERE e.repo_id = $1 AND e.target_id = $2 AND e.relation = 'calls'`,
      [repoId, nodeId]
    );

    const calleesRes = await pool.query(
      `SELECT n.id, n.name, n.file_path
       FROM code_edges e
       JOIN code_nodes n ON n.id = e.target_id AND n.repo_id = $1
       WHERE e.repo_id = $1 AND e.source_id = $2 AND e.relation = 'calls'`,
      [repoId, nodeId]
    );

    const blastRadius = await this.getBlastRadius(repoId, nodeId);

    return {
      node: {
        id: n.id,
        name: n.name,
        nodeType: n.node_type,
        filePath: n.file_path,
        startLine: n.start_line,
        endLine: n.end_line,
        startColumn: n.start_column,
        endColumn: n.end_column,
        signature: n.signature,
        rawCode: n.raw_code,
        summary: n.summary,
        level: n.level
      },
      ownership: ownerRes.rows.map((o) => ({
        authorName: o.author_name,
        authorEmail: o.author_email,
        linesAuthored: o.lines_authored,
        ownershipPercentage: Number(o.ownership_percentage),
        lastCommitDate: o.last_commit_date,
        totalCommits: o.total_commits
      })),
      callers: callersRes.rows.map((c) => ({
        id: c.id,
        name: c.name,
        filePath: c.file_path
      })),
      callees: calleesRes.rows.map((c) => ({
        id: c.id,
        name: c.name,
        filePath: c.file_path
      })),
      blastRadius
    };
  }

  /**
   * Retrieves all nodes and edges formatted for Cytoscape.js.
   */
  public static async getGraphElements(repoId: string): Promise<{
    nodes: Array<{ data: Record<string, unknown> }>;
    edges: Array<{ data: Record<string, unknown> }>;
  }> {
    const nodesRes = await pool.query(
      `SELECT id, name, file_path, node_type, level, summary FROM code_nodes WHERE repo_id = $1`,
      [repoId]
    );

    const edgesRes = await pool.query(
      `SELECT id, source_id, target_id, relation FROM code_edges WHERE repo_id = $1`,
      [repoId]
    );

    return {
      nodes: nodesRes.rows.map((r) => ({
        data: {
          id: r.id,
          label: r.name,
          filePath: r.file_path,
          nodeType: r.node_type,
          level: r.level,
          summary: r.summary
        }
      })),
      edges: edgesRes.rows.map((e) => ({
        data: {
          id: `edge_${e.id}`,
          source: e.source_id,
          target: e.target_id,
          label: e.relation
        }
      }))
    };
  }

  /**
   * Performs semantic vector search on code_nodes using cosine distance (<=>).
   */
  public static async searchSimilarNodes(
    repoId: string,
    queryEmbedding: number[],
    limit = 10
  ): Promise<
    Array<{
      id: string;
      name: string;
      filePath: string;
      nodeType: string;
      summary: string;
      rawCode?: string;
      similarity: number;
    }>
  > {
    const vectorStr = `[${queryEmbedding.join(",")}]`;
    const res = await pool.query(
      `SELECT id, name, file_path, node_type, summary, raw_code, 1 - (embedding <=> $2::vector) AS similarity
       FROM code_nodes
       WHERE repo_id = $1 AND embedding IS NOT NULL
       ORDER BY embedding <=> $2::vector ASC
       LIMIT $3`,
      [repoId, vectorStr, limit]
    );

    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      filePath: r.file_path,
      nodeType: r.node_type,
      summary: r.summary,
      rawCode: r.raw_code || "",
      similarity: Number(r.similarity)
    }));
  }
}
