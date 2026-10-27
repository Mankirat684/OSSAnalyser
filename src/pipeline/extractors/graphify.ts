import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import type {
  Extractor,
  ExtractionResult,
  ExtractedSymbol,
  ExtractedEdge,
  ExtractorContext
} from "../extractor.js";
import { NodeIdGenerator, makeCoordinateDisplayId, normalizeRelPath } from "../idGenerator.js";

interface GraphifyRawNode {
  id: string;
  label: string;
  file_type?: string;
  source_file?: string;
  source_location?: string;
  _callable?: boolean;
  _callable_class?: boolean;
  _origin?: string;
  metadata?: {
    unresolved_calls?: Array<{
      callee: string;
      receiver_type?: string;
      line?: string;
      file?: string;
    }>;
    doc_comment?: string;
  };
}

interface GraphifyRawLink {
  source: string;
  target: string;
  relation: string;
  context?: string;
  confidence?: "EXTRACTED" | "INFERRED";
  source_file?: string;
  source_location?: string;
  weight?: number;
}

interface GraphifyRawGraph {
  nodes: GraphifyRawNode[];
  links: GraphifyRawLink[];
}

export class GraphifyExtractor implements Extractor {
  public name: "graphify" = "graphify";

  public async version(): Promise<string> {
    try {
      const out = execSync("graphify --version", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
      return out.trim();
    } catch {
      return "0.9.95-graphifyy";
    }
  }

  public supports(languageOrExt: string): boolean {
    const ext = languageOrExt.startsWith(".") ? languageOrExt.toLowerCase() : `.${languageOrExt.toLowerCase()}`;
    const supported = [
      ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
      ".py", ".go", ".rs", ".java", ".c", ".cpp", ".cc", ".h", ".hpp",
      ".cs", ".rb", ".php", ".swift", ".kt", ".scala", ".zig"
    ];
    return supported.includes(ext);
  }

  public async extract(files: string[], ctx: ExtractorContext): Promise<ExtractionResult> {
    const symbols: ExtractedSymbol[] = [];
    const edges: ExtractedEdge[] = [];
    const idGen = new NodeIdGenerator();

    const targetDir = ctx.repoRoot;
    const outDir = path.join(targetDir, "graphify-out");
    const graphJsonPath = path.join(outDir, "graph.json");

    try {
      // Execute graphify CLI against target directory
      execSync(`graphify update "${targetDir}" --no-cluster --force`, {
        cwd: ctx.repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120000
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Graphify extraction failed to run: ${errMsg}. Ensure 'graphify' is installed via 'pip install graphifyy'.`);
    }

    if (!fs.existsSync(graphJsonPath)) {
      throw new Error(`Graphify did not generate expected output at ${graphJsonPath}`);
    }

    const rawData = JSON.parse(fs.readFileSync(graphJsonPath, "utf-8")) as GraphifyRawGraph;

    // Filter to requested files if file list was specified
    const targetFileSet = new Set(files.map((f) => normalizeRelPath(path.isAbsolute(f) ? path.relative(ctx.repoRoot, f) : f)));

    // Index all raw nodes by ID for fast lookup
    const rawNodeById = new Map<string, GraphifyRawNode>();
    for (const rawNode of rawData.nodes || []) {
      rawNodeById.set(rawNode.id, rawNode);
    }

    // Map graphify node IDs to ExtractedSymbol records
    const nodeToSymbolMap = new Map<string, ExtractedSymbol>();

    for (const rawNode of rawData.nodes || []) {
      const relPath = normalizeRelPath(rawNode.source_file || "");
      if (!relPath) continue;

      const ext = path.extname(relPath).toLowerCase();
      const isCodeFile = [
        ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
        ".py", ".go", ".rs", ".java", ".c", ".cpp", ".cc", ".h", ".hpp",
        ".cs", ".rb", ".php", ".swift", ".kt", ".scala", ".zig"
      ].includes(ext);

      if (!isCodeFile) continue;

      const cleanLabel = rawNode.label.trim();
      const baseName = path.basename(relPath);
      const isFileNode = cleanLabel === baseName || /\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|h|cs|rb|php|json|yml|yaml|md)$/i.test(cleanLabel);
      const isImportRef = cleanLabel.startsWith("./") || cleanLabel.startsWith("../") || cleanLabel.includes("/");

      if (isFileNode || isImportRef) continue;

      const isCallable = Boolean(rawNode._callable || rawNode._callable_class);
      const isCodeItem = rawNode.file_type === "code";

      if (!isCallable && !isCodeItem) continue;

      if (targetFileSet.size > 0 && !targetFileSet.has(relPath)) {
        continue;
      }

      // Clean symbol name (e.g., 'runDoctorCommand()' -> 'runDoctorCommand')
      const cleanName = cleanLabel.replace(/\(\)$/, "").trim();
      if (!cleanName || cleanName.length < 2) continue;

      const nodeType: "function" | "method" | "class" = rawNode._callable_class ? "class" : "function";

      let startLine = 1;
      if (rawNode.source_location && rawNode.source_location.startsWith("L")) {
        const parsed = parseInt(rawNode.source_location.slice(1), 10);
        if (!isNaN(parsed)) startLine = parsed;
      }
      let endLine = startLine + 10;

      // Read file slice if available to compute real source hash and block span
      const fullPath = path.resolve(ctx.repoRoot, relPath);
      let sourceHash = crypto.createHash("sha256").update(cleanName).digest("hex");
      let rawCode = "";

      if (fs.existsSync(fullPath)) {
        try {
          const fileLines = fs.readFileSync(fullPath, "utf-8").split(/\r?\n/);
          let braceDepth = 0;
          let foundStart = false;
          let spanEnd = Math.min(fileLines.length, startLine + 15);
          for (let i = startLine - 1; i < fileLines.length; i++) {
            const l = fileLines[i];
            for (const ch of l) {
              if (ch === "{") {
                braceDepth++;
                foundStart = true;
              } else if (ch === "}") {
                braceDepth--;
                if (foundStart && braceDepth === 0) {
                  spanEnd = i + 1;
                  break;
                }
              }
            }
            if (foundStart && braceDepth === 0) break;
          }
          endLine = Math.max(startLine, spanEnd);
          rawCode = fileLines.slice(startLine - 1, endLine).join("\n");
          sourceHash = crypto.createHash("sha256").update(rawCode || cleanName).digest("hex");
        } catch {
          // fallback to name hash
        }
      }

      const id = idGen.makeNodeId(relPath, cleanName, nodeType);
      const displayId = makeCoordinateDisplayId(relPath, cleanName, startLine);

      const symbol: ExtractedSymbol = {
        id,
        displayId,
        name: cleanName,
        qualifiedName: `${relPath}::${cleanName}`,
        nodeType,
        filePath: relPath,
        startLine,
        endLine,
        signature: `${cleanName}()`,
        docComment: rawNode.metadata?.doc_comment,
        exported: true,
        sourceHash,
        rawCode
      };

      symbols.push(symbol);
      nodeToSymbolMap.set(rawNode.id, symbol);

      // Ingest calls from rawCode if available
      if (rawCode) {
        const callMatches = rawCode.matchAll(/(?:([a-zA-Z0-9_]+)\.)?([a-zA-Z0-9_]{2,})\s*\(/g);
        for (const match of callMatches) {
          const callee = match[2];
          if (["if", "for", "while", "switch", "catch", "require", "import", "return", "describe", "it", "expect", "test"].includes(callee)) {
            continue;
          }
          edges.push({
            sourceId: symbol.id,
            targetName: callee,
            relation: "calls",
            confidence: "EXTRACTED",
            line: startLine
          });
        }
      }

      // Ingest unresolved calls detected by Graphify
      if (rawNode.metadata?.unresolved_calls) {
        for (const unres of rawNode.metadata.unresolved_calls) {
          let callLine: number | undefined;
          if (unres.line && unres.line.startsWith("L")) {
            const parsed = parseInt(unres.line.slice(1), 10);
            if (!isNaN(parsed)) callLine = parsed;
          }
          edges.push({
            sourceId: symbol.id,
            targetName: unres.callee,
            relation: "calls",
            confidence: "INFERRED",
            line: callLine
          });
        }
      }
    }

    // Process explicit links
    for (const link of rawData.links || []) {
      const sourceSymbol = nodeToSymbolMap.get(link.source);
      if (!sourceSymbol) continue;

      let callLine: number | undefined;
      if (link.source_location && link.source_location.startsWith("L")) {
        const parsed = parseInt(link.source_location.slice(1), 10);
        if (!isNaN(parsed)) callLine = parsed;
      }

      const targetSymbol = nodeToSymbolMap.get(link.target);
      let targetName = targetSymbol ? targetSymbol.name : "";
      if (!targetName) {
        const targetRaw = rawNodeById.get(link.target);
        if (targetRaw) {
          targetName = targetRaw.label.replace(/\(\)$/, "").trim();
        } else {
          targetName = link.target.replace(/.*\./, "").replace(/\(\)$/, "").trim();
        }
      }
      if (!targetName) continue;

      let relation: "calls" | "imports" | "contains" | "references" = "calls";
      if (link.relation === "contains") relation = "contains";
      else if (link.relation === "imports" || link.relation === "imports_from") relation = "imports";
      else if (link.relation === "references") relation = "references";

      edges.push({
        sourceId: sourceSymbol.id,
        targetName,
        relation,
        confidence: link.confidence || "EXTRACTED",
        line: callLine
      });
    }

    return { symbols, edges };
  }
}
