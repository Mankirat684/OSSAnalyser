import * as fs from "node:fs";
import * as path from "node:path";
import type {
  RawGraphifyOutput,
  RawGraphEdge,
  CodeNode,
  ParseGraphOptions
} from "../../core/types.js";

/**
 * Parses line and column location string like "L8:C1", "L8:C1-L15:C4", "L8-L15", or "L8" into numbers.
 */
export function parseLocation(loc?: string, nodeId?: string): {
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
} {
  let startLine: number | undefined;
  let endLine: number | undefined;
  let startColumn: number | undefined;
  let endColumn: number | undefined;

  if (loc) {
    const matchWithCol = loc.match(/L(\d+)(?::C(\d+))?(?:-L?(\d+)(?::C(\d+))?)?/i);
    if (matchWithCol) {
      startLine = parseInt(matchWithCol[1], 10);
      if (matchWithCol[2]) startColumn = parseInt(matchWithCol[2], 10);
      if (matchWithCol[3]) endLine = parseInt(matchWithCol[3], 10);
      if (matchWithCol[4]) endColumn = parseInt(matchWithCol[4], 10);
    }
  }

  // Fallback to nodeId if startLine or startColumn missing: e.g. ..._L13_C1
  if ((!startLine || !startColumn) && nodeId) {
    const idMatch = nodeId.match(/_L(\d+)_C(\d+)$/i);
    if (idMatch) {
      if (!startLine) startLine = parseInt(idMatch[1], 10);
      if (!startColumn) startColumn = parseInt(idMatch[2], 10);
    }
  }

  return { startLine, endLine, startColumn, endColumn };
}

/**
 * Estimates token count from code/text (~4 characters per token).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Extracts the function or code block from a file given the start line.
 */
export function extractCodeSnippet(
  fileContent: string,
  startLine?: number,
  endLine?: number
): string {
  if (!startLine || startLine < 1) return fileContent;

  const lines = fileContent.split(/\r?\n/);
  const startIndex = startLine - 1;
  if (startIndex >= lines.length) return "";

  if (endLine && endLine >= startLine) {
    return lines.slice(startIndex, endLine).join("\n");
  }

  let openBraces = 0;
  let foundFirstBrace = false;
  const collected: string[] = [];

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    collected.push(line);

    for (const char of line) {
      if (char === "{") {
        openBraces++;
        foundFirstBrace = true;
      } else if (char === "}") {
        openBraces--;
      }
    }

    if (foundFirstBrace && openBraces <= 0) {
      break;
    }

    if (collected.length > 150) break;
  }

  return collected.join("\n");
}

/**
 * Loads graph.json and builds CodeNode mapping and call/dependency edges.
 */
export function loadAndParseGraph(options: ParseGraphOptions): {
  nodes: Map<string, CodeNode>;
  edges: RawGraphEdge[];
} {
  const { graphJsonPath, repoRootPath, filterCallablesOnly = true } = options;
  const rawContent = fs.readFileSync(graphJsonPath, "utf-8");
  const rawGraph: RawGraphifyOutput = JSON.parse(rawContent);

  const fileCache = new Map<string, string>();
  const nodes = new Map<string, CodeNode>();

  const baseDir = repoRootPath || path.dirname(path.dirname(graphJsonPath));

  for (const rawNode of rawGraph.nodes) {
    const isCallable = Boolean(rawNode._callable);
    const isClass = Boolean(rawNode._callable_class);

    if (filterCallablesOnly && !isCallable) {
      continue;
    }

    const { startLine, endLine, startColumn, endColumn } = parseLocation(
      rawNode.source_location,
      rawNode.id
    );

    let rawCode = "";
    if (rawNode.source_file && baseDir) {
      const fullPath = path.resolve(baseDir, rawNode.source_file);
      if (fs.existsSync(fullPath)) {
        if (!fileCache.has(fullPath)) {
          fileCache.set(fullPath, fs.readFileSync(fullPath, "utf-8"));
        }
        const fileContent = fileCache.get(fullPath)!;
        rawCode = extractCodeSnippet(fileContent, startLine, endLine);
      }
    }

    const codeNode: CodeNode = {
      id: rawNode.id,
      label: rawNode.label,
      file_type: rawNode.file_type || "code",
      source_file: rawNode.source_file,
      source_location: rawNode.source_location,
      start_line: startLine,
      end_line: endLine,
      start_column: startColumn,
      end_column: endColumn,
      is_callable: isCallable,
      is_class: isClass,
      raw_code: rawCode,
      estimated_tokens: estimateTokens(rawCode || rawNode.label),
      dependencies: [],
      callers: []
    };

    nodes.set(codeNode.id, codeNode);
  }

  const validEdges: RawGraphEdge[] = [];

  for (const edge of rawGraph.edges) {
    const sourceNode = nodes.get(edge.source);
    const targetNode = nodes.get(edge.target);

    if (filterCallablesOnly && (!sourceNode || !targetNode)) {
      continue;
    }

    if (edge.relation === "calls" || edge.relation === "references") {
      validEdges.push(edge);

      if (sourceNode && targetNode) {
        if (!sourceNode.dependencies.includes(targetNode.id)) {
          sourceNode.dependencies.push(targetNode.id);
        }
        if (!targetNode.callers.includes(sourceNode.id)) {
          targetNode.callers.push(sourceNode.id);
        }
      }
    }
  }

  return { nodes, edges: validEdges };
}
