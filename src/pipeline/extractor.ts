/**
 * Pluggable Extractor Interface conforming to Section 4.1 of the spec.
 */

export interface ExtractedSymbol {
  id: string; // 12-char SHA-1 stable hash
  displayId: string; // Legacy coordinate id (e.g. src_file_ts_fn_L13_C1)
  name: string;
  qualifiedName: string;
  nodeType: "function" | "method" | "class";
  filePath: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
  signature: string;
  docComment?: string;
  exported: boolean;
  sourceHash: string; // sha256 of symbol code
  rawCode?: string;
}

export interface ExtractedEdge {
  sourceId: string;
  targetName: string;
  relation: "calls" | "imports" | "contains" | "references";
  confidence: "EXTRACTED" | "INFERRED";
  line?: number;
}

export interface ExtractionResult {
  symbols: ExtractedSymbol[];
  edges: ExtractedEdge[];
}

export interface ExtractorContext {
  repoRoot: string;
}

export interface Extractor {
  name: "native" | "graphify";
  version(): Promise<string>;
  supports(language: string): boolean;
  extract(files: string[], ctx: ExtractorContext): Promise<ExtractionResult>;
}
