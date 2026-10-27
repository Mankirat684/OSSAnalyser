import { pool } from "../../config/database.js";
import { RepositoryStore } from "../../modules/storage/index.js";
import { GeminiSummarizerClient } from "../../modules/summarizer/index.js";

export interface CompactArchitectureView {
  repoName: string;
  architectureSummary: string;
  onboardingGuide: string;
  subsystems: Array<{ path: string; responsibility: string; summary: string }>;
  estimatedTokens: number;
}

export interface CompactFileContract {
  filePath: string;
  purpose: string;
  summary: string;
  exportedSymbols: Array<{
    name: string;
    nodeType: string;
    summary: string;
    signature?: string;
  }>;
  estimatedTokens: number;
}

export interface CompactFunctionContract {
  id: string;
  name: string;
  signature?: string;
  filePath: string;
  summary: string;
  inputs?: string;
  outputs?: string;
  sideEffects?: string;
  callees: string[];
  callers: string[];
  estimatedTokens: number;
}

export interface MinimalTaskContext {
  task: string;
  architectureSnippet: string;
  relevantSymbols: Array<{
    name: string;
    filePath: string;
    signature?: string;
    summary: string;
  }>;
  blastRadiusWarnings: Array<{
    symbol: string;
    affectedCallers: string[];
  }>;
  totalTokens: number;
}

/**
 * Harness Interface: Lightweight, token-efficient SDK for AI coding agents
 * (e.g. SWE-bench, Antigravity, Aider, Cline) to traverse codebases with 85-95% fewer tokens.
 */
export class CodebaseHarness {
  private gemini: GeminiSummarizerClient;

  constructor() {
    this.gemini = new GeminiSummarizerClient();
  }

  /**
   * Retrieves high-level architecture overview (~150 tokens).
   * Replaces reading top-level READMEs and folder trees.
   */
  public async getArchitectureOverview(repoId: string): Promise<CompactArchitectureView> {
    const repoRes = await pool.query(
      `SELECT name, architecture_summary, onboarding_guide FROM repositories WHERE id = $1`,
      [repoId]
    );

    const dirRes = await pool.query(
      `SELECT name, summary, metadata FROM code_nodes WHERE repo_id = $1 AND node_type = 'directory'`,
      [repoId]
    );

    const repo = repoRes.rows[0] || {
      name: "Unknown",
      architecture_summary: "N/A",
      onboarding_guide: "N/A"
    };

    const subsystems = dirRes.rows.map((r) => ({
      path: r.name,
      responsibility: r.metadata?.responsibility || "Module",
      summary: r.summary
    }));

    const text = `${repo.name} ${repo.architecture_summary} ${subsystems.map((s) => s.summary).join(" ")}`;
    const estimatedTokens = Math.ceil(text.length / 4);

    return {
      repoName: repo.name,
      architectureSummary: repo.architecture_summary,
      onboardingGuide: repo.onboarding_guide,
      subsystems,
      estimatedTokens
    };
  }

  /**
   * Retrieves file purpose and exported symbol summaries without raw code (~60-120 tokens).
   * Replaces reading entire 500-line files.
   */
  public async getFileContract(repoId: string, filePath: string): Promise<CompactFileContract | null> {
    const fileRes = await pool.query(
      `SELECT summary, metadata FROM code_nodes WHERE repo_id = $1 AND node_type = 'file' AND file_path = $2`,
      [repoId, filePath]
    );

    if (fileRes.rows.length === 0) return null;
    const fileRow = fileRes.rows[0];

    const symbolsRes = await pool.query(
      `SELECT name, node_type, summary, signature FROM code_nodes WHERE repo_id = $1 AND file_path = $2 AND node_type IN ('function', 'class')`,
      [repoId, filePath]
    );

    const exportedSymbols = symbolsRes.rows.map((r) => ({
      name: r.name,
      nodeType: r.node_type,
      summary: r.summary,
      signature: r.signature
    }));

    const text = `${filePath} ${fileRow.summary} ${exportedSymbols.map((s) => s.summary).join(" ")}`;
    const estimatedTokens = Math.ceil(text.length / 4);

    return {
      filePath,
      purpose: fileRow.metadata?.purpose || "Module file",
      summary: fileRow.summary,
      exportedSymbols,
      estimatedTokens
    };
  }

