/**
 * Core Domain Types for OSS Analyser
 */

// -----------------------------------------------------------------------------
// AST & Graph Types
// -----------------------------------------------------------------------------

export interface RawGraphNode {
  id: string;
  label: string;
  file_type?: string;
  source_file: string;
  source_location?: string;
  _callable?: boolean;
  _callable_class?: boolean;
  _origin?: string;
  [key: string]: unknown;
}

export interface RawGraphEdge {
  source: string;
  target: string;
  relation: string;
  context?: string;
  confidence?: string;
  confidence_score?: number;
  source_file?: string;
  source_location?: string;
  weight?: number;
  [key: string]: unknown;
}

export interface RawGraphifyOutput {
  nodes: RawGraphNode[];
  edges: RawGraphEdge[];
  hyperedges?: unknown[];
}

export interface CodeNode {
  id: string;
  label: string;
  file_type: string;
  source_file: string;
  source_location?: string;
  start_line?: number;
  end_line?: number;
  start_column?: number;
  end_column?: number;
  is_callable: boolean;
  is_class: boolean;
  raw_code?: string;
  signature?: string;
  estimated_tokens: number;
  dependencies: string[];
  callers: string[];
}

// -----------------------------------------------------------------------------
// Tarjan SCC & Topo Sorting
// -----------------------------------------------------------------------------

export interface SCCComponent {
  id: string;
  nodeIds: string[];
  nodes: CodeNode[];
  isCyclic: boolean;
  totalTokens: number;
  dependencies: Set<string>;
  dependents: Set<string>;
}

export interface CondensedDAG {
  components: Map<string, SCCComponent>;
  nodeToComponent: Map<string, string>;
  adjacencyList: Map<string, Set<string>>;
  reverseAdjacencyList: Map<string, Set<string>>;
}

export interface TopoLevel {
  level: number;
  components: SCCComponent[];
}

export interface ParseGraphOptions {
  graphJsonPath: string;
  repoRootPath?: string;
  filterCallablesOnly?: boolean;
}

export interface ChunkerOptions {
  maxTokensPerBatch?: number;
  maxItemsPerBatch?: number;
}

export interface LLMPromptItem {
  nodeId: string;
  label: string;
  sourceFile: string;
  rawCode: string;
  signature?: string;
  estimatedTokens: number;
  isCyclicGroupMember: boolean;
  cycleGroupIds?: string[];
  dependencySummaries?: Record<string, string>;
}

export interface LLMChunkBatch {
  batchId: string;
  level: number;
  totalTokens: number;
  items: LLMPromptItem[];
  sccComponentIds: string[];
  hasCyclicGroup: boolean;
}

export interface AnalyzerPipelineResult {
  totalNodes: number;
  totalEdges: number;
  sccCount: number;
  cyclicSCCs: Array<{
    id: string;
    nodeCount: number;
    nodeIds: string[];
    labels: string[];
    totalTokens: number;
  }>;
  topoLevels: Array<{
    level: number;
    componentCount: number;
    nodeCount: number;
    components: Array<{
      id: string;
      isCyclic: boolean;
      nodeIds: string[];
      labels: string[];
      dependencies: string[];
    }>;
  }>;
  batches: LLMChunkBatch[];
  rawNodes: Map<string, CodeNode>;
  dag: CondensedDAG;
}

// -----------------------------------------------------------------------------
// Summarization Types
// -----------------------------------------------------------------------------

export interface FunctionSummary {
  nodeId: string;
  label: string;
  sourceFile: string;
  summary: string;
  inputs?: string;
  outputs?: string;
  sideEffects?: string;
  level: number;
  isCycleMember: boolean;
}

export interface FileSummary {
  filePath: string;
  summary: string;
  purpose: string;
  exportedSymbols: string[];
  functionCount: number;
  functionSummaries: Record<string, string>;
}

export interface DirectorySummary {
  dirPath: string;
  summary: string;
  responsibility: string;
  files: string[];
}

export interface RepoSummary {
  name: string;
  summary: string;
  architecture: string;
  onboardingGuide: string;
  subsystems: Array<{
    name: string;
    description: string;
  }>;
}

export interface CodebaseSummaryResult {
  repoName: string;
  rootPath: string;
  functions: Map<string, FunctionSummary>;
  files: Map<string, FileSummary>;
  directories: Map<string, DirectorySummary>;
  repo: RepoSummary;
  stats: {
    totalFunctions: number;
    totalFiles: number;
    totalDirectories: number;
    llmCallCount: number;
    durationMs: number;
  };
}

// -----------------------------------------------------------------------------
// Git Ownership & Blast Radius
// -----------------------------------------------------------------------------

export interface AuthorOwnership {
  authorName: string;
  authorEmail: string;
  linesAuthored: number;
  ownershipPercentage: number;
  lastCommitDate: string;
  totalCommits: number;
}

export interface BlastRadiusResult {
  id: string;
  name: string;
  filePath: string;
  nodeType: string;
  summary: string;
  depth: number;
}

export interface NodeDetailResponse {
  node: {
    id: string;
    name: string;
    nodeType: string;
    filePath: string;
    startLine?: number;
    endLine?: number;
    startColumn?: number;
    endColumn?: number;
    signature?: string;
    rawCode?: string;
    summary: string;
    level: number;
  };
  ownership: AuthorOwnership[];
  callers: Array<{ id: string; name: string; filePath: string }>;
  callees: Array<{ id: string; name: string; filePath: string }>;
  blastRadius: BlastRadiusResult[];
}

// -----------------------------------------------------------------------------
// BullMQ Ingestion Queue
// -----------------------------------------------------------------------------

export interface RepoIngestionJobData {
  repoId: string;
  repoName: string;
  repoRootPath: string;
  graphJsonPath?: string;
  githubUrl?: string;
  isEphemeralClone?: boolean;
  clientId?: string;
  resumeOnly?: boolean;
  forceRestartSummary?: boolean;
  options?: {
    filterCallablesOnly?: boolean;
    maxTokensPerBatch?: number;
    mockMode?: boolean;
  };
}

export interface JobProgress {
  stage:
    | "queued"
    | "cloning"
    | "parsing"
    | "summarizing_functions"
    | "summarizing_files"
    | "summarizing_directories"
    | "summarizing_repo"
    | "saving"
    | "completed"
    | "failed";
  percent: number;
  message: string;
  detail?: Record<string, unknown>;
}

export interface RepoIngestionJobResult {
  repoId: string;
  repoName: string;
  status: "completed" | "failed";
  totalNodes: number;
  totalEdges: number;
  topoLevels: number;
  summaryResult: CodebaseSummaryResult;
  durationMs: number;
  completedAt: string;
  error?: string;
}

// -----------------------------------------------------------------------------
// Copilot Q&A
// -----------------------------------------------------------------------------

export interface CopilotChatResponse {
  answer: string;
  referencedNodes: Array<{
    id: string;
    name: string;
    filePath: string;
    summary: string;
  }>;
  blastRadius?: Array<{
    id: string;
    name: string;
    filePath: string;
    depth: number;
  }>;
}

// -----------------------------------------------------------------------------
// Authentication & API Keys
// -----------------------------------------------------------------------------

export interface AuthUser {
  id: string;
  email?: string;
  role?: string;
  metadata?: Record<string, unknown>;
}

export interface ApiKeyRecord {
  id: string;
  keyPrefix: string;
  userId: string;
  userEmail?: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
}

export interface AuthSession {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  user: AuthUser;
}
