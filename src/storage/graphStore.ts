/**
 * Storage-agnostic interface for OSS Analyser.
 * Shared between PostgreSQL (hosted web app) and SQLite (local CLI & MCP server).
 */

export interface RepoRecord {
  id: string;
  name: string;
  rootPath: string;
  ownerId?: string | null;
  status: string;
  checkpointData?: Record<string, unknown>;
  architectureSummary?: string | null;
  onboardingGuide?: string | null;
  indexedAt?: string;
}

export type SummaryStatus = 'missing' | 'fresh' | 'stale' | 'possibly_stale' | 'heuristic';

export interface NodeRecord {
  id: string; // Deterministic 12-char SHA-1 hash for symbols, stable path-based ID for files/dirs
  repoId: string;
  nodeType: 'function' | 'method' | 'class' | 'file' | 'module' | 'directory';
  name: string;
  filePath: string;
  startLine?: number | null;
  endLine?: number | null;
  startColumn?: number | null;
  endColumn?: number | null;
  signature?: string | null;
  rawCode?: string | null;
  summary?: string | null;
  level?: number;
  metadata?: Record<string, unknown>;

  // CLI Additive Fields
  displayId?: string; // Legacy coordinate id (e.g. src_file_ts_fn_L13_C1)
  sourceHash?: string | null; // sha256 of symbol code or file content
  sccId?: number | null; // Tarjan component ID
  summaryStatus?: SummaryStatus;
  summaryInputHash?: string | null;
  summaryContentHash?: string | null;
}

export interface EdgeRecord {
  id?: number;
  repoId: string;
  sourceId: string;
  targetId: string;
  relation: 'calls' | 'imports' | 'contains' | 'references';
  confidence?: 'EXTRACTED' | 'INFERRED';
  metadata?: Record<string, unknown>;
}

export interface UnresolvedRefRecord {
  id?: number;
  repoId: string;
  sourceId: string;
  targetName: string;
  relation: string;
  confidence?: 'INFERRED' | 'EXTRACTED';
  line?: number | null;
}

export interface GitOwnershipRecord {
  id?: number;
  repoId: string;
  nodeId: string;
  authorName: string;
  authorEmail: string;
  linesAuthored: number;
  ownershipPercentage: number;
  lastCommitDate?: string | null;
  totalCommits?: number;
}

export interface BlastRadiusItem {
  id: string;
  name: string;
  filePath: string;
  nodeType: string;
  summary?: string | null;
  depth: number;
  viaCycle?: boolean;
}

export interface EdgeHop {
  id: string;
  name: string;
  filePath: string;
  nodeType: string;
  relation: string;
  confidence: string;
  line?: number;
}

export interface FtsSearchResult {
  nodeId: string;
  name: string;
  filePath: string;
  nodeType: string;
  signature?: string | null;
  summary?: string | null;
  rank?: number;
}

export interface GraphStore {
  init(): Promise<void>;
  close(): Promise<void>;

  // Repositories
  saveRepository(repo: RepoRecord): Promise<void>;
  getRepository(repoId: string): Promise<RepoRecord | null>;

  // Nodes & Edges (Cascade-safe)
  upsertNodes(nodes: NodeRecord[]): Promise<void>;
  deleteNodes(nodeIds: string[]): Promise<void>;
  upsertEdges(edges: EdgeRecord[]): Promise<void>;
  deleteOutgoingEdges(sourceIds: string[]): Promise<void>;
  
  // Unresolved references
  saveUnresolvedRefs(refs: UnresolvedRefRecord[]): Promise<void>;
  getUnresolvedRefs(repoId: string): Promise<UnresolvedRefRecord[]>;
  deleteUnresolvedRefsForSources(sourceIds: string[]): Promise<void>;

  // Ownership
  saveOwnership(ownership: GitOwnershipRecord[]): Promise<void>;
  getOwnership(nodeId: string): Promise<GitOwnershipRecord[]>;

  // Traversal & Search Queries
  getNode(idOrName: string): Promise<NodeRecord | null>;
  getNodesByFilePath(filePath: string): Promise<NodeRecord[]>;
  getAllNodes(repoId: string, nodeType?: string): Promise<NodeRecord[]>;
  searchNodesFts(query: string, limit?: number): Promise<FtsSearchResult[]>;
  getCallers(nodeId: string, depth?: number, includeInferred?: boolean): Promise<EdgeHop[]>;
  getDependencies(nodeId: string, depth?: number, includeInferred?: boolean): Promise<EdgeHop[]>;
  getBlastRadius(nodeId: string, maxDepth?: number, includeInferred?: boolean): Promise<BlastRadiusItem[]>;

  // Freshness & Hashes
  updateSummaryStatus(nodeId: string, status: SummaryStatus, hashes?: { inputHash?: string; contentHash?: string; summary?: string }): Promise<void>;
  markCallersPossiblyStale(nodeId: string): Promise<void>;

  // Meta & Diagnostics
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}