  /**
   * Retrieves function signature, inputs/outputs, and callees (~30-50 tokens).
   */
  public async getFunctionContract(
    repoId: string,
    symbolNameOrId: string
  ): Promise<CompactFunctionContract | null> {
    const nodeRes = await pool.query(
      `SELECT id, name, file_path, signature, summary, metadata
       FROM code_nodes
       WHERE repo_id = $1 AND (id = $2 OR name ILIKE $3)
       LIMIT 1`,
      [repoId, symbolNameOrId, `%${symbolNameOrId}%`]
    );

    if (nodeRes.rows.length === 0) return null;
    const node = nodeRes.rows[0];

    // Immediate callees and callers
    const edgesRes = await pool.query(
      `SELECT source_id, target_id FROM code_edges WHERE repo_id = $1 AND (source_id = $2 OR target_id = $2) AND relation = 'calls'`,
      [repoId, node.id]
    );

    const callees = edgesRes.rows.filter((e) => e.source_id === node.id).map((e) => e.target_id);
    const callers = edgesRes.rows.filter((e) => e.target_id === node.id).map((e) => e.source_id);

    const text = `${node.name} ${node.signature} ${node.summary} ${callees.join(" ")}`;
    const estimatedTokens = Math.ceil(text.length / 4);

    return {
      id: node.id,
      name: node.name,
      signature: node.signature,
      filePath: node.file_path,
      summary: node.summary,
      inputs: node.metadata?.inputs,
      outputs: node.metadata?.outputs,
      sideEffects: node.metadata?.sideEffects,
      callees,
      callers,
      estimatedTokens
    };
  }

  /**
   * Retrieves blast radius for an AI agent before making code edits (~50 tokens).
   */
  public async getBlastRadius(repoId: string, symbolIdOrName: string) {
    const nodeRes = await pool.query(
      `SELECT id, name, file_path FROM code_nodes WHERE repo_id = $1 AND (id = $2 OR name ILIKE $3) LIMIT 1`,
      [repoId, symbolIdOrName, `%${symbolIdOrName}%`]
    );

    if (nodeRes.rows.length === 0) return { target: symbolIdOrName, affectedUpstream: [] };
    const target = nodeRes.rows[0];

    const blast = await RepositoryStore.getBlastRadius(repoId, target.id);
    return {
      target: target.name,
      filePath: target.file_path,
      affectedUpstream: blast.map((b) => ({
        depth: b.depth,
        name: b.name,
        filePath: b.filePath,
        summary: b.summary
      }))
    };
  }

  /**
   * Automatically packs the minimal essential context for an AI agent task
   * within a strict token budget (e.g. 2,000 tokens), preventing agent context bloat.
   */
  public async resolveMinimalContext(
    repoId: string,
    taskQuery: string,
    tokenBudget = 2500
  ): Promise<MinimalTaskContext> {
    const queryEmbedding = await this.gemini.generateEmbedding(taskQuery);
    const vectorMatches = await RepositoryStore.searchSimilarNodes(repoId, queryEmbedding, 8);

    const repoInfo = await this.getArchitectureOverview(repoId);
    let usedTokens = 0;

    const relevantSymbols: MinimalTaskContext["relevantSymbols"] = [];
    const blastWarnings: MinimalTaskContext["blastRadiusWarnings"] = [];

    for (const match of vectorMatches) {
      const symSummary = `${match.name} (${match.filePath}): ${match.summary}`;
      const tokens = Math.ceil(symSummary.length / 4);

      if (usedTokens + tokens > tokenBudget - 200) break;

      relevantSymbols.push({
        name: match.name,
        filePath: match.filePath,
        summary: match.summary
      });
      usedTokens += tokens;

      // Add blast radius if function
      if (match.nodeType === "function" && blastWarnings.length < 3) {
        const blast = await RepositoryStore.getBlastRadius(repoId, match.id, 2);
        if (blast.length > 0) {
          blastWarnings.push({
            symbol: match.name,
            affectedCallers: blast.map((b) => `${b.name} (${b.filePath})`)
          });
        }
      }
    }

    return {
      task: taskQuery,
      architectureSnippet: `${repoInfo.repoName}: ${repoInfo.architectureSummary}`,
      relevantSymbols,
      blastRadiusWarnings: blastWarnings,
      totalTokens: usedTokens + Math.ceil(repoInfo.architectureSummary.length / 4)
    };
  }

  /**
   * Model Context Protocol (MCP) tool schema definitions for plug-and-play AI agent harnesses.
   */
  public getMCPToolDefinitions() {
    return [
      {
        name: "codebase_get_architecture",
        description: "Returns the high-level system architecture and module boundaries without reading raw files (~150 tokens).",
        parameters: { type: "object", properties: { repoId: { type: "string" } }, required: ["repoId"] }
      },
      {
        name: "codebase_get_file_contract",
        description: "Returns exported symbols, signatures, and file purpose without reading raw code (~80 tokens).",
        parameters: { type: "object", properties: { repoId: { type: "string" }, filePath: { type: "string" } }, required: ["repoId", "filePath"] }
      },
      {
        name: "codebase_get_blast_radius",
        description: "Determines all upstream callers affected before you modify a function (~50 tokens).",
        parameters: { type: "object", properties: { repoId: { type: "string" }, symbol: { type: "string" } }, required: ["repoId", "symbol"] }
      },
      {
        name: "codebase_resolve_context",
        description: "Retrieves only the essential symbol summaries matching a task within a strict token budget (~1,500 tokens).",
        parameters: { type: "object", properties: { repoId: { type: "string" }, task: { type: "string" } }, required: ["repoId", "task"] }
      }
    ];
  }
}
