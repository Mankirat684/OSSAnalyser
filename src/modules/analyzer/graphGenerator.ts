import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { RawGraphifyOutput, RawGraphNode, RawGraphEdge } from "../../core/types.js";

/**
 * Ensures a valid graph.json exists for a repository.
 * 1. Checks if graphify-out/graph.json already exists.
 * 2. Attempts to run Graphify via uv/python if available.
 * 3. Falls back to built-in AST scanner to extract functions, classes, and call/import edges.
 */
export function ensureGraphJson(repoRootPath: string, customGraphPath?: string): string {
  // 1. Check custom path if provided
  if (customGraphPath && fs.existsSync(customGraphPath)) {
    return customGraphPath;
  }

  // 2. Check standard graphify-out/graph.json
  const standardPath = path.resolve(repoRootPath, "graphify-out/graph.json");
  if (fs.existsSync(standardPath)) {
    return standardPath;
  }

  // 3. Attempt running graphify via CLI or uv
  console.log(`[GraphGenerator] graph.json not found in ${repoRootPath}. Attempting Graphify extraction...`);
  try {
    execSync("graphify extract . --code-only --no-cluster", {
      cwd: repoRootPath,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180000
    });
    if (fs.existsSync(standardPath)) {
      console.log(`[GraphGenerator] ✓ Successfully extracted graph.json using Graphify.`);
      return standardPath;
    }
  } catch {
    try {
      execSync("uv tool run --from graphifyy graphify extract . --code-only --no-cluster", {
        cwd: repoRootPath,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 180000
      });
      if (fs.existsSync(standardPath)) {
        console.log(`[GraphGenerator] ✓ Successfully extracted graph.json using Graphify (uv).`);
        return standardPath;
      }
    } catch {
      // uv/graphify not available or failed; continue to fallback
    }
  }

  // 4. Built-in AST Scanner Fallback
  console.log(`[GraphGenerator] Generating AST code graph via built-in scanner...`);
  const generatedGraph = scanRepositoryAST(repoRootPath);

  const outDir = path.resolve(repoRootPath, "graphify-out");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  fs.writeFileSync(standardPath, JSON.stringify(generatedGraph, null, 2), "utf-8");
  console.log(`[GraphGenerator] ✓ Built-in scanner generated ${generatedGraph.nodes.length} nodes and ${generatedGraph.edges.length} edges.`);
  return standardPath;
}

/**
 * Lightweight built-in AST code scanner for JS/TS/Py files.
 */
function scanRepositoryAST(repoRootPath: string): RawGraphifyOutput {
  const nodes: RawGraphNode[] = [];
  const edges: RawGraphEdge[] = [];
  const filePaths: string[] = [];

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|js|tsx|jsx|py)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        filePaths.push(full);
      }
    }
  }

  walk(repoRootPath);

  const functionMap = new Map<string, string>(); // functionName -> nodeId

  for (const file of filePaths) {
    const relFile = path.relative(repoRootPath, file).replace(/\\/g, "/");
    const content = fs.readFileSync(file, "utf-8");
    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Match JS/TS functions & methods
      const fnMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_]+)\s*\(/) ||
                      line.match(/(?:public|private|protected|static|\s)*([a-zA-Z0-9_]+)\s*\([^)]*\)\s*[:{]/) ||
                      line.match(/(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/);

      // Match Classes
      const classMatch = line.match(/(?:export\s+)?class\s+([a-zA-Z0-9_]+)/);

      if (classMatch) {
        const className = classMatch[1];
        const startCol = (classMatch.index !== undefined ? classMatch.index : 0) + 1;
        const nodeId = `${relFile.replace(/[^a-zA-Z0-9_]/g, "_")}_class_${className}_L${lineNum}_C${startCol}`;
        nodes.push({
          id: nodeId,
          label: className,
          file_type: "code",
          source_file: relFile,
          source_location: `L${lineNum}:C${startCol}`,
          _callable: true,
          _callable_class: true
        });
        functionMap.set(className, nodeId);
      } else if (fnMatch && !line.includes("if ") && !line.includes("while ") && !line.includes("switch ")) {
        const fnName = fnMatch[1];
        if (fnName && fnName !== "constructor" && fnName !== "function" && fnName.length > 1) {
          const startCol = (fnMatch.index !== undefined ? fnMatch.index : 0) + 1;
          const nodeId = `${relFile.replace(/[^a-zA-Z0-9_]/g, "_")}_${fnName}_L${lineNum}_C${startCol}`;
          nodes.push({
            id: nodeId,
            label: fnName,
            file_type: "code",
            source_file: relFile,
            source_location: `L${lineNum}:C${startCol}`,
            _callable: true,
            _callable_class: false
          });
          functionMap.set(fnName, nodeId);
        }
      }
    }
  }

  // Detect call references
  for (const file of filePaths) {
    const relFile = path.relative(repoRootPath, file).replace(/\\/g, "/");
    const content = fs.readFileSync(file, "utf-8");

    for (const [targetName, targetNodeId] of functionMap.entries()) {
      if (content.includes(`${targetName}(`) || content.includes(`.${targetName}(`)) {
        // Find callers in the current file
        const fileNode = nodes.find((n) => n.source_file === relFile && n.id !== targetNodeId);
        if (fileNode) {
          edges.push({
            source: fileNode.id,
            target: targetNodeId,
            relation: "calls",
            confidence: "EXTRACTED"
          });
        }
      }
    }
  }

  return { nodes, edges };
}
